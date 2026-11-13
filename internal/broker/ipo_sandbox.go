package broker

import (
	"context"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/id"
	"github.com/qtrade/qtrade/internal/store"
)

// SandboxIPO runs the full subscription lifecycle locally: it reads the demo
// offering calendar and the account's positions, derives the holding quota and
// accepts a subscription whose quantity fits. It never reaches a broker, so it
// is safe to use for end-to-end console demos.
type SandboxIPO struct {
	store store.Store
}

func NewSandboxIPO(st store.Store) *SandboxIPO { return &SandboxIPO{store: st} }

func (s *SandboxIPO) Name() string { return "sandbox" }

func (s *SandboxIPO) Health(context.Context) Health {
	return Health{
		Name:      "sandbox",
		Status:    "ok",
		Message:   "本地沙箱：模拟额度校验、申购受理与摇号，不连接券商",
		CheckedAt: time.Now().UTC(),
	}
}

func (s *SandboxIPO) ListOffers(ctx context.Context) ([]domain.IPOOffer, error) {
	return s.store.ListIPOOffers(ctx)
}

func (s *SandboxIPO) Limits(ctx context.Context, accountID string) ([]domain.IPOLimit, error) {
	marketValues := map[string]int64{}
	if accountID != "" {
		positions, err := s.store.ListPositions(ctx, accountID)
		if err != nil {
			return nil, err
		}
		for _, position := range positions {
			market := MarketOfSymbol(position.Symbol)
			if market == "" {
				continue
			}
			marketValues[market] += position.Quantity * position.MarketPriceCents
		}
	}
	limits := []domain.IPOLimit{
		{
			Market:           "SH",
			Label:            "沪市新股额度",
			MarketValueCents: marketValues["SH"],
			QuotaQuantity:    QuotaFromMarketValue("SH", marketValues["SH"]),
			Enabled:          QuotaFromMarketValue("SH", marketValues["SH"]) > 0,
			Note:             "T-2 前 20 个交易日日均市值，每 1 万元配 1,000 股",
		},
		{
			Market:           "SZ",
			Label:            "深市新股额度",
			MarketValueCents: marketValues["SZ"],
			QuotaQuantity:    QuotaFromMarketValue("SZ", marketValues["SZ"]),
			Enabled:          QuotaFromMarketValue("SZ", marketValues["SZ"]) > 0,
			Note:             "T-2 前 20 个交易日日均市值，每 1 万元配 500 股",
		},
		{
			Market:        "BOND",
			Label:         "新债额度",
			QuotaQuantity: 1_000_000,
			Enabled:       true,
			Note:          "可转债申购无需市值，单账户上限 100 万张，需签署风险揭示书",
		},
	}
	return limits, nil
}

func (s *SandboxIPO) Subscribe(ctx context.Context, request IPORequest) (IPOAck, error) {
	offer, err := s.store.GetIPOOffer(ctx, request.OfferID)
	if err != nil {
		return IPOAck{}, err
	}
	if offer.Status != "open" {
		return IPOAck{}, fmt.Errorf("%w: %s 当前状态为 %s，不在申购窗口", ErrIPOUnavailable, offer.Name, offer.Status)
	}
	lot := SubscriptionLot(offer.Market, offer.Type, offer.Board)
	if request.Quantity <= 0 || request.Quantity%lot != 0 {
		return IPOAck{}, fmt.Errorf("%w: 申购数量必须是 %d 的整数倍", ErrIPOUnavailable, lot)
	}
	if request.Quantity < offer.MinQuantity {
		return IPOAck{}, fmt.Errorf("%w: 最少申购 %d", ErrIPOUnavailable, offer.MinQuantity)
	}
	ceiling := offer.MaxQuantity
	if offer.RequiresMarketValue {
		limits, err := s.Limits(ctx, request.AccountID)
		if err != nil {
			return IPOAck{}, err
		}
		quota := int64(0)
		for _, limit := range limits {
			if limit.Market == offer.Market {
				quota = limit.QuotaQuantity
			}
		}
		if quota <= 0 {
			return IPOAck{}, fmt.Errorf("%w: 账户没有 %s 市场市值，无法申购新股", ErrIPOUnavailable, offer.Market)
		}
		if quota < ceiling || ceiling <= 0 {
			ceiling = quota
		}
	}
	if request.Quantity > ceiling {
		return IPOAck{}, fmt.Errorf("%w: 超过可申购上限 %d", ErrIPOUnavailable, ceiling)
	}
	return IPOAck{
		ClientRequestID: request.ClientRequestID,
		BrokerRequestID: id.New("sbxipo"),
		Accepted:        true,
		PriceCents:      offer.IssuePriceCents,
		Message:         "沙箱已受理，T+1 摇号，T+2 公布中签结果",
	}, nil
}

// Settle draws the lottery deterministically from the subscription id so that
// repeated refreshes and restarts never change an already published result.
func (s *SandboxIPO) Settle(_ context.Context, subscription domain.IPOSubscription) (IPOAllotment, error) {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(subscription.ID))
	roll := hash.Sum64() % 100
	winRate := uint64(30)
	if subscription.Type == domain.IPOBond {
		winRate = 60
	}
	market, board := "", ""
	if offer, err := s.store.GetIPOOffer(context.Background(), subscription.OfferID); err == nil {
		market, board = offer.Market, offer.Board
	}
	if roll >= winRate {
		return IPOAllotment{
			Status:  domain.IPOLost,
			Message: "未中签，冻结资金已解冻",
		}, nil
	}
	allotted := SubscriptionLot(market, subscription.Type, board)
	if allotted > subscription.Quantity {
		allotted = subscription.Quantity
	}
	return IPOAllotment{
		Status:           domain.IPOWon,
		AllottedQuantity: allotted,
		Message:          fmt.Sprintf("中签 %d，请在 T+2 日 16:00 前保证资金充足", allotted),
	}, nil
}
