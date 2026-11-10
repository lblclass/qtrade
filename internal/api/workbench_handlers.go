package api

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/id"
	"github.com/qtrade/qtrade/internal/marketdata"
)

type updateStrategyRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

// updateStrategy edits the editable fields of a strategy. Status is changed
// through its own endpoint so an edit can never smuggle in a lifecycle jump.
func (s *Server) updateStrategy(w http.ResponseWriter, r *http.Request) {
	strategy, err := s.store.GetStrategy(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	var request updateStrategyRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if request.Name != nil {
		name := strings.TrimSpace(*request.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "name_required", "name cannot be empty", nil)
			return
		}
		if len([]rune(name)) > 120 {
			writeError(w, http.StatusBadRequest, "name_too_long", "name must be 120 characters or fewer", nil)
			return
		}
		strategy.Name = name
	}
	if request.Description != nil {
		strategy.Description = strings.TrimSpace(*request.Description)
	}
	strategy.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateStrategy(r.Context(), strategy); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "strategy.updated", "strategy", strategy.ID, strategy.Name)
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "console",
		ResourceType: "strategy",
		ResourceID:   strategy.ID,
		Message:      "策略信息已更新：" + strategy.Name,
	})
	writeJSON(w, http.StatusOK, strategy)
}

type simulateRequest struct {
	StartDate        string         `json:"start_date"`
	EndDate          string         `json:"end_date"`
	InitialCashCents int64          `json:"initial_cash_cents"`
	Params           map[string]any `json:"params"`
	UniverseSize     int            `json:"universe_size"`
}

// simulateStrategy enqueues a backtest with sensible defaults so the console
// can offer a single "模拟运行" action from the strategy detail page.
func (s *Server) simulateStrategy(w http.ResponseWriter, r *http.Request) {
	strategy, err := s.store.GetStrategy(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	var request simulateRequest
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
			return
		}
	}
	version := latestVersion(s, r, strategy.ID)
	if version == "" {
		writeError(w, http.StatusConflict, "version_required", "publish a strategy version before simulating", nil)
		return
	}
	endDate := request.EndDate
	startDate := request.StartDate
	if endDate == "" || startDate == "" {
		series, seriesErr := s.market.Series()
		if seriesErr != nil {
			writeError(w, http.StatusServiceUnavailable, "series_unavailable", "market series export is missing", seriesErr.Error())
			return
		}
		dates := series.Benchmark.Dates
		if len(dates) == 0 {
			for _, symbol := range series.Symbols {
				dates = symbol.Dates
				break
			}
		}
		if len(dates) == 0 {
			writeError(w, http.StatusServiceUnavailable, "series_empty", "market series export has no dates", nil)
			return
		}
		if endDate == "" {
			endDate = dates[len(dates)-1]
		}
		if startDate == "" {
			index := len(dates) - 250
			if index < 0 {
				index = 0
			}
			startDate = dates[index]
			if startDate > endDate {
				startDate = endDate
			}
		}
	}
	initialCash := request.InitialCashCents
	if initialCash <= 0 {
		initialCash = 100_000_000
	}
	params := request.Params
	if params == nil {
		params = map[string]any{"lookback": 20, "top_n": 5, "rebalance_days": 10}
	}
	if _, ok := params["universe_size"]; !ok {
		size := request.UniverseSize
		if size <= 0 {
			size = 60
		}
		params["universe_size"] = size
	}
	snapshot := s.market.LatestDailySnapshot()
	if snapshot == "" {
		snapshot = "series:" + endDate
	}
	now := time.Now().UTC()
	run := domain.BacktestRun{
		ID:               id.New("bt"),
		StrategyID:       strategy.ID,
		StrategyVersion:  version,
		DataSnapshotID:   snapshot,
		StartDate:        startDate,
		EndDate:          endDate,
		InitialCashCents: initialCash,
		Benchmark:        "EQUAL_WEIGHT",
		Universe:         "TOP_LIQUIDITY",
		Frequency:        "1d",
		Params:           params,
		Status:           domain.BacktestQueued,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := s.store.CreateBacktest(r.Context(), run); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "backtest.queued", "backtest", run.ID, strategy.ID+"@"+version)
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "console",
		ResourceType: "backtest",
		ResourceID:   run.ID,
		Message:      "模拟回测已入队：" + startDate + " → " + endDate,
	})
	writeJSON(w, http.StatusAccepted, run)
}

func latestVersion(s *Server, r *http.Request, strategyID string) string {
	versions, err := s.store.ListStrategyVersions(r.Context(), strategyID)
	if err != nil || len(versions) == 0 {
		return ""
	}
	return versions[len(versions)-1].Version
}

type deployStrategyRequest struct {
	Mode            domain.DeploymentMode `json:"mode"`
	AccountID       string                `json:"account_id"`
	StrategyVersion string                `json:"strategy_version"`
}

// deployStrategy is the "上线策略" action: it moves a reviewed strategy into
// paper trading, opens an account deployment and starts it in one call.
func (s *Server) deployStrategy(w http.ResponseWriter, r *http.Request) {
	strategy, err := s.store.GetStrategy(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	var request deployStrategyRequest
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
			return
		}
	}
	if request.Mode == "" {
		request.Mode = domain.ModePaper
	}
	if request.AccountID == "" {
		request.AccountID = "acc_demo"
	}
	version := request.StrategyVersion
	if version == "" {
		version = latestVersion(s, r, strategy.ID)
	}
	if version == "" {
		writeError(w, http.StatusConflict, "version_required", "publish a strategy version before deploying", nil)
		return
	}
	if err := strategy.Transition(domain.StrategyPaper); err != nil && strategy.Status != domain.StrategyPaper && strategy.Status != domain.StrategyCanary {
		writeError(w, http.StatusConflict, "invalid_transition", err.Error(), nil)
		return
	}
	if err := s.store.UpdateStrategy(r.Context(), strategy); err != nil {
		mapStoreError(w, err)
		return
	}
	deployNow := time.Now().UTC()
	deployment := domain.LiveDeployment{
		ID:              id.New("dep"),
		StrategyID:      strategy.ID,
		StrategyVersion: version,
		Mode:            request.Mode,
		AccountID:       request.AccountID,
		Status:          domain.DeploymentCreated,
		CreatedAt:       deployNow,
		UpdatedAt:       deployNow,
	}
	if err := s.store.CreateDeployment(r.Context(), deployment); err != nil {
		mapStoreError(w, err)
		return
	}
	if err := deployment.Apply("start"); err != nil {
		writeError(w, http.StatusConflict, "invalid_transition", err.Error(), nil)
		return
	}
	if err := s.store.UpdateDeployment(r.Context(), deployment); err != nil {
		mapStoreError(w, err)
		return
	}
	s.audit(r, "deployment.created", "live_deployment", deployment.ID, string(request.Mode))
	s.audit(r, "deployment.start", "live_deployment", deployment.ID, "running")
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "console",
		ResourceType: "live_deployment",
		ResourceID:   deployment.ID,
		Message:      "策略已上线：" + strategy.Name + " @" + version + "（" + string(request.Mode) + "）",
	})
	writeJSON(w, http.StatusCreated, deployment)
}

// claimBacktest is the worker's atomic queue pop. A queued run becomes running
// exactly once; a second worker gets 409 and moves on.
func (s *Server) claimBacktest(w http.ResponseWriter, r *http.Request) {
	run, err := s.store.GetBacktest(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if run.Status != domain.BacktestQueued {
		writeError(w, http.StatusConflict, "not_queued", "backtest is not queued", nil)
		return
	}
	run.Status = domain.BacktestRunning
	run.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateBacktest(r.Context(), run); err != nil {
		mapStoreError(w, err)
		return
	}
	_ = s.store.AddLog(r.Context(), domain.LogEntry{
		Level:        domain.LogInfo,
		Source:       "worker",
		ResourceType: "backtest",
		ResourceID:   run.ID,
		Message:      "Worker 已认领任务，开始加载行情快照",
	})
	writeJSON(w, http.StatusOK, run)
}

type backtestResultRequest struct {
	Status  domain.BacktestStatus `json:"status"`
	Metrics map[string]any        `json:"metrics"`
	Logs    []struct {
		Level   domain.LogLevel `json:"level"`
		Message string          `json:"message"`
	} `json:"logs"`
}

func (s *Server) backtestResult(w http.ResponseWriter, r *http.Request) {
	run, err := s.store.GetBacktest(r.Context(), r.PathValue("id"))
	if err != nil {
		mapStoreError(w, err)
		return
	}
	if run.Status != domain.BacktestRunning {
		writeError(w, http.StatusConflict, "not_running", "backtest is not running", nil)
		return
	}
	var request backtestResultRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "invalid request body", err.Error())
		return
	}
	if request.Status != domain.BacktestSucceeded && request.Status != domain.BacktestFailed {
		writeError(w, http.StatusBadRequest, "invalid_status", "status must be succeeded or failed", nil)
		return
	}
	run.Status = request.Status
	run.Metrics = request.Metrics
	run.UpdatedAt = time.Now().UTC()
	if err := s.store.UpdateBacktest(r.Context(), run); err != nil {
		mapStoreError(w, err)
		return
	}
	for _, item := range request.Logs {
		_ = s.store.AddLog(r.Context(), domain.LogEntry{
			Level:        item.Level,
			Source:       "worker",
			ResourceType: "backtest",
			ResourceID:   run.ID,
			Message:      item.Message,
		})
	}
	s.audit(r, "backtest."+string(request.Status), "backtest", run.ID, run.StrategyID+"@"+run.StrategyVersion)
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) listLogs(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	items, err := s.store.ListLogs(r.Context(), r.URL.Query().Get("resource_type"), r.URL.Query().Get("resource_id"), limit)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// accountEquity marks the account's current positions to market against the
// exported daily closes, producing a real "每日盈亏" series.
func (s *Server) accountEquity(w http.ResponseWriter, r *http.Request) {
	accountID := r.PathValue("id")
	account, err := s.store.GetAccount(r.Context(), accountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	days := 60
	if raw := r.URL.Query().Get("days"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 500 {
			days = parsed
		}
	}
	positions, err := s.store.ListPositions(r.Context(), accountID)
	if err != nil {
		mapStoreError(w, err)
		return
	}
	series, err := s.market.Series()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"account_id": accountID,
			"available":  false,
			"reason":     "行情序列未导出，请先运行 qtrade-data export-ui",
			"points":     []domain.EquityPoint{},
		})
		return
	}
	points := buildEquitySeries(account, positions, series, days)
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id": accountID,
		"currency":   account.Currency,
		"base":       "按当前持仓与真实收盘价回溯",
		"points":     points,
		"count":      len(points),
	})
}

func buildEquitySeries(account domain.Account, positions []domain.Position, series *marketdata.Series, days int) []domain.EquityPoint {
	dateSet := map[string]struct{}{}
	lookup := make([]map[string]int64, 0, len(positions))
	for _, position := range positions {
		item, ok := series.Symbols[position.Symbol]
		if !ok {
			lookup = append(lookup, nil)
			continue
		}
		index := make(map[string]int64, len(item.Dates))
		for i, date := range item.Dates {
			if i < len(item.Close) {
				index[date] = item.Close[i]
				dateSet[date] = struct{}{}
			}
		}
		lookup = append(lookup, index)
	}
	dates := make([]string, 0, len(dateSet))
	for date := range dateSet {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	if len(dates) > days {
		dates = dates[len(dates)-days:]
	}
	points := make([]domain.EquityPoint, 0, len(dates))
	var previous int64
	lastClose := make([]int64, len(positions))
	for index := range positions {
		lastClose[index] = positions[index].MarketPriceCents
	}
	for _, date := range dates {
		var marketValue int64
		for index, position := range positions {
			if lookup[index] != nil {
				if close, ok := lookup[index][date]; ok {
					lastClose[index] = close
				}
			}
			marketValue += lastClose[index] * position.Quantity
		}
		equity := account.CashCents + marketValue
		point := domain.EquityPoint{
			Date:             date,
			EquityCents:      equity,
			MarketValueCents: marketValue,
			CashCents:        account.CashCents,
		}
		if previous > 0 {
			point.PnLCents = equity - previous
			point.PnLBPS = point.PnLCents * 10_000 / previous
		}
		previous = equity
		points = append(points, point)
	}
	return points
}
