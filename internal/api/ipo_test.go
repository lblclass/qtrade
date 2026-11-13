package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/qtrade/qtrade/internal/config"
	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/store"
)

func TestIPOSubscriptionLifecycle(t *testing.T) {
	memory := store.NewMemory()
	ctx := context.Background()
	if err := memory.UpsertIPOOffer(ctx, domain.IPOOffer{
		ID: "ipo_offer_test", Code: "787001", Name: "测试新股", Type: domain.IPOStock,
		Market: "SH", Board: "科创板", IssuePriceCents: 1_000, MinQuantity: 500,
		MaxQuantity: 5_000, SubscriptionDate: "2026-11-10", RequiresMarketValue: true, Status: "open",
	}); err != nil {
		t.Fatalf("seed offer: %v", err)
	}
	if err := memory.ReplacePositions(ctx, "acc_demo", []domain.Position{
		{AccountID: "acc_demo", Symbol: "600519.SH", Quantity: 100, AvailableQuantity: 100, MarketPriceCents: 168_200},
	}); err != nil {
		t.Fatalf("seed positions: %v", err)
	}
	server := newTestServerWithStore(t, memory, config.Config{Environment: "test", CORSOrigins: []string{"*"}})

	var offers struct {
		Items []domain.IPOOffer `json:"items"`
	}
	if status := server.request(t, http.MethodGet, "/api/v1/ipo/offers?account_id=acc_demo", nil, &offers); status != http.StatusOK {
		t.Fatalf("list offers status = %d", status)
	}
	if len(offers.Items) != 1 || offers.Items[0].QuotaQuantity != 5_000 {
		t.Fatalf("unexpected offers: %+v", offers.Items)
	}

	var subscription domain.IPOSubscription
	if status := server.request(t, http.MethodPost, "/api/v1/ipo/subscriptions", map[string]any{
		"account_id": "acc_demo", "offer_id": "ipo_offer_test", "quantity": 5_000,
	}, &subscription); status != http.StatusCreated {
		t.Fatalf("subscribe status = %d", status)
	}
	if subscription.Status != domain.IPOSubmitted || subscription.AmountCents != 5_000_000 {
		t.Fatalf("unexpected subscription: %+v", subscription)
	}

	if status := server.request(t, http.MethodPost, "/api/v1/ipo/subscriptions", map[string]any{
		"account_id": "acc_demo", "offer_id": "ipo_offer_test", "quantity": 500,
	}, nil); status != http.StatusConflict {
		t.Fatalf("duplicate subscribe status = %d", status)
	}

	var settled domain.IPOSubscription
	path := "/api/v1/ipo/subscriptions/" + subscription.ID + "/settle"
	if status := server.request(t, http.MethodPost, path, nil, &settled); status != http.StatusOK {
		t.Fatalf("settle status = %d", status)
	}
	if settled.Status != domain.IPOWon && settled.Status != domain.IPOLost {
		t.Fatalf("unexpected settlement status: %s", settled.Status)
	}

	var limits struct {
		Items []domain.IPOLimit `json:"items"`
	}
	if status := server.request(t, http.MethodGet, "/api/v1/ipo/limits?account_id=acc_demo", nil, &limits); status != http.StatusOK {
		t.Fatalf("limits status = %d", status)
	}
	if len(limits.Items) != 3 || limits.Items[0].QuotaQuantity != 16_000 {
		t.Fatalf("unexpected limits: %+v", limits.Items)
	}
}
