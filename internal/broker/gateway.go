package broker

import (
	"context"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
)

type Health struct {
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	LatencyMS int64     `json:"latency_ms"`
	Message   string    `json:"message,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
}

type AccountSnapshot struct {
	AccountID   string `json:"account_id"`
	CashCents   int64  `json:"cash_cents"`
	EquityCents int64  `json:"equity_cents"`
	Currency    string `json:"currency"`
}

type PositionSnapshot struct {
	AccountID         string `json:"account_id"`
	Symbol            string `json:"symbol"`
	Quantity          int64  `json:"quantity"`
	AvailableQuantity int64  `json:"available_quantity"`
	AvgCostCents      int64  `json:"avg_cost_cents"`
	MarketPriceCents  int64  `json:"market_price_cents"`
}

type OrderRequest struct {
	ClientOrderID string           `json:"client_order_id"`
	AccountID     string           `json:"account_id"`
	Symbol        string           `json:"symbol"`
	Side          domain.Side      `json:"side"`
	OrderType     domain.OrderType `json:"order_type"`
	Quantity      int64            `json:"quantity"`
	PriceCents    int64            `json:"price_cents"`
}

type OrderAck struct {
	ClientOrderID string `json:"client_order_id"`
	BrokerOrderID string `json:"broker_order_id"`
	Accepted      bool   `json:"accepted"`
	Message       string `json:"message,omitempty"`
}

type Gateway interface {
	Name() string
	Health(ctx context.Context) Health
	SubmitOrder(ctx context.Context, request OrderRequest) (OrderAck, error)
	CancelOrder(ctx context.Context, clientOrderID string) error
	QueryAccount(ctx context.Context, accountID string) (AccountSnapshot, error)
	QueryPositions(ctx context.Context, accountID string) ([]PositionSnapshot, error)
}
