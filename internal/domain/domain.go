package domain

import (
	"errors"
	"fmt"
	"time"
)

type StrategyStatus string

const (
	StrategyDraft       StrategyStatus = "draft"
	StrategyBacktesting StrategyStatus = "backtesting"
	StrategyReview      StrategyStatus = "review"
	StrategyPaper       StrategyStatus = "paper"
	StrategyCanary      StrategyStatus = "canary"
	StrategyLive        StrategyStatus = "live"
	StrategyPaused      StrategyStatus = "paused"
	StrategyRetired     StrategyStatus = "retired"
)

type Strategy struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Status      StrategyStatus `json:"status"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

// Transition moves a strategy through its lifecycle. Every accepted edge is
// explicit so the console cannot promote a strategy that skipped review.
func (s *Strategy) Transition(next StrategyStatus) error {
	if next == s.Status {
		return nil
	}
	allowed := map[StrategyStatus][]StrategyStatus{
		StrategyDraft:       {StrategyBacktesting, StrategyRetired},
		StrategyBacktesting: {StrategyReview, StrategyDraft, StrategyRetired},
		StrategyReview:      {StrategyPaper, StrategyBacktesting, StrategyRetired},
		StrategyPaper:       {StrategyCanary, StrategyLive, StrategyPaused, StrategyRetired},
		StrategyCanary:      {StrategyLive, StrategyPaper, StrategyPaused, StrategyRetired},
		StrategyLive:        {StrategyPaused, StrategyRetired},
		StrategyPaused:      {StrategyLive, StrategyPaper, StrategyRetired},
	}
	for _, candidate := range allowed[s.Status] {
		if candidate == next {
			s.Status = next
			s.UpdatedAt = time.Now().UTC()
			return nil
		}
	}
	return fmt.Errorf("cannot move strategy from %s to %s", s.Status, next)
}

type StrategyVersion struct {
	ID             string    `json:"id"`
	StrategyID     string    `json:"strategy_id"`
	Version        string    `json:"version"`
	ArtifactDigest string    `json:"artifact_digest"`
	PythonVersion  string    `json:"python_version"`
	CreatedAt      time.Time `json:"created_at"`
}

type BacktestStatus string

const (
	BacktestQueued    BacktestStatus = "queued"
	BacktestRunning   BacktestStatus = "running"
	BacktestSucceeded BacktestStatus = "succeeded"
	BacktestFailed    BacktestStatus = "failed"
	BacktestCanceled  BacktestStatus = "canceled"
)

type BacktestRun struct {
	ID               string         `json:"id"`
	StrategyID       string         `json:"strategy_id"`
	StrategyVersion  string         `json:"strategy_version"`
	DataSnapshotID   string         `json:"data_snapshot_id"`
	StartDate        string         `json:"start_date"`
	EndDate          string         `json:"end_date"`
	InitialCashCents int64          `json:"initial_cash_cents"`
	Benchmark        string         `json:"benchmark"`
	Universe         string         `json:"universe"`
	Frequency        string         `json:"frequency"`
	Params           map[string]any `json:"params,omitempty"`
	Status           BacktestStatus `json:"status"`
	Metrics          map[string]any `json:"metrics,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

type DeploymentMode string

const (
	ModePaper DeploymentMode = "paper"
	ModeLive  DeploymentMode = "live"
)

type DeploymentStatus string

const (
	DeploymentCreated  DeploymentStatus = "created"
	DeploymentRunning  DeploymentStatus = "running"
	DeploymentPaused   DeploymentStatus = "paused"
	DeploymentDegraded DeploymentStatus = "degraded"
	DeploymentStopped  DeploymentStatus = "stopped"
)

type LiveDeployment struct {
	ID              string           `json:"id"`
	StrategyID      string           `json:"strategy_id"`
	StrategyVersion string           `json:"strategy_version"`
	Mode            DeploymentMode   `json:"mode"`
	AccountID       string           `json:"account_id"`
	Status          DeploymentStatus `json:"status"`
	LastError       string           `json:"last_error,omitempty"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

func (d *LiveDeployment) Apply(action string) error {
	next, err := transition(d.Status, action)
	if err != nil {
		return err
	}
	d.Status = next
	d.UpdatedAt = time.Now().UTC()
	return nil
}

func transition(current DeploymentStatus, action string) (DeploymentStatus, error) {
	switch action {
	case "start":
		if current != DeploymentCreated {
			return current, fmt.Errorf("cannot start deployment from %s", current)
		}
		return DeploymentRunning, nil
	case "pause":
		if current != DeploymentRunning && current != DeploymentDegraded {
			return current, fmt.Errorf("cannot pause deployment from %s", current)
		}
		return DeploymentPaused, nil
	case "resume":
		if current != DeploymentPaused {
			return current, fmt.Errorf("cannot resume deployment from %s", current)
		}
		return DeploymentRunning, nil
	case "degrade":
		if current != DeploymentRunning {
			return current, fmt.Errorf("cannot degrade deployment from %s", current)
		}
		return DeploymentDegraded, nil
	case "stop":
		if current == DeploymentStopped {
			return current, errors.New("deployment is already stopped")
		}
		return DeploymentStopped, nil
	case "kill":
		return DeploymentStopped, nil
	default:
		return current, fmt.Errorf("unknown deployment action %q", action)
	}
}

type Side string

const (
	SideBuy  Side = "buy"
	SideSell Side = "sell"
)

type OrderType string

const (
	OrderMarket OrderType = "market"
	OrderLimit  OrderType = "limit"
)

type OrderStatus string

const (
	OrderAccepted        OrderStatus = "accepted"
	OrderRejected        OrderStatus = "rejected"
	OrderPartiallyFilled OrderStatus = "partially_filled"
	OrderFilled          OrderStatus = "filled"
	OrderCanceled        OrderStatus = "canceled"
)

type Order struct {
	ID             string      `json:"id"`
	ClientOrderID  string      `json:"client_order_id"`
	DeploymentID   string      `json:"deployment_id"`
	AccountID      string      `json:"account_id"`
	Symbol         string      `json:"symbol"`
	Side           Side        `json:"side"`
	OrderType      OrderType   `json:"order_type"`
	Quantity       int64       `json:"quantity"`
	FilledQuantity int64       `json:"filled_quantity"`
	PriceCents     int64       `json:"price_cents"`
	Status         OrderStatus `json:"status"`
	RejectReason   string      `json:"reject_reason,omitempty"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

type Position struct {
	AccountID         string `json:"account_id"`
	Symbol            string `json:"symbol"`
	Quantity          int64  `json:"quantity"`
	AvailableQuantity int64  `json:"available_quantity"`
	AvgCostCents      int64  `json:"avg_cost_cents"`
	MarketPriceCents  int64  `json:"market_price_cents"`
}

type Account struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	CashCents   int64  `json:"cash_cents"`
	EquityCents int64  `json:"equity_cents"`
	Currency    string `json:"currency"`
}

type AuditEvent struct {
	ID           string    `json:"id"`
	Actor        string    `json:"actor"`
	Action       string    `json:"action"`
	ResourceType string    `json:"resource_type"`
	ResourceID   string    `json:"resource_id"`
	Detail       string    `json:"detail,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

type RiskLimits struct {
	MaxOrderNotionalCents int64 `json:"max_order_notional_cents"`
	MaxPositionPercentBPS int64 `json:"max_position_percent_bps"`
	MaxPriceDeviationBPS  int64 `json:"max_price_deviation_bps"`
	MaxOrderQuantity      int64 `json:"max_order_quantity"`
	LotSize               int64 `json:"lot_size"`
	CommissionBPS         int64 `json:"commission_bps"`
	MinCommissionCents    int64 `json:"min_commission_cents"`
	StampTaxBPS           int64 `json:"stamp_tax_bps"`
	TransferFeeBPS        int64 `json:"transfer_fee_bps"`
}

func DefaultRiskLimits() RiskLimits {
	return RiskLimits{
		MaxOrderNotionalCents: 5_000_000,
		MaxPositionPercentBPS: 1000,
		MaxPriceDeviationBPS:  300,
		MaxOrderQuantity:      1_000_000,
		LotSize:               100,
		CommissionBPS:         25,
		MinCommissionCents:    500,
		StampTaxBPS:           50,
		TransferFeeBPS:        1,
	}
}

type LogLevel string

const (
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
)

// LogEntry is a human-readable runtime line emitted by the control plane or a
// worker. It is deliberately separate from AuditEvent: audit answers "who
// changed what", logs answer "what did the strategy do at 09:31".
type LogEntry struct {
	ID           string    `json:"id"`
	Level        LogLevel  `json:"level"`
	Source       string    `json:"source"`
	ResourceType string    `json:"resource_type"`
	ResourceID   string    `json:"resource_id"`
	Message      string    `json:"message"`
	CreatedAt    time.Time `json:"created_at"`
}

// EquityPoint is one day of mark-to-market account value.
type EquityPoint struct {
	Date             string `json:"date"`
	EquityCents      int64  `json:"equity_cents"`
	MarketValueCents int64  `json:"market_value_cents"`
	CashCents        int64  `json:"cash_cents"`
	PnLCents         int64  `json:"pnl_cents"`
	PnLBPS           int64  `json:"pnl_bps"`
}

type IPOType string

const (
	IPOStock IPOType = "stock"
	IPOBond  IPOType = "bond"
)

// IPOOffer is one subscribable new issue. Subscribing to a new listing is not
// a normal order: the exchange assigns its own subscription code, the price is
// fixed by the issuer, and the quantity is capped by the investor's holding
// quota (new stocks) or by a flat per-account ceiling (convertible bonds).
type IPOOffer struct {
	ID                  string  `json:"id"`
	Code                string  `json:"code"`
	Name                string  `json:"name"`
	Type                IPOType `json:"type"`
	Market              string  `json:"market"`
	Board               string  `json:"board"`
	IssuePriceCents     int64   `json:"issue_price_cents"`
	MinQuantity         int64   `json:"min_quantity"`
	MaxQuantity         int64   `json:"max_quantity"`
	QuotaQuantity       int64   `json:"quota_quantity"`
	SubscriptionDate    string  `json:"subscription_date"`
	ListingDate         string  `json:"listing_date,omitempty"`
	RequiresMarketValue bool    `json:"requires_market_value"`
	Status              string  `json:"status"`
	Note                string  `json:"note,omitempty"`
}

// IPOLimit is the per-market subscription ceiling derived from the account's
// average daily holding market value over the previous 20 trading days.
type IPOLimit struct {
	Market           string `json:"market"`
	Label            string `json:"label"`
	QuotaQuantity    int64  `json:"quota_quantity"`
	MarketValueCents int64  `json:"market_value_cents"`
	Enabled          bool   `json:"enabled"`
	Note             string `json:"note,omitempty"`
}

type IPOSubscriptionStatus string

const (
	IPOSubmitted IPOSubscriptionStatus = "submitted"
	IPOWon       IPOSubscriptionStatus = "won"
	IPOLost      IPOSubscriptionStatus = "lost"
	IPOPaid      IPOSubscriptionStatus = "paid"
	IPOAbandoned IPOSubscriptionStatus = "abandoned"
	IPORejected  IPOSubscriptionStatus = "rejected"
)

type IPOSubscription struct {
	ID               string                `json:"id"`
	OfferID          string                `json:"offer_id"`
	Code             string                `json:"code"`
	Name             string                `json:"name"`
	Type             IPOType               `json:"type"`
	AccountID        string                `json:"account_id"`
	Quantity         int64                 `json:"quantity"`
	PriceCents       int64                 `json:"price_cents"`
	AmountCents      int64                 `json:"amount_cents"`
	AllottedQuantity int64                 `json:"allotted_quantity"`
	Status           IPOSubscriptionStatus `json:"status"`
	Message          string                `json:"message,omitempty"`
	BrokerRequestID  string                `json:"broker_request_id,omitempty"`
	CreatedAt        time.Time             `json:"created_at"`
	UpdatedAt        time.Time             `json:"updated_at"`
}
