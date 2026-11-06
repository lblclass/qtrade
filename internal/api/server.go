package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/qtrade/qtrade/internal/broker"
	"github.com/qtrade/qtrade/internal/config"
	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/risk"
	"github.com/qtrade/qtrade/internal/store"
)

const APIVersion = "v1"

type Server struct {
	store   store.Store
	risk    *risk.Engine
	gateway broker.Gateway
	config  config.Config
}

func New(st store.Store, riskEngine *risk.Engine, gateway broker.Gateway, logger *slog.Logger, cfg config.Config) http.Handler {
	s := &Server{store: st, risk: riskEngine, gateway: gateway, config: cfg}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /api/v1/meta", s.meta)

	mux.HandleFunc("GET /api/v1/strategies", s.listStrategies)
	mux.HandleFunc("POST /api/v1/strategies", s.createStrategy)
	mux.HandleFunc("GET /api/v1/strategies/{id}", s.getStrategy)
	mux.HandleFunc("POST /api/v1/strategies/{id}/versions", s.createStrategyVersion)

	mux.HandleFunc("GET /api/v1/backtests", s.listBacktests)
	mux.HandleFunc("POST /api/v1/backtests", s.createBacktest)
	mux.HandleFunc("GET /api/v1/backtests/{id}", s.getBacktest)

	mux.HandleFunc("GET /api/v1/live-deployments", s.listDeployments)
	mux.HandleFunc("POST /api/v1/live-deployments", s.createDeployment)
	mux.HandleFunc("POST /api/v1/live-deployments/{id}/{action}", s.deploymentAction)

	mux.HandleFunc("GET /api/v1/orders", s.listOrders)
	mux.HandleFunc("POST /api/v1/orders", s.createOrder)
	mux.HandleFunc("GET /api/v1/positions", s.listPositions)
	mux.HandleFunc("GET /api/v1/accounts", s.listAccounts)
	mux.HandleFunc("GET /api/v1/risk/rules", s.getRiskRules)
	mux.HandleFunc("GET /api/v1/audit-logs", s.listAuditLogs)
	mux.HandleFunc("GET /api/v1/gateways", s.listGateways)
	mux.HandleFunc("/", s.notFound)

	return withRecover(logger, withRequestID(withLogging(logger, withCORS(cfg.CORSOrigins, mux))))
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "qtrade-api"})
}

func (s *Server) ready(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "service": "qtrade-api"})
}

func (s *Server) meta(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"api_version": APIVersion,
		"environment": s.config.Environment,
		"now":         time.Now().UTC(),
	})
}

func (s *Server) notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not_found", "route not found", nil)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("request body must contain a single JSON object")
	}
	return nil
}

func (s *Server) actor(r *http.Request) string {
	if actor := r.Header.Get("X-Actor"); actor != "" {
		return actor
	}
	return "system"
}

func (s *Server) audit(r *http.Request, action, resourceType, resourceID, detail string) {
	_ = s.store.AddAudit(r.Context(), domain.AuditEvent{
		Actor:        s.actor(r),
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		Detail:       detail,
	})
}

func mapStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "resource not found", nil)
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "resource already exists", nil)
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "internal server error", nil)
	}
}
