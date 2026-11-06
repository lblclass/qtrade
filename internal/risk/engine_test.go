package risk_test

import (
	"testing"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/risk"
)

func testAccount() domain.Account {
	return domain.Account{
		ID:          "acc_test",
		CashCents:   100_000_000,
		EquityCents: 100_000_000,
		Currency:    "CNY",
	}
}

func hasCode(violations []risk.Violation, code string) bool {
	for _, violation := range violations {
		if violation.Code == code {
			return true
		}
	}
	return false
}

func TestCheckAcceptsValidBuy(t *testing.T) {
	engine := risk.NewEngine(domain.DefaultRiskLimits())
	violations := engine.Check(risk.OrderRequest{
		Symbol:         "600000.SH",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderMarket,
		Quantity:       100,
		PriceCents:     1_000,
		LastPriceCents: 1_000,
	}, testAccount(), nil)
	if len(violations) != 0 {
		t.Fatalf("expected no violations, got %+v", violations)
	}
}

func TestCheckRejectsLotSize(t *testing.T) {
	engine := risk.NewEngine(domain.DefaultRiskLimits())
	violations := engine.Check(risk.OrderRequest{
		Symbol:         "600000.SH",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderMarket,
		Quantity:       150,
		PriceCents:     1_000,
		LastPriceCents: 1_000,
	}, testAccount(), nil)
	if !hasCode(violations, "lot_size") {
		t.Fatalf("expected lot_size violation, got %+v", violations)
	}
}

func TestCheckRejectsMaxOrderNotional(t *testing.T) {
	engine := risk.NewEngine(domain.DefaultRiskLimits())
	violations := engine.Check(risk.OrderRequest{
		Symbol:         "600000.SH",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderMarket,
		Quantity:       100_000,
		PriceCents:     1_000,
		LastPriceCents: 1_000,
	}, testAccount(), nil)
	if !hasCode(violations, "max_order_notional") {
		t.Fatalf("expected max_order_notional violation, got %+v", violations)
	}
}

func TestCheckRejectsSellWithoutAvailablePosition(t *testing.T) {
	engine := risk.NewEngine(domain.DefaultRiskLimits())
	violations := engine.Check(risk.OrderRequest{
		Symbol:         "600000.SH",
		Side:           domain.SideSell,
		OrderType:      domain.OrderMarket,
		Quantity:       100,
		PriceCents:     1_000,
		LastPriceCents: 1_000,
	}, testAccount(), map[string]domain.Position{
		"600000.SH": {AccountID: "acc_test", Symbol: "600000.SH", Quantity: 100, AvailableQuantity: 0},
	})
	if !hasCode(violations, "insufficient_available_position") {
		t.Fatalf("expected insufficient_available_position violation, got %+v", violations)
	}
}

func TestCheckRejectsPriceDeviationAndLimitUp(t *testing.T) {
	engine := risk.NewEngine(domain.DefaultRiskLimits())
	violations := engine.Check(risk.OrderRequest{
		Symbol:         "600000.SH",
		Side:           domain.SideBuy,
		OrderType:      domain.OrderLimit,
		Quantity:       100,
		PriceCents:     1_100,
		LastPriceCents: 1_000,
		LimitUpCents:   1_000,
	}, testAccount(), nil)
	if !hasCode(violations, "price_deviation") {
		t.Fatalf("expected price_deviation violation, got %+v", violations)
	}
	if !hasCode(violations, "above_limit_up") {
		t.Fatalf("expected above_limit_up violation, got %+v", violations)
	}
}
