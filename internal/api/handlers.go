package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/id"
	"github.com/qtrade/qtrade/internal/risk"
)

type createStrategyRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) createStrategy(w http.ResponseWriter, r *http.Request) {
	var request createStrategyRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		writeError(w, http.StatusBadRequest, "name_required", "name is required", nil)
		return
	}
	now := time.Now().UTC()
	strategy := domain.Strategy{
		ID:          id.New("stg"),
		Name:        request.Name,
		Description: strings.TrimSpace(request.Description),
		Status:      domain.StrategyDraft,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.store.CreateStrategy(r.Context(), strategy); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "strategy.created", "strategy", strategy.ID, strategy.Name)
	writeJSON(w, http.StatusCreated, strategy)
}

func (s *Server) listStrategies(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListStrategies(r.Context())
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) getStrategy(w http.ResponseWriter, r *http.Request) {
	strategy, err := s.store.GetStrategy(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, strategy)
}

type createVersionRequest struct {
	Version        string `json:"version"`
	ArtifactDigest string `json:"artifact_digest"`
	PythonVersion  string `json:"python_version"`
}

func (s *Server) createStrategyVersion(w http.ResponseWriter, r *http.Request) {
	strategyID := r.PathValue("id")
	if _, err := s.store.GetStrategy(r.Context(), strategyID); err != nil {
		mapStoreError(w, err)
		return
	}
	var request createVersionRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	request.Version = strings.TrimSpace(request.Version)
	request.ArtifactDigest = strings.TrimSpace(request.ArtifactDigest)
	if request.Version == "" {
		writeError(w, http.StatusBadRequest, "version_required", "version is required", nil)
		return
	}
	if request.ArtifactDigest == "" {
		writeError(w, http.StatusBadRequest, "artifact_digest_required", "artifact_digest is required", nil)
		return
	}
	if request.PythonVersion == "" {
		request.PythonVersion = "3.13"
	}
	version := domain.StrategyVersion{
		ID:             id.New("ver"),
		StrategyID:     strategyID,
		Version:        request.Version,
		ArtifactDigest: request.ArtifactDigest,
		PythonVersion:  request.PythonVersion,
		CreatedAt:      time.Now().UTC(),
	}
	if err := s.store.CreateStrategyVersion(r.Context(), version); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "strategy.version_created", "strategy_version", version.ID, version.StrategyID+"@"+version.Version)
	writeJSON(w, http.StatusCreated, version)
}

type createBacktestRequest struct {
	StrategyID       string         `json:"strategy_id"`
	StrategyVersion  string         `json:"strategy_version"`
	DataSnapshotID   string         `json:"data_snapshot_id"`
	StartDate        string         `json:"start_date"`
	EndDate          string         `json:"end_date"`
	InitialCashCents int64          `json:"initial_cash_cents"`
	Benchmark        string         `json:"benchmark"`
	Universe         string         `json:"universe"`
	Frequency        string         `json:"frequency"`
	Params           map[string]any `json:"params"`
}

func (s *Server) createBacktest(w http.ResponseWriter, r *http.Request) {
	var request createBacktestRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if request.StrategyID == "" || request.StrategyVersion == "" || request.DataSnapshotID == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "strategy_id, strategy_version and data_snapshot_id are required", nil)
		return
	}
	if _, err := s.store.GetStrategyVersion(r.Context(), request.StrategyID, request.StrategyVersion); err != nil {
		mapStoreError(w, err)
		return
	}
	startDate, err := time.Parse("2006-01-02", request.StartDate)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_start_date", "start_date must use YYYY-MM-DD", nil)
		return
	}
	endDate, err := time.Parse("2006-01-02", request.EndDate)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_end_date", "end_date must use YYYY-MM-DD", nil)
		return
	}
	if endDate.Before(startDate) {
		writeError(w, http.StatusBadRequest, "invalid_date_range", "end_date must not be before start_date", nil)
		return
	}
	if request.InitialCashCents <= 0 {
		request.InitialCashCents = 100_000_000
	}
	if request.Frequency == "" {
		request.Frequency = "1d"
	}
	if request.Benchmark == "" {
		request.Benchmark = "000300.SH"
	}
	if request.Universe == "" {
		request.Universe = "000300.SH"
	}
	now := time.Now().UTC()
	run := domain.BacktestRun{
		ID:               id.New("bt"),
		StrategyID:       request.StrategyID,
		StrategyVersion:  request.StrategyVersion,
		DataSnapshotID:   request.DataSnapshotID,
		StartDate:        request.StartDate,
		EndDate:          request.EndDate,
		InitialCashCents: request.InitialCashCents,
		Benchmark:        request.Benchmark,
		Universe:         request.Universe,
		Frequency:        request.Frequency,
		Params:           request.Params,
		Status:           domain.BacktestQueued,
		Metrics:          map[string]any{},
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := s.store.CreateBacktest(r.Context(), run); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "backtest.queued", "backtest", run.ID, run.StrategyID+"@"+run.StrategyVersion)
	writeJSON(w, http.StatusAccepted, run)
}

func (s *Server) getBacktest(w http.ResponseWriter, r *http.Request) {
	run, err := s.store.GetBacktest(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) listBacktests(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListBacktests(r.Context())
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

type createDeploymentRequest struct {
	StrategyID      string                `json:"strategy_id"`
	StrategyVersion string                `json:"strategy_version"`
	Mode            domain.DeploymentMode `json:"mode"`
	AccountID       string                `json:"account_id"`
}

func (s *Server) createDeployment(w http.ResponseWriter, r *http.Request) {
	var request createDeploymentRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if request.StrategyID == "" || request.StrategyVersion == "" || request.AccountID == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "strategy_id, strategy_version and account_id are required", nil)
		return
	}
	if request.Mode == "" {
		request.Mode = domain.ModePaper
	}
	if request.Mode != domain.ModePaper && request.Mode != domain.ModeLive {
		writeError(w, http.StatusBadRequest, "invalid_mode", "mode must be paper or live", nil)
		return
	}
	if _, err := s.store.GetStrategyVersion(r.Context(), request.StrategyID, request.StrategyVersion); err != nil {
		mapStoreError(w, err)
		return
	}
	if _, err := s.store.GetAccount(r.Context(), request.AccountID); err != nil {
		mapStoreError(w, err)
		return
	}
	now := time.Now().UTC()
	deployment := domain.LiveDeployment{
		ID:              id.New("dep"),
		StrategyID:      request.StrategyID,
		StrategyVersion: request.StrategyVersion,
		Mode:            request.Mode,
		AccountID:       request.AccountID,
		Status:          domain.DeploymentCreated,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.CreateDeployment(r.Context(), deployment); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "deployment.created", "live_deployment", deployment.ID, string(deployment.Mode))
	writeJSON(w, http.StatusCreated, deployment)
}

func (s *Server) listDeployments(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListDeployments(r.Context())
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) deploymentAction(w http.ResponseWriter, r *http.Request) {
	deployment, err := s.store.GetDeployment(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	action := r.PathValue("action")
	if err := deployment.Apply(action); err != nil {
		writeError(w, http.StatusConflict, "invalid_transition", err.Error(), nil)
		return
	}
	if err := s.store.UpdateDeployment(r.Context(), deployment); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "deployment."+action, "live_deployment", deployment.ID, string(deployment.Status))
	writeJSON(w, http.StatusOK, deployment)
}

type createOrderRequest struct {
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

func (s *Server) createOrder(w http.ResponseWriter, r *http.Request) {
	var request createOrderRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if request.ClientOrderID == "" {
		writeError(w, http.StatusBadRequest, "client_order_id_required", "client_order_id is required for idempotency", nil)
		return
	}
	deployment, err := s.store.GetDeployment(r.Context(), request.DeploymentID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if deployment.Status != domain.DeploymentRunning {
		writeError(w, http.StatusConflict, "deployment_not_running", "deployment must be running before orders can be submitted", nil)
		return
	}
	if request.AccountID == "" {
		request.AccountID = deployment.AccountID
	}
	if request.AccountID != deployment.AccountID {
		writeError(w, http.StatusBadRequest, "account_mismatch", "account_id must match the deployment account", nil)
		return
	}
	account, err := s.store.GetAccount(r.Context(), request.AccountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	positions, err := s.store.ListPositions(r.Context(), request.AccountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	positionMap := make(map[string]domain.Position, len(positions))
	for _, position := range positions {
		positionMap[position.Symbol] = position
	}
	duplicate, err := s.store.HasClientOrderID(r.Context(), request.ClientOrderID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if duplicate {
		writeError(w, http.StatusConflict, "duplicate_client_order_id", "client_order_id has already been used", nil)
		return
	}
	violations := s.risk.Check(risk.OrderRequest{
		ClientOrderID:  request.ClientOrderID,
		DeploymentID:   deployment.ID,
		AccountID:      request.AccountID,
		Symbol:         request.Symbol,
		Side:           request.Side,
		OrderType:      request.OrderType,
		Quantity:       request.Quantity,
		PriceCents:     request.PriceCents,
		LastPriceCents: request.LastPriceCents,
		LimitUpCents:   request.LimitUpCents,
		LimitDownCents: request.LimitDownCents,
	}, account, positionMap)
	now := time.Now().UTC()
	order := domain.Order{
		ID:            id.New("ord"),
		ClientOrderID: request.ClientOrderID,
		DeploymentID:  deployment.ID,
		AccountID:     request.AccountID,
		Symbol:        request.Symbol,
		Side:          request.Side,
		OrderType:     request.OrderType,
		Quantity:      request.Quantity,
		PriceCents:    request.PriceCents,
		Status:        domain.OrderAccepted,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if len(violations) > 0 {
		order.Status = domain.OrderRejected
		order.RejectReason = "risk_rejected"
		_ = s.store.CreateOrder(r.Context(), order)
		s.audit(r, "order.rejected", "order", order.ID, order.ClientOrderID)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": errorBody{Code: "risk_rejected", Message: "order rejected by risk", Details: violations},
			"order": order,
		})
		return
	}
	if err := s.store.CreateOrder(r.Context(), order); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "order.accepted", "order", order.ID, order.ClientOrderID)
	writeJSON(w, http.StatusCreated, order)
}

func (s *Server) listOrders(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListOrders(r.Context(), r.URL.Query().Get("deployment_id"), r.URL.Query().Get("account_id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) listPositions(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListPositions(r.Context(), r.URL.Query().Get("account_id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAccounts(r.Context())
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) getRiskRules(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.risk.Limits())
}

func (s *Server) listAuditLogs(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > 500 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 500", nil)
			return
		}
		limit = parsed
	}
	items, err := s.store.ListAudit(r.Context(), limit)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func (s *Server) listGateways(w http.ResponseWriter, r *http.Request) {
	health := s.gateway.Health(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"items": []any{health}, "count": 1})
}
