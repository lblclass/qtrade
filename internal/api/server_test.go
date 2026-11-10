package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/qtrade/qtrade/internal/api"
	"github.com/qtrade/qtrade/internal/broker"
	"github.com/qtrade/qtrade/internal/config"
	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/risk"
	"github.com/qtrade/qtrade/internal/store"
)

type testServer struct {
	handler http.Handler
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	return newTestServerWithConfig(t, config.Config{
		Environment: "test",
		CORSOrigins: []string{"*"},
	})
}

func newTestServerWithConfig(t *testing.T, cfg config.Config) *testServer {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := api.New(store.NewMemory(), risk.NewEngine(domain.DefaultRiskLimits()), broker.Mock{}, logger, cfg)
	return &testServer{handler: handler}
}

func (s *testServer) request(t *testing.T, method, path string, body any, out any) int {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Actor", "test")
	recorder := httptest.NewRecorder()
	s.handler.ServeHTTP(recorder, request)
	response := recorder.Result()
	defer response.Body.Close()
	if out != nil {
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read response: %v", err)
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatalf("decode response %s: %v", raw, err)
			}
		}
	}
	return response.StatusCode
}

func TestHealth(t *testing.T) {
	server := newTestServer(t)
	var response map[string]any
	if status := server.request(t, http.MethodGet, "/healthz", nil, &response); status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if response["status"] != "ok" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestStrategyBacktestDeploymentAndOrderFlow(t *testing.T) {
	server := newTestServer(t)

	var strategy domain.Strategy
	if status := server.request(t, http.MethodPost, "/api/v1/strategies", map[string]any{
		"name":        "dual momentum",
		"description": "test strategy",
	}, &strategy); status != http.StatusCreated {
		t.Fatalf("create strategy: expected 201, got %d", status)
	}
	if strategy.ID == "" {
		t.Fatal("strategy id is empty")
	}

	var version domain.StrategyVersion
	if status := server.request(t, http.MethodPost, "/api/v1/strategies/"+strategy.ID+"/versions", map[string]any{
		"version":         "1.0.0",
		"artifact_digest": "sha256:abc",
		"python_version":  "3.13",
	}, &version); status != http.StatusCreated {
		t.Fatalf("create version: expected 201, got %d", status)
	}

	var backtest domain.BacktestRun
	if status := server.request(t, http.MethodPost, "/api/v1/backtests", map[string]any{
		"strategy_id":        strategy.ID,
		"strategy_version":   version.Version,
		"data_snapshot_id":   "snap_20261105_001",
		"start_date":         "2020-01-01",
		"end_date":           "2025-12-31",
		"initial_cash_cents": 100_000_000,
		"frequency":          "1d",
	}, &backtest); status != http.StatusAccepted {
		t.Fatalf("create backtest: expected 202, got %d", status)
	}
	if backtest.Status != domain.BacktestQueued {
		t.Fatalf("unexpected backtest status: %s", backtest.Status)
	}

	var deployment domain.LiveDeployment
	if status := server.request(t, http.MethodPost, "/api/v1/live-deployments", map[string]any{
		"strategy_id":      strategy.ID,
		"strategy_version": version.Version,
		"mode":             "paper",
		"account_id":       "acc_demo",
	}, &deployment); status != http.StatusCreated {
		t.Fatalf("create deployment: expected 201, got %d", status)
	}
	if deployment.Status != domain.DeploymentCreated {
		t.Fatalf("unexpected deployment status: %s", deployment.Status)
	}

	if status := server.request(t, http.MethodPost, "/api/v1/live-deployments/"+deployment.ID+"/start", nil, &deployment); status != http.StatusOK {
		t.Fatalf("start deployment: expected 200, got %d", status)
	}
	if deployment.Status != domain.DeploymentRunning {
		t.Fatalf("unexpected deployment status after start: %s", deployment.Status)
	}

	orderBody := map[string]any{
		"client_order_id":  "coid-1",
		"deployment_id":    deployment.ID,
		"account_id":       "acc_demo",
		"symbol":           "600000.SH",
		"side":             "buy",
		"order_type":       "market",
		"quantity":         100,
		"price_cents":      1000,
		"last_price_cents": 1000,
		"limit_up_cents":   1100,
		"limit_down_cents": 900,
	}
	var order domain.Order
	if status := server.request(t, http.MethodPost, "/api/v1/orders", orderBody, &order); status != http.StatusCreated {
		t.Fatalf("create order: expected 201, got %d", status)
	}
	if order.Status != domain.OrderAccepted {
		t.Fatalf("unexpected order status: %s", order.Status)
	}

	var duplicate map[string]any
	if status := server.request(t, http.MethodPost, "/api/v1/orders", orderBody, &duplicate); status != http.StatusConflict {
		t.Fatalf("duplicate order: expected 409, got %d", status)
	}

	sellBody := map[string]any{
		"client_order_id":  "coid-2",
		"deployment_id":    deployment.ID,
		"account_id":       "acc_demo",
		"symbol":           "600000.SH",
		"side":             "sell",
		"order_type":       "market",
		"quantity":         100,
		"price_cents":      1000,
		"last_price_cents": 1000,
	}
	var rejected map[string]any
	if status := server.request(t, http.MethodPost, "/api/v1/orders", sellBody, &rejected); status != http.StatusUnprocessableEntity {
		t.Fatalf("sell without position: expected 422, got %d", status)
	}

	if status := server.request(t, http.MethodPost, "/api/v1/live-deployments/"+deployment.ID+"/kill", nil, &deployment); status != http.StatusOK {
		t.Fatalf("kill deployment: expected 200, got %d", status)
	}
	if deployment.Status != domain.DeploymentStopped {
		t.Fatalf("unexpected deployment status after kill: %s", deployment.Status)
	}
	if status := server.request(t, http.MethodPost, "/api/v1/orders", map[string]any{
		"client_order_id": "coid-3",
		"deployment_id":   deployment.ID,
		"account_id":      "acc_demo",
		"symbol":          "600000.SH",
		"side":            "buy",
		"order_type":      "market",
		"quantity":        100,
		"price_cents":     1000,
	}, nil); status != http.StatusConflict {
		t.Fatalf("order after kill: expected 409, got %d", status)
	}
}
