// Package seed populates the in-memory control plane with a coherent demo
// lifecycle so the console is usable before a persistent store lands. It is
// opt-in through QTRADE_SEED_DEMO and never overwrites existing data.
package seed

import (
	"context"
	"math"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/store"
)

const demoAccountID = "acc_demo"

// Demo writes five strategies covering draft through live, two finished
// backtests, a queued run, deployments in every state, orders and positions.
func Demo(ctx context.Context, st store.Store) error {
	existing, err := st.ListStrategies(ctx)
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		return nil
	}

	now := time.Now().UTC()
	at := func(daysAgo int) time.Time { return now.Add(-time.Duration(daysAgo) * 24 * time.Hour) }

	strategies := []domain.Strategy{
		{ID: "stg_demo_momentum", Name: "沪深300 动量轮动", Description: "20 日动量打分，选取前 5 名行业龙头，每 10 个交易日调仓。", Status: domain.StrategyLive, CreatedAt: at(180), UpdatedAt: at(2)},
		{ID: "stg_demo_multifactor", Name: "中证500 行业中性多因子", Description: "价值、质量、低波动三因子等权合成，行业中性约束。", Status: domain.StrategyPaper, CreatedAt: at(120), UpdatedAt: at(5)},
		{ID: "stg_demo_smallcap", Name: "小市值择时", Description: "小市值组合叠加指数 20 日均线择时，降低回撤。", Status: domain.StrategyPaper, CreatedAt: at(90), UpdatedAt: at(8)},
		{ID: "stg_demo_rotation", Name: "行业 ETF 轮动", Description: "宽基与行业 ETF 的相对强弱轮动，等待回测结果。", Status: domain.StrategyBacktesting, CreatedAt: at(30), UpdatedAt: at(1)},
		{ID: "stg_demo_reversal", Name: "日内反转", Description: "分钟级反转信号，研究阶段，暂未通过评审。", Status: domain.StrategyReview, CreatedAt: at(14), UpdatedAt: at(3)},
		{ID: "stg_demo_etf", Name: "红利低波 ETF 配置", Description: "月度再平衡的红利低波组合，草稿。", Status: domain.StrategyDraft, CreatedAt: at(4), UpdatedAt: at(4)},
	}
	for _, strategy := range strategies {
		if err := st.CreateStrategy(ctx, strategy); err != nil {
			return err
		}
	}

	versions := []domain.StrategyVersion{
		{ID: "ver_demo_momentum_110", StrategyID: "stg_demo_momentum", Version: "1.1.0", ArtifactDigest: "sha256:6f2c1a5d9b03", PythonVersion: "3.13", CreatedAt: at(150)},
		{ID: "ver_demo_momentum_120", StrategyID: "stg_demo_momentum", Version: "1.2.0", ArtifactDigest: "sha256:81d4be7c2a90", PythonVersion: "3.13", CreatedAt: at(35)},
		{ID: "ver_demo_multifactor_200", StrategyID: "stg_demo_multifactor", Version: "2.0.0", ArtifactDigest: "sha256:ab3c90e14d27", PythonVersion: "3.13", CreatedAt: at(60)},
		{ID: "ver_demo_smallcap_031", StrategyID: "stg_demo_smallcap", Version: "0.3.1", ArtifactDigest: "sha256:c740bb1e882f", PythonVersion: "3.13", CreatedAt: at(21)},
		{ID: "ver_demo_rotation_040", StrategyID: "stg_demo_rotation", Version: "0.4.0", ArtifactDigest: "sha256:0d8e1f4a6c35", PythonVersion: "3.13", CreatedAt: at(7)},
		{ID: "ver_demo_reversal_010", StrategyID: "stg_demo_reversal", Version: "0.1.0", ArtifactDigest: "sha256:9e51d2b7aa14", PythonVersion: "3.13", CreatedAt: at(12)},
	}
	for _, version := range versions {
		if err := st.CreateStrategyVersion(ctx, version); err != nil {
			return err
		}
	}

	backtests := []domain.BacktestRun{
		{
			ID: "bt_demo_momentum", StrategyID: "stg_demo_momentum", StrategyVersion: "1.2.0",
			DataSnapshotID: "snap_20261109T025429_f3be5a", StartDate: "2024-01-02", EndDate: "2026-10-31",
			InitialCashCents: 100_000_000, Benchmark: "000300.SH", Universe: "000300.SH", Frequency: "1d",
			Params: map[string]any{"lookback": 20, "top_n": 5, "rebalance_days": 10},
			Status: domain.BacktestSucceeded,
			Metrics: map[string]any{
				"total_return_bps": 4860, "annualized_return_bps": 1720, "benchmark_return_bps": 2210,
				"alpha_bps": 2650, "max_drawdown_bps": 1280, "sharpe": 1.62, "sortino": 2.18,
				"calmar": 1.34, "win_rate_bps": 5840, "turnover_bps": 3200, "trade_count": 218,
				"volatility_bps":  1840,
				"equity_curve":    curve(100_000_000, 148, 210, 0.030, 0.6),
				"benchmark_curve": curve(100_000_000, 122, 210, 0.018, 1.9),
			},
			CreatedAt: at(9), UpdatedAt: at(9),
		},
		{
			ID: "bt_demo_multifactor", StrategyID: "stg_demo_multifactor", StrategyVersion: "2.0.0",
			DataSnapshotID: "snap_20261109T025429_f3be5a", StartDate: "2024-01-02", EndDate: "2026-10-31",
			InitialCashCents: 100_000_000, Benchmark: "000905.SH", Universe: "000905.SH", Frequency: "1d",
			Params: map[string]any{"lookback": 60, "top_n": 30, "rebalance_days": 20, "industry_neutral": true},
			Status: domain.BacktestSucceeded,
			Metrics: map[string]any{
				"total_return_bps": 3210, "annualized_return_bps": 1180, "benchmark_return_bps": 1440,
				"alpha_bps": 1770, "max_drawdown_bps": 940, "sharpe": 1.41, "sortino": 1.83,
				"calmar": 1.26, "win_rate_bps": 5610, "turnover_bps": 2100, "trade_count": 164,
				"volatility_bps":  1420,
				"equity_curve":    curve(100_000_000, 132, 210, 0.022, 1.2),
				"benchmark_curve": curve(100_000_000, 114, 210, 0.016, 2.4),
			},
			CreatedAt: at(6), UpdatedAt: at(6),
		},
		{
			ID: "bt_demo_smallcap", StrategyID: "stg_demo_smallcap", StrategyVersion: "0.3.1",
			DataSnapshotID: "snap_20261109T025429_f3be5a", StartDate: "2024-01-02", EndDate: "2025-12-31",
			InitialCashCents: 50_000_000, Benchmark: "000852.SH", Universe: "000852.SH", Frequency: "1d",
			Params: map[string]any{"lookback": 20, "top_n": 20, "rebalance_days": 20, "timing": "ma20"},
			Status: domain.BacktestSucceeded,
			Metrics: map[string]any{
				"total_return_bps": 2740, "annualized_return_bps": 1360, "benchmark_return_bps": 1980,
				"alpha_bps": 760, "max_drawdown_bps": 1510, "sharpe": 1.12, "sortino": 1.39,
				"calmar": 0.90, "win_rate_bps": 5380, "turnover_bps": 4300, "trade_count": 302,
				"volatility_bps":  2260,
				"equity_curve":    curve(50_000_000, 63, 105, 0.035, 2.1),
				"benchmark_curve": curve(50_000_000, 60, 105, 0.030, 0.2),
			},
			CreatedAt: at(20), UpdatedAt: at(20),
		},
		{
			ID: "bt_demo_rotation", StrategyID: "stg_demo_rotation", StrategyVersion: "0.4.0",
			DataSnapshotID: "snap_20261109T025559_b74ba7", StartDate: "2025-01-02", EndDate: "2026-10-31",
			InitialCashCents: 50_000_000, Benchmark: "000300.SH", Universe: "ETF_POOL", Frequency: "1d",
			Params: map[string]any{"lookback": 40, "top_n": 3, "rebalance_days": 5},
			Status: domain.BacktestQueued, Metrics: map[string]any{},
			CreatedAt: at(1), UpdatedAt: at(1),
		},
		{
			ID: "bt_demo_reversal", StrategyID: "stg_demo_reversal", StrategyVersion: "0.1.0",
			DataSnapshotID: "snap_20261109T031937_1029ea", StartDate: "2026-09-01", EndDate: "2026-10-31",
			InitialCashCents: 20_000_000, Benchmark: "000300.SH", Universe: "000300.SH", Frequency: "1m",
			Params:    map[string]any{"window": 15, "threshold_bps": 35},
			Status:    domain.BacktestFailed,
			Metrics:   map[string]any{"error": "分钟快照仅覆盖当日，历史窗口不足，无法完成回测"},
			CreatedAt: at(3), UpdatedAt: at(3),
		},
	}
	for _, run := range backtests {
		if err := st.CreateBacktest(ctx, run); err != nil {
			return err
		}
	}

	deployments := []domain.LiveDeployment{
		{ID: "dep_demo_momentum_live", StrategyID: "stg_demo_momentum", StrategyVersion: "1.2.0", Mode: domain.ModeLive, AccountID: demoAccountID, Status: domain.DeploymentRunning, CreatedAt: at(30), UpdatedAt: at(1)},
		{ID: "dep_demo_multifactor_paper", StrategyID: "stg_demo_multifactor", StrategyVersion: "2.0.0", Mode: domain.ModePaper, AccountID: demoAccountID, Status: domain.DeploymentRunning, CreatedAt: at(18), UpdatedAt: at(2)},
		{ID: "dep_demo_smallcap_paper", StrategyID: "stg_demo_smallcap", StrategyVersion: "0.3.1", Mode: domain.ModePaper, AccountID: demoAccountID, Status: domain.DeploymentPaused, CreatedAt: at(15), UpdatedAt: at(4)},
		{ID: "dep_demo_momentum_old", StrategyID: "stg_demo_momentum", StrategyVersion: "1.1.0", Mode: domain.ModeLive, AccountID: demoAccountID, Status: domain.DeploymentStopped, LastError: "券商网关心跳超时，已触发强杀", CreatedAt: at(120), UpdatedAt: at(90)},
		{ID: "dep_demo_reversal_created", StrategyID: "stg_demo_reversal", StrategyVersion: "0.1.0", Mode: domain.ModePaper, AccountID: demoAccountID, Status: domain.DeploymentCreated, CreatedAt: at(2), UpdatedAt: at(2)},
	}
	for _, deployment := range deployments {
		if err := st.CreateDeployment(ctx, deployment); err != nil {
			return err
		}
	}

	positions := []domain.Position{
		{AccountID: demoAccountID, Symbol: "600519.SH", Quantity: 100, AvailableQuantity: 100, AvgCostCents: 165_000, MarketPriceCents: 168_200},
		{AccountID: demoAccountID, Symbol: "000858.SZ", Quantity: 1000, AvailableQuantity: 1000, AvgCostCents: 13_550, MarketPriceCents: 13_920},
		{AccountID: demoAccountID, Symbol: "300750.SZ", Quantity: 500, AvailableQuantity: 500, AvgCostCents: 18_240, MarketPriceCents: 18_610},
	}
	if err := st.ReplacePositions(ctx, demoAccountID, positions); err != nil {
		return err
	}
	account := domain.Account{
		ID: demoAccountID, Name: "Demo account", Currency: "CNY",
		CashCents: 61_240_000, EquityCents: 101_285_000,
	}
	if err := st.UpdateAccount(ctx, account); err != nil {
		return err
	}

	orders := []domain.Order{
		{ID: "ord_demo_0001", ClientOrderID: "web-demo-0001", DeploymentID: "dep_demo_momentum_live", AccountID: demoAccountID, Symbol: "600519.SH", Side: domain.SideBuy, OrderType: domain.OrderLimit, Quantity: 100, FilledQuantity: 100, PriceCents: 168_200, Status: domain.OrderFilled, CreatedAt: at(5), UpdatedAt: at(5)},
		{ID: "ord_demo_0002", ClientOrderID: "web-demo-0002", DeploymentID: "dep_demo_momentum_live", AccountID: demoAccountID, Symbol: "000858.SZ", Side: domain.SideBuy, OrderType: domain.OrderLimit, Quantity: 1000, FilledQuantity: 1000, PriceCents: 13_550, Status: domain.OrderFilled, CreatedAt: at(5), UpdatedAt: at(5)},
		{ID: "ord_demo_0003", ClientOrderID: "web-demo-0003", DeploymentID: "dep_demo_multifactor_paper", AccountID: demoAccountID, Symbol: "601318.SH", Side: domain.SideBuy, OrderType: domain.OrderLimit, Quantity: 1000, FilledQuantity: 400, PriceCents: 4_520, Status: domain.OrderPartiallyFilled, CreatedAt: at(1), UpdatedAt: at(1)},
		{ID: "ord_demo_0004", ClientOrderID: "web-demo-0004", DeploymentID: "dep_demo_multifactor_paper", AccountID: demoAccountID, Symbol: "300750.SZ", Side: domain.SideBuy, OrderType: domain.OrderLimit, Quantity: 500, FilledQuantity: 0, PriceCents: 18_610, Status: domain.OrderAccepted, CreatedAt: at(1), UpdatedAt: at(1)},
		{ID: "ord_demo_0005", ClientOrderID: "web-demo-0005", DeploymentID: "dep_demo_momentum_live", AccountID: demoAccountID, Symbol: "600519.SH", Side: domain.SideSell, OrderType: domain.OrderLimit, Quantity: 100, FilledQuantity: 0, PriceCents: 170_000, Status: domain.OrderCanceled, CreatedAt: at(3), UpdatedAt: at(3)},
		{ID: "ord_demo_0006", ClientOrderID: "web-demo-0006", DeploymentID: "dep_demo_momentum_live", AccountID: demoAccountID, Symbol: "000001.SZ", Side: domain.SideSell, OrderType: domain.OrderMarket, Quantity: 1000, PriceCents: 1_150, Status: domain.OrderRejected, RejectReason: "risk_rejected", CreatedAt: at(2), UpdatedAt: at(2)},
	}
	for _, order := range orders {
		if err := st.CreateOrder(ctx, order); err != nil {
			return err
		}
	}

	events := []struct {
		action, resourceType, resourceID, detail string
		daysAgo                                  int
	}{
		{"strategy.created", "strategy", "stg_demo_momentum", "沪深300 动量轮动", 180},
		{"strategy.version_created", "strategy_version", "ver_demo_momentum_120", "stg_demo_momentum@1.2.0", 35},
		{"backtest.queued", "backtest", "bt_demo_momentum", "stg_demo_momentum@1.2.0", 9},
		{"backtest.succeeded", "backtest", "bt_demo_momentum", "total_return=48.60% sharpe=1.62", 9},
		{"deployment.created", "live_deployment", "dep_demo_momentum_live", "live", 30},
		{"deployment.start", "live_deployment", "dep_demo_momentum_live", "running", 30},
		{"order.rejected", "order", "ord_demo_0006", "risk_rejected", 2},
		{"order.accepted", "order", "ord_demo_0004", "web-demo-0004", 1},
		{"backtest.queued", "backtest", "bt_demo_rotation", "stg_demo_rotation@0.4.0", 1},
		{"deployment.pause", "live_deployment", "dep_demo_smallcap_paper", "paused", 4},
	}
	for _, event := range events {
		if err := st.AddAudit(ctx, domain.AuditEvent{
			Actor:        "demo-seed",
			Action:       event.action,
			ResourceType: event.resourceType,
			ResourceID:   event.resourceID,
			Detail:       event.detail,
			CreatedAt:    at(event.daysAgo),
		}); err != nil {
			return err
		}
	}
	logs := []struct {
		level        domain.LogLevel
		source       string
		resourceType string
		resourceID   string
		message      string
		minutesAgo   int
	}{
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "09:15 盘前：同步证券主数据，校验 5 只持仓的涨跌停价", 2 * 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "09:25 集合竞价：加载 20 日动量因子，目标组合 5 只", 2 * 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "09:30 开盘：目标组合与当前持仓偏离 2.4%，生成 3 笔调仓指令", 2 * 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "09:31 下单：买入 601318.SH 1000 股 @ ¥45.20（1/3）", 2 * 24 * 60},
		{domain.LogWarn, "runner", "live_deployment", "dep_demo_momentum_live", "11:30 午间：000858.SZ 仅成交 400/1000 股，按剩余量顺延至下午", 2 * 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "15:00 收盘：当日净值 +0.62%，组合回撤 0.18%", 2 * 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "15:05 日终对账：本地持仓与券商回报一致，差异 0 笔", 2 * 24 * 60},
		{domain.LogWarn, "gateway", "live_deployment", "dep_demo_momentum_live", "10:02 柜台网关延迟 820ms，超过 500ms 阈值，已降低报单频率", 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "09:15 盘前：交易日历命中，今日为正常交易日", 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_momentum_live", "15:00 收盘：当日净值 -0.21%，可用资金 61.24 万", 24 * 60},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_multifactor_paper", "09:30 模拟盘：多因子打分完成，Top 20 组合换手 8%", 30},
		{domain.LogInfo, "runner", "live_deployment", "dep_demo_multifactor_paper", "15:00 模拟盘：成交 2 笔，浮盈 +0.34%", 30},
		{domain.LogError, "gateway", "live_deployment", "dep_demo_momentum_old", "券商网关心跳超时 3 次，触发降级并停止报单", 90 * 24 * 60},
		{domain.LogInfo, "worker", "backtest", "bt_demo_momentum", "加载快照 snap_20261109T025429，日线 8,182,541 行", 9 * 24 * 60},
		{domain.LogInfo, "worker", "backtest", "bt_demo_momentum", "运行动量策略：lookback=20 top_n=5 rebalance=10d", 9 * 24 * 60},
		{domain.LogInfo, "worker", "backtest", "bt_demo_momentum", "回测完成：218 笔成交，总收益 48.60%，最大回撤 12.80%", 9 * 24 * 60},
		{domain.LogWarn, "worker", "backtest", "bt_demo_turnover", "覆盖率不足：1,412 只标的缺少回测区间内数据，已剔除", 6 * 24 * 60},
		{domain.LogError, "worker", "backtest", "bt_demo_turnover", "回测失败：快照缺少 2022-01-04 的行情，任务标记 failed", 6 * 24 * 60},
	}
	for _, entry := range logs {
		if err := st.AddLog(ctx, domain.LogEntry{
			Level:        entry.level,
			Source:       entry.source,
			ResourceType: entry.resourceType,
			ResourceID:   entry.resourceID,
			Message:      entry.message,
			CreatedAt:    at(0).Add(-time.Duration(entry.minutesAgo) * time.Minute),
		}); err != nil {
			return err
		}
	}
	return nil
}

// curve builds a deterministic equity series ending at “endIndex%“ of the
// starting capital, with a sine-shaped drawdown cycle so charts look realistic.
func curve(startCents, endIndex int64, points int, amplitude, phase float64) []map[string]any {
	start := time.Date(2025, 1, 3, 15, 0, 0, 0, time.UTC)
	out := make([]map[string]any, 0, points)
	for i := 0; i < points; i++ {
		progress := float64(i) / float64(points-1)
		value := float64(startCents) * (1 + (float64(endIndex)/100.0-1)*progress)
		value += float64(startCents) * amplitude * math.Sin(float64(i)/6.2+phase)
		out = append(out, map[string]any{
			"date":         start.AddDate(0, 0, i*7).Format("2006-01-02"),
			"equity_cents": int64(value),
		})
	}
	return out
}
