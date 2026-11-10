package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/qtrade/qtrade/internal/config"
	"github.com/qtrade/qtrade/internal/domain"
)

func TestStrategyLifecycleTransitions(t *testing.T) {
	server := newTestServer(t)
	var strategy domain.Strategy
	if status := server.request(t, http.MethodPost, "/api/v1/strategies", map[string]any{
		"name": "lifecycle",
	}, &strategy); status != http.StatusCreated {
		t.Fatalf("create strategy: got %d", status)
	}
	if status := server.request(t, http.MethodPost, "/api/v1/strategies/"+strategy.ID+"/versions", map[string]any{
		"version": "0.1.0", "artifact_digest": "sha256:test",
	}, nil); status != http.StatusCreated {
		t.Fatalf("create version: got %d", status)
	}
	var versions struct {
		Items []domain.StrategyVersion `json:"items"`
		Count int                      `json:"count"`
	}
	if status := server.request(t, http.MethodGet, "/api/v1/strategies/"+strategy.ID+"/versions", nil, &versions); status != http.StatusOK {
		t.Fatalf("list versions: got %d", status)
	}
	if versions.Count != 1 || versions.Items[0].Version != "0.1.0" {
		t.Fatalf("unexpected versions: %+v", versions)
	}

	if status := server.request(t, http.MethodPatch, "/api/v1/strategies/"+strategy.ID+"/status", map[string]any{
		"status": "backtesting",
	}, &strategy); status != http.StatusOK || strategy.Status != domain.StrategyBacktesting {
		t.Fatalf("draft -> backtesting: status=%d payload=%+v", status, strategy)
	}
	if status := server.request(t, http.MethodPatch, "/api/v1/strategies/"+strategy.ID+"/status", map[string]any{
		"status": "live",
	}, nil); status != http.StatusConflict {
		t.Fatalf("backtesting -> live must be rejected, got %d", status)
	}
	if status := server.request(t, http.MethodPatch, "/api/v1/strategies/"+strategy.ID+"/status", map[string]any{
		"status": "review",
	}, &strategy); status != http.StatusOK || strategy.Status != domain.StrategyReview {
		t.Fatalf("backtesting -> review: status=%d payload=%+v", status, strategy)
	}
}

func TestCancelBacktestAndOrder(t *testing.T) {
	server := newTestServer(t)
	var strategy domain.Strategy
	server.request(t, http.MethodPost, "/api/v1/strategies", map[string]any{"name": "cancel"}, &strategy)
	server.request(t, http.MethodPost, "/api/v1/strategies/"+strategy.ID+"/versions", map[string]any{
		"version": "1.0.0", "artifact_digest": "sha256:test",
	}, nil)
	var run domain.BacktestRun
	if status := server.request(t, http.MethodPost, "/api/v1/backtests", map[string]any{
		"strategy_id": strategy.ID, "strategy_version": "1.0.0",
		"data_snapshot_id": "snap_test", "start_date": "2025-01-01", "end_date": "2025-12-31",
	}, &run); status != http.StatusAccepted {
		t.Fatalf("create backtest: got %d", status)
	}
	if status := server.request(t, http.MethodPost, "/api/v1/backtests/"+run.ID+"/cancel", nil, &run); status != http.StatusOK || run.Status != domain.BacktestCanceled {
		t.Fatalf("cancel backtest: status=%d payload=%+v", status, run)
	}
	if status := server.request(t, http.MethodPost, "/api/v1/backtests/"+run.ID+"/cancel", nil, nil); status != http.StatusConflict {
		t.Fatalf("double cancel must conflict, got %d", status)
	}

	var deployment domain.LiveDeployment
	server.request(t, http.MethodPost, "/api/v1/live-deployments", map[string]any{
		"strategy_id": strategy.ID, "strategy_version": "1.0.0", "mode": "paper", "account_id": "acc_demo",
	}, &deployment)
	server.request(t, http.MethodPost, "/api/v1/live-deployments/"+deployment.ID+"/start", nil, &deployment)
	var order domain.Order
	if status := server.request(t, http.MethodPost, "/api/v1/orders", map[string]any{
		"client_order_id": "cancel-1", "deployment_id": deployment.ID, "symbol": "600000.SH",
		"side": "buy", "order_type": "market", "quantity": 100, "price_cents": 1000,
	}, &order); status != http.StatusCreated {
		t.Fatalf("create order: got %d", status)
	}
	if status := server.request(t, http.MethodPost, "/api/v1/orders/"+order.ID+"/cancel", nil, &order); status != http.StatusOK || order.Status != domain.OrderCanceled {
		t.Fatalf("cancel order: status=%d payload=%+v", status, order)
	}
}

func TestDataEndpoints(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "instruments", "20260101"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(path, body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "_ui_summary.json"), `{"generated_at":"2026-01-01T00:00:00Z","datasets":[{"key":"bars_1d"}]}`)
	write(filepath.Join(root, "_quotes.json"), `{"items":[{"symbol":"600519.SH","name":"贵州茅台","close_cents":168200,"change_bps":120}]}`)
	write(filepath.Join(root, "instruments", "20260101", "instruments.json"), `[{"symbol":"600519.SH","name":"贵州茅台","exchange":"SH","is_active":true}]`)

	server := newTestServerWithConfig(t, config.Config{Environment: "test", CORSOrigins: []string{"*"}, DataRoot: root})
	var overview map[string]any
	if status := server.request(t, http.MethodGet, "/api/v1/data/overview", nil, &overview); status != http.StatusOK || overview["available"] != true {
		t.Fatalf("overview: status=%d payload=%+v", status, overview)
	}
	var quotes struct {
		Count int `json:"count"`
	}
	if status := server.request(t, http.MethodGet, "/api/v1/market/quotes?q=600519", nil, &quotes); status != http.StatusOK || quotes.Count != 1 {
		t.Fatalf("quotes: status=%d payload=%+v", status, quotes)
	}
	var instruments struct {
		Count int `json:"count"`
	}
	if status := server.request(t, http.MethodGet, "/api/v1/market/instruments?q=茅台", nil, &instruments); status != http.StatusOK || instruments.Count != 1 {
		t.Fatalf("instruments: status=%d payload=%+v", status, instruments)
	}
}
