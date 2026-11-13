package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/qtrade/qtrade/internal/broker"
	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/id"
	"github.com/qtrade/qtrade/internal/store"
)

func (s *Server) writeIPOError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, broker.ErrNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "adapter_not_configured", err.Error(), nil)
	case errors.Is(err, broker.ErrIPOUnavailable):
		writeError(w, http.StatusUnprocessableEntity, "ipo_unavailable", err.Error(), nil)
	case errors.Is(err, store.ErrNotFound):
		mapStoreError(w, err)
	default:
		mapStoreError(w, err)
	}
}

// listIPOOffers returns the offering calendar. When account_id is supplied the
// per-offer quota is filled from that account's holding quota so the console
// can show "可申购上限" without a second round trip.
func (s *Server) listIPOOffers(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	offers, err := s.ipo.ListOffers(r.Context())
	if err != nil {
		s.writeIPOError(w, err)
		return
	}
	if accountID != "" {
		limits, limitErr := s.ipo.Limits(r.Context(), accountID)
		if limitErr != nil {
			s.writeIPOError(w, limitErr)
			return
		}
		quota := map[string]int64{}
		for _, limit := range limits {
			quota[limit.Market] = limit.QuotaQuantity
		}
		for index := range offers {
			ceiling := offers[index].MaxQuantity
			if offers[index].RequiresMarketValue {
				if marketQuota := quota[offers[index].Market]; marketQuota < ceiling || ceiling <= 0 {
					ceiling = marketQuota
				}
			}
			offers[index].QuotaQuantity = ceiling
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": offers, "count": len(offers)})
}

func (s *Server) ipoLimits(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	if accountID == "" {
		writeError(w, http.StatusBadRequest, "account_required", "account_id is required", nil)
		return
	}
	if _, err := s.store.GetAccount(r.Context(), accountID); err != nil {
		mapStoreError(w, err)
		return
	}
	limits, err := s.ipo.Limits(r.Context(), accountID)
	if err != nil {
		s.writeIPOError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": limits, "count": len(limits)})
}

func (s *Server) listIPOSubscriptions(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	items, err := s.store.ListIPOSubscriptions(r.Context(), accountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

type ipoSubscribeRequest struct {
	ClientRequestID string `json:"client_request_id"`
	AccountID       string `json:"account_id"`
	OfferID         string `json:"offer_id"`
	Quantity        int64  `json:"quantity"`
}

func (s *Server) createIPOSubscription(w http.ResponseWriter, r *http.Request) {
	var request ipoSubscribeRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	request.AccountID = strings.TrimSpace(request.AccountID)
	request.OfferID = strings.TrimSpace(request.OfferID)
	if request.AccountID == "" || request.OfferID == "" || request.Quantity <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "account_id, offer_id and a positive quantity are required", nil)
		return
	}
	if _, err := s.store.GetAccount(r.Context(), request.AccountID); err != nil {
		mapStoreError(w, err)
		return
	}
	offer, err := s.store.GetIPOOffer(r.Context(), request.OfferID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	existing, err := s.store.ListIPOSubscriptions(r.Context(), request.AccountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	for _, item := range existing {
		if item.OfferID == request.OfferID && item.Status != domain.IPORejected {
			writeError(w, http.StatusConflict, "already_subscribed", "该标的已完成申购，不能重复提交", nil)
			return
		}
	}
	ack, err := s.ipo.Subscribe(r.Context(), broker.IPORequest{
		ClientRequestID: request.ClientRequestID,
		AccountID:       request.AccountID,
		OfferID:         request.OfferID,
		Quantity:        request.Quantity,
	})
	if err != nil {
		s.writeIPOError(w, err)
		return
	}
	now := time.Now().UTC()
	subscription := domain.IPOSubscription{
		ID:              id.New("ipo"),
		OfferID:         offer.ID,
		Code:            offer.Code,
		Name:            offer.Name,
		Type:            offer.Type,
		AccountID:       request.AccountID,
		Quantity:        request.Quantity,
		PriceCents:      ack.PriceCents,
		AmountCents:     request.Quantity * ack.PriceCents,
		Status:          domain.IPOSubmitted,
		Message:         ack.Message,
		BrokerRequestID: ack.BrokerRequestID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.CreateIPOSubscription(r.Context(), subscription); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "ipo.subscribed", "ipo_subscription", subscription.ID, offer.Code+" "+offer.Name)
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "ipo",
		ResourceType: "ipo_subscription",
		ResourceID:   subscription.ID,
		Message:      "打新申购已受理：" + offer.Name + " " + offer.Code,
	})
	writeJSON(w, http.StatusCreated, subscription)
}

func (s *Server) settleIPOSubscription(w http.ResponseWriter, r *http.Request) {
	subscription, err := s.store.GetIPOSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if subscription.Status != domain.IPOSubmitted {
		writeError(w, http.StatusConflict, "invalid_transition", "只有已申购的记录可以摇号", nil)
		return
	}
	allotment, err := s.ipo.Settle(r.Context(), subscription)
	if err != nil {
		s.writeIPOError(w, err)
		return
	}
	subscription.Status = allotment.Status
	subscription.AllottedQuantity = allotment.AllottedQuantity
	subscription.Message = allotment.Message
	subscription.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateIPOSubscription(r.Context(), subscription); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "ipo.settled", "ipo_subscription", subscription.ID, string(subscription.Status))
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "ipo",
		ResourceType: "ipo_subscription",
		ResourceID:   subscription.ID,
		Message:      "摇号结果：" + subscription.Name + " " + string(subscription.Status),
	})
	writeJSON(w, http.StatusOK, subscription)
}

func (s *Server) payIPOSubscription(w http.ResponseWriter, r *http.Request) {
	subscription, err := s.store.GetIPOSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if subscription.Status != domain.IPOWon {
		writeError(w, http.StatusConflict, "invalid_transition", "只有中签记录需要缴款", nil)
		return
	}
	subscription.Status = domain.IPOPaid
	subscription.Message = "已缴款，等待上市"
	subscription.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateIPOSubscription(r.Context(), subscription); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "ipo.paid", "ipo_subscription", subscription.ID, subscription.Code)
	writeJSON(w, http.StatusOK, subscription)
}

func (s *Server) abandonIPOSubscription(w http.ResponseWriter, r *http.Request) {
	subscription, err := s.store.GetIPOSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if subscription.Status != domain.IPOSubmitted && subscription.Status != domain.IPOWon {
		writeError(w, http.StatusConflict, "invalid_transition", "当前状态不能弃购", nil)
		return
	}
	subscription.Status = domain.IPOAbandoned
	subscription.Message = "已弃购，12 个月内累计 3 次将限制申购新股"
	subscription.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateIPOSubscription(r.Context(), subscription); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "ipo.abandoned", "ipo_subscription", subscription.ID, subscription.Code)
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogWarn,
		Source:       "ipo",
		ResourceType: "ipo_subscription",
		ResourceID:   subscription.ID,
		Message:      "弃购记录：" + subscription.Name + " " + subscription.Code,
	})
	writeJSON(w, http.StatusOK, subscription)
}

func (s *Server) listIPOAdapters(w http.ResponseWriter, r *http.Request) {
	items := make([]broker.AdapterStatus, 0, len(s.channels))
	for _, channel := range s.channels {
		health := channel.Health(r.Context())
		status := broker.AdapterStatus{
			Name:    channel.Name(),
			Mode:    channel.Name(),
			Status:  health.Status,
			Message: health.Message,
		}
		switch channel.Name() {
		case "sandbox":
			status.Display = "本地沙箱"
			status.LiveTrading = false
			status.Requirement = "无需券商接入，本地演示额度校验、申购与摇号"
		case "qmt":
			status.Display = "QMT / miniQMT"
			status.LiveTrading = true
			status.Requirement = "券商开通 QMT 权限 + xtquant sidecar + 资金账号（常见 50 万资产门槛）"
		case "ptrade":
			status.Display = "恒生 Ptrade"
			status.LiveTrading = true
			status.Requirement = "券商开通 Ptrade 权限 + API 凭证，策略运行在券商托管环境"
		default:
			status.Display = channel.Name()
		}
		items = append(items, status)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}
