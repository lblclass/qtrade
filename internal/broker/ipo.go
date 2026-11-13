package broker

import (
	"context"
	"errors"
	"strings"

	"github.com/qtrade/qtrade/internal/domain"
)

// ErrNotConfigured is returned by adapters that need broker-side enablement
// and credentials before they can reach a real trading counter.
var ErrNotConfigured = errors.New("adapter is not configured")

// ErrIPOUnavailable marks a request the broker adapter refused for business
// reasons: offering closed, quota exhausted, bad lot size, and so on.
var ErrIPOUnavailable = errors.New("ipo subscription unavailable")

// IPORequest is one subscription instruction. Unlike OrderRequest there is no
// side or order type: a new-issue subscription is always a fixed-price buy at
// the issuer's price, and the quantity is bounded by the account quota.
type IPORequest struct {
	ClientRequestID string `json:"client_request_id"`
	AccountID       string `json:"account_id"`
	OfferID         string `json:"offer_id"`
	Quantity        int64  `json:"quantity"`
}

type IPOAck struct {
	ClientRequestID string `json:"client_request_id"`
	BrokerRequestID string `json:"broker_request_id"`
	Accepted        bool   `json:"accepted"`
	PriceCents      int64  `json:"price_cents"`
	Message         string `json:"message,omitempty"`
}

// IPOAllotment is the result of the lottery: won with a quantity, or lost.
type IPOAllotment struct {
	Status           domain.IPOSubscriptionStatus
	AllottedQuantity int64
	Message          string
}

// IPOAdapter isolates new-issue subscriptions from the ordinary order gateway.
// Broker channels expose them differently (QMT sends a plain buy on the
// subscription code, Ptrade has a dedicated API), so keeping a separate
// contract avoids pretending 打新 is just another limit order.
type IPOAdapter interface {
	Name() string
	Health(ctx context.Context) Health
	ListOffers(ctx context.Context) ([]domain.IPOOffer, error)
	Limits(ctx context.Context, accountID string) ([]domain.IPOLimit, error)
	Subscribe(ctx context.Context, request IPORequest) (IPOAck, error)
	Settle(ctx context.Context, subscription domain.IPOSubscription) (IPOAllotment, error)
}

// AdapterStatus is what the console shows on the channel card: whether the
// adapter can actually reach a broker today, and what is missing if not.
type AdapterStatus struct {
	Name        string `json:"name"`
	Display     string `json:"display"`
	Mode        string `json:"mode"`
	Status      string `json:"status"`
	LiveTrading bool   `json:"live_trading"`
	Message     string `json:"message"`
	Requirement string `json:"requirement"`
}

// MarketOfSymbol returns SH or SZ from a suffixed symbol such as 600519.SH.
func MarketOfSymbol(symbol string) string {
	upper := strings.ToUpper(strings.TrimSpace(symbol))
	switch {
	case strings.HasSuffix(upper, ".SH"):
		return "SH"
	case strings.HasSuffix(upper, ".SZ"):
		return "SZ"
	case strings.HasSuffix(upper, ".BJ"):
		return "BJ"
	default:
		return ""
	}
}

// QuotaFromMarketValue converts holding market value into subscription shares.
// Shanghai main board grants 1,000 shares per 10,000 CNY of average daily
// market value; Shenzhen (main board and ChiNext) grants 500 shares per 5,000
// CNY. Both ratios are 10 shares per 100 CNY, but the lot granularity differs,
// so each market truncates to its own whole lot.
func QuotaFromMarketValue(market string, marketValueCents int64) int64 {
	if marketValueCents <= 0 {
		return 0
	}
	switch market {
	case "SH":
		return (marketValueCents / 1_000_000) * 1000
	case "SZ":
		return (marketValueCents / 500_000) * 500
	default:
		return 0
	}
}

// SubscriptionLot is the minimum tradable unit of a subscription: bonds trade
// in 10-unit lots (1 hand = 10 bonds), STAR Market in 500-share lots, Shanghai
// main board in 1,000-share lots and Shenzhen in 500-share lots.
func SubscriptionLot(market string, ipoType domain.IPOType, board string) int64 {
	if ipoType == domain.IPOBond {
		return 10
	}
	if board == "科创板" {
		return 500
	}
	if market == "SH" {
		return 1000
	}
	return 500
}
