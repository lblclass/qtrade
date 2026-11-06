package risk

import (
	"fmt"

	"github.com/qtrade/qtrade/internal/domain"
)

type Engine struct {
	limits domain.RiskLimits
}

func NewEngine(limits domain.RiskLimits) *Engine {
	if limits.LotSize <= 0 {
		limits.LotSize = 100
	}
	return &Engine{limits: limits}
}

func (e *Engine) Limits() domain.RiskLimits {
	return e.limits
}

type OrderRequest struct {
	ClientOrderID  string           `json:"client_order_id"`
	DeploymentID   string           `json:"deployment_id"`
	AccountID      string           `json:"account_id"`
	Symbol         string           `json:"symbol"`
	Side           domain.Side      `json:"side"`
	OrderType      domain.OrderType `json:"order_type"`
	Quantity       int64            `json:"quantity"`
	PriceCents     int64            `json:"price_cents"`
	LastPriceCents int64            `json:"last_price_cents"`
	LimitUpCents   int64            `json:"limit_up_cents"`
	LimitDownCents int64            `json:"limit_down_cents"`
}

type Violation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Engine) Check(req OrderRequest, account domain.Account, positions map[string]domain.Position) []Violation {
	var violations []Violation
	add := func(code, message string) {
		violations = append(violations, Violation{Code: code, Message: message})
	}

	if req.Symbol == "" {
		add("symbol_required", "symbol is required")
	}
	if req.Side != domain.SideBuy && req.Side != domain.SideSell {
		add("invalid_side", "side must be buy or sell")
	}
	if req.OrderType != domain.OrderMarket && req.OrderType != domain.OrderLimit {
		add("invalid_order_type", "order_type must be market or limit")
	}
	if req.Quantity <= 0 {
		add("invalid_quantity", "quantity must be positive")
		return violations
	}
	if req.PriceCents <= 0 {
		add("invalid_price", "price_cents must be positive")
		return violations
	}
	if req.Quantity > e.limits.MaxOrderQuantity {
		add("max_order_quantity", fmt.Sprintf("quantity %d exceeds limit %d", req.Quantity, e.limits.MaxOrderQuantity))
		return violations
	}
	if e.limits.MaxOrderNotionalCents > 0 && req.PriceCents > e.limits.MaxOrderNotionalCents/req.Quantity {
		add("max_order_notional", fmt.Sprintf("order notional exceeds limit %d", e.limits.MaxOrderNotionalCents))
		return violations
	}

	notional := req.Quantity * req.PriceCents
	if notional > e.limits.MaxOrderNotionalCents {
		add("max_order_notional", fmt.Sprintf("order notional %d exceeds limit %d", notional, e.limits.MaxOrderNotionalCents))
	}

	if req.Side == domain.SideBuy && req.Quantity%e.limits.LotSize != 0 {
		add("lot_size", fmt.Sprintf("buy quantity must be a multiple of %d", e.limits.LotSize))
	}

	if req.LastPriceCents > 0 {
		difference := req.PriceCents - req.LastPriceCents
		if difference < 0 {
			difference = -difference
		}
		if difference*10_000/req.LastPriceCents > e.limits.MaxPriceDeviationBPS {
			add("price_deviation", fmt.Sprintf("price deviates more than %d bps from last price", e.limits.MaxPriceDeviationBPS))
		}
	}

	if req.LimitUpCents > 0 && req.PriceCents > req.LimitUpCents {
		add("above_limit_up", "price is above the daily limit up")
	}
	if req.LimitDownCents > 0 && req.PriceCents < req.LimitDownCents {
		add("below_limit_down", "price is below the daily limit down")
	}

	position := positions[req.Symbol]
	if req.Side == domain.SideSell {
		if position.AvailableQuantity < req.Quantity {
			add("insufficient_available_position", fmt.Sprintf("available position %d is less than sell quantity %d", position.AvailableQuantity, req.Quantity))
		}
	} else {
		fees := e.EstimateFees(notional, domain.SideBuy)
		if account.CashCents < notional+fees {
			add("insufficient_cash", fmt.Sprintf("cash %d is less than required %d", account.CashCents, notional+fees))
		}
		if account.EquityCents > 0 {
			currentValue := position.Quantity * position.MarketPriceCents
			newValue := currentValue + notional
			if newValue*10_000/account.EquityCents > e.limits.MaxPositionPercentBPS {
				add("max_position_percent", fmt.Sprintf("position would exceed %d bps of equity", e.limits.MaxPositionPercentBPS))
			}
		}
	}

	return violations
}

func (e *Engine) EstimateFees(notional int64, side domain.Side) int64 {
	commission := notional * e.limits.CommissionBPS / 10_000
	if commission < e.limits.MinCommissionCents {
		commission = e.limits.MinCommissionCents
	}
	stampTax := int64(0)
	if side == domain.SideSell {
		stampTax = notional * e.limits.StampTaxBPS / 10_000
	}
	transferFee := notional * e.limits.TransferFeeBPS / 10_000
	return commission + stampTax + transferFee
}
