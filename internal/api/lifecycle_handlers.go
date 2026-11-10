package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
)

func (s *Server) listStrategyVersions(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListStrategyVersions(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

type updateStrategyStatusRequest struct {
	Status domain.StrategyStatus `json:"status"`
}

func (s *Server) updateStrategyStatus(w http.ResponseWriter, r *http.Request) {
	strategy, err := s.store.GetStrategy(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	var request updateStrategyStatusRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if strings.TrimSpace(string(request.Status)) == "" {
		writeError(w, http.StatusBadRequest, "status_required", "status is required", nil)
		return
	}
	previous := strategy.Status
	if err := strategy.Transition(request.Status); err != nil {
		writeError(w, http.StatusConflict, "invalid_transition", err.Error(), nil)
		return
	}
	if err := s.store.UpdateStrategy(r.Context(), strategy); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "strategy.status_changed", "strategy", strategy.ID, string(previous)+" -> "+string(strategy.Status))
	writeJSON(w, http.StatusOK, strategy)
}

func (s *Server) cancelBacktest(w http.ResponseWriter, r *http.Request) {
	run, err := s.store.GetBacktest(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if run.Status != domain.BacktestQueued && run.Status != domain.BacktestRunning {
		writeError(w, http.StatusConflict, "invalid_transition", "only queued or running backtests can be canceled", nil)
		return
	}
	run.Status = domain.BacktestCanceled
	run.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateBacktest(r.Context(), run); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "backtest.canceled", "backtest", run.ID, run.StrategyID+"@"+run.StrategyVersion)
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) cancelOrder(w http.ResponseWriter, r *http.Request) {
	order, err := s.store.GetOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if order.Status != domain.OrderAccepted && order.Status != domain.OrderPartiallyFilled {
		writeError(w, http.StatusConflict, "invalid_transition", "only accepted or partially filled orders can be canceled", nil)
		return
	}
	order.Status = domain.OrderCanceled
	order.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateOrder(r.Context(), order); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "order.canceled", "order", order.ID, order.ClientOrderID)
	writeJSON(w, http.StatusOK, order)
}
