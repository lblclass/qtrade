import { api, type Account, type AccountEquityPoint, type AuditEvent, type BacktestRun, type DataOverview, type GatewayHealth, type LiveDeployment, type Order, type Strategy } from "../api";
import { Donut, LineChart, Sparkline } from "../components/charts";
import { Badge, ErrorBlock, PageHeader, Panel, Progress, Spinner, Stat } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import {
  formatBPS,
  formatCNY,
  formatCompactCNY,
  formatDateTime,
  formatNumber,
  formatSignedBPS,
  relativeTime,
  shortId,
  statusMeta,
  trendClass,
} from "../lib/format";

type OverviewData = {
  strategies: Strategy[];
  backtests: BacktestRun[];
  deployments: LiveDeployment[];
  orders: Order[];
  accounts: Account[];
  audits: AuditEvent[];
  gateways: GatewayHealth[];
  data: DataOverview;
  equity: { points: AccountEquityPoint[]; base?: string };
};

const STATUS_COLORS: Record<string, string> = {
  draft: "#64748b",
  backtesting: "#4f8cff",
  review: "#f5b64a",
  paper: "#7c5cff",
  canary: "#e879f9",
  live: "#2dd4a7",
  paused: "#f59e0b",
  retired: "#475569",
};

export function OverviewPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { token } = useRefresh();
  const state = useAsync<OverviewData>(async () => {
    const [strategies, backtests, deployments, orders, accounts, audits, gateways, data] = await Promise.all([
      api.strategies(),
      api.backtests(),
      api.deployments(),
      api.orders(),
      api.accounts(),
      api.auditLogs(10),
      api.gateways(),
      api.dataOverview(),
    ]);
    return {
      strategies: strategies.items,
      backtests: backtests.items,
      deployments: deployments.items,
      orders: orders.items,
      accounts: accounts.items,
      audits: audits.items,
      gateways: gateways.items,
      data,
      equity: accounts.items[0]
        ? await api.accountEquity(accounts.items[0].id, 30)
        : { points: [] },
    };
  }, [], token);

  if (state.loading && !state.data) return <Spinner label="正在加载驾驶舱" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { strategies, backtests, deployments, orders, accounts, audits, gateways, data, equity } = state.data;

  const account = accounts[0];
  const liveDeployments = deployments.filter((item) => item.mode === "live");
  const running = deployments.filter((item) => item.status === "running");
  const paper = deployments.filter((item) => item.mode === "paper");
  const todayOrders = orders.filter((item) => new Date(item.created_at).toDateString() === new Date().toDateString());
  const rejected = orders.filter((item) => item.status === "rejected");
  const latestData = data.datasets?.[0];
  const pipeline = [
    {
      key: "data",
      step: "01",
      title: "数据接入",
      count: data.datasets?.length ?? 0,
      unit: "个数据集",
      hint: latestData ? `${latestData.symbols} 只 · ${latestData.end ?? "-"}` : "未配置",
      path: "/data",
      tone: data.available ? "good" : "bad",
    },
    {
      key: "strategy",
      step: "02",
      title: "策略研发",
      count: strategies.length,
      unit: "个策略",
      hint: `${strategies.filter((item) => item.status === "draft").length} 个草稿`,
      path: "/strategies",
      tone: "info",
    },
    {
      key: "backtest",
      step: "03",
      title: "回测验证",
      count: backtests.length,
      unit: "次回测",
      hint: `${backtests.filter((item) => item.status === "succeeded").length} 次成功`,
      path: "/backtests",
      tone: "info",
    },
    {
      key: "paper",
      step: "04",
      title: "模拟交易",
      count: paper.length,
      unit: "个实例",
      hint: `${paper.filter((item) => item.status === "running").length} 个运行中`,
      path: "/deployments",
      tone: "info",
    },
    {
      key: "live",
      step: "05",
      title: "实盘部署",
      count: liveDeployments.length,
      unit: "个实例",
      hint: `${liveDeployments.filter((item) => item.status === "running").length} 个运行中`,
      path: "/deployments",
      tone: "good",
    },
    {
      key: "monitor",
      step: "06",
      title: "监控审计",
      count: audits.length,
      unit: "条事件",
      hint: `${gateways.filter((item) => item.status === "ok").length}/${gateways.length} 网关正常`,
      path: "/monitoring",
      tone: "good",
    },
  ];

  const statusSegments = Object.entries(
    strategies.reduce<Record<string, number>>((accumulator, strategy) => {
      accumulator[strategy.status] = (accumulator[strategy.status] ?? 0) + 1;
      return accumulator;
    }, {}),
  ).map(([status, value]) => ({
    label: statusMeta(status).label,
    value,
    color: STATUS_COLORS[status] ?? "#64748b",
  }));

  const best = backtests
    .filter((item) => item.status === "succeeded")
    .sort((left, right) => (right.metrics?.total_return_bps ?? 0) - (left.metrics?.total_return_bps ?? 0))[0];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Quant lifecycle / control tower"
        title="全生命周期驾驶舱"
        description="从行情接入、策略研发、回测验证到模拟盘、实盘和审计，一屏掌握每个环节的真实状态。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => onNavigate("/strategies?create=1")}>
              <Icon name="plus" size={16} /> 新建策略
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onNavigate("/backtests?create=1")}>
              <Icon name="flask" size={16} /> 发起回测
            </button>
          </>
        }
      />

      <section className="pipeline">
        {pipeline.map((item) => (
          <button
            type="button"
            key={item.key}
            className="pipeline-step"
            onClick={() => onNavigate(item.path)}
          >
            <span className="pipeline-index">{item.step}</span>
            <span className={`pipeline-dot tone-${item.tone}`} />
            <span className="pipeline-title">{item.title}</span>
            <strong className="pipeline-count">
              {item.count}
              <em>{item.unit}</em>
            </strong>
            <span className="pipeline-hint">{item.hint}</span>
          </button>
        ))}
      </section>

      <section className="grid-4">
        <Stat
          label="账户权益"
          value={formatCompactCNY(account?.equity_cents ?? 0)}
          hint={account ? `${account.name} · 可用 ${formatCompactCNY(account.cash_cents)}` : "无账户"}
          icon="shield"
          accent="blue"
          onClick={() => onNavigate("/trading")}
        />
        <Stat
          label="运行中实例"
          value={`${running.length} / ${deployments.length}`}
          hint={`${paper.length} 模拟 · ${liveDeployments.length} 实盘`}
          icon="deployment"
          accent="green"
          onClick={() => onNavigate("/deployments")}
        />
        <Stat
          label="今日订单"
          value={todayOrders.length}
          hint={`累计 ${orders.length} 笔 · ${rejected.length} 笔风控拒绝`}
          icon="trade"
          accent="violet"
          onClick={() => onNavigate("/trading")}
        />
        <Stat
          label="行情最新交易日"
          value={data.quotes?.trade_date ?? "-"}
          hint={
            data.quotes
              ? `${formatNumber(data.quotes.count)} 只 · 涨 ${data.quotes.up} / 跌 ${data.quotes.down}`
              : "数据文件未挂载"
          }
          icon="database"
          accent="amber"
          onClick={() => onNavigate("/data")}
        />
      </section>

      <Panel
        title="账户每日盈亏"
        subtitle={`${account?.name ?? "账户"} · ${equity.base ?? "按当前持仓与真实收盘价回溯"}`}
        actions={<button type="button" className="link-btn" onClick={() => onNavigate("/trading")}>交易台 <Icon name="chevron" size={13} /></button>}
      >
        {equity.points.length > 1 ? (
          <>
            <div className="pnl-head">
              <strong className={trendClass(equity.points[equity.points.length - 1].pnl_bps)}>
                {formatSignedBPS(equity.points[equity.points.length - 1].pnl_bps)}
              </strong>
              <span className={`muted`}>
                最新交易日 {equity.points[equity.points.length - 1].date} · 盈亏 {formatCNY(equity.points[equity.points.length - 1].pnl_cents)}
              </span>
              <small>近 {equity.points.length} 个交易日</small>
            </div>
            <LineChart
              height={200}
              showLegend={false}
              formatValue={(value) => formatCompactCNY(value * 100)}
              series={[
                {
                  name: "账户权益",
                  color: "var(--accent)",
                  points: equity.points.map((point) => ({ label: point.date, value: point.equity_cents / 100 })),
                },
              ]}
            />
          </>
        ) : (
          <p className="muted">行情序列不足，无法还原每日盈亏</p>
        )}
      </Panel>

      <section className="grid-2">
        <Panel
          title="策略生命周期分布"
          subtitle="每个状态对应的策略数量"
          actions={<button type="button" className="link-btn" onClick={() => onNavigate("/strategies")}>全部策略 <Icon name="chevron" size={13} /></button>}
        >
          <div className="strategy-distribution">
            <Donut segments={statusSegments} centerValue={String(strategies.length)} centerLabel="策略总数" />
            <div className="distribution-list">
              {statusSegments.length ? statusSegments.map((segment) => (
                <div key={segment.label}>
                  <span className="legend-dot" style={{ background: segment.color }} />
                  <span>{segment.label}</span>
                  <div className="distribution-bar">
                    <span style={{ width: `${(segment.value / Math.max(1, strategies.length)) * 100}%`, background: segment.color }} />
                  </div>
                  <b>{segment.value}</b>
                </div>
              )) : <p className="muted">还没有策略</p>}
            </div>
          </div>
        </Panel>

        <Panel
          title="最新回测绩效"
          subtitle={best ? `${best.strategy_id} @ ${best.strategy_version}` : "还没有成功的回测"}
          actions={<button type="button" className="link-btn" onClick={() => onNavigate(best ? `/backtests/${best.id}` : "/backtests")}>查看详情 <Icon name="chevron" size={13} /></button>}
        >
          {best ? (
            <div className="perf-panel">
              <div className="perf-main">
                <span>区间收益</span>
                <strong className={trendClass(best.metrics?.total_return_bps)}>
                  {formatSignedBPS(best.metrics?.total_return_bps)}
                </strong>
                <small>基准 {formatSignedBPS(best.metrics?.benchmark_return_bps)}</small>
              </div>
              <div className="perf-spark">
                <Sparkline
                  values={(best.metrics?.equity_curve ?? []).map((point) => point.equity_cents ?? 0)}
                  color="#2dd4a7"
                  width={180}
                  height={56}
                />
                <span>净值曲线</span>
              </div>
              <div className="perf-grid">
                <div><span>夏普</span><b>{best.metrics?.sharpe?.toFixed(2) ?? "-"}</b></div>
                <div><span>最大回撤</span><b className="negative">{formatBPS(best.metrics?.max_drawdown_bps)}</b></div>
                <div><span>胜率</span><b>{formatBPS(best.metrics?.win_rate_bps)}</b></div>
                <div><span>交易笔数</span><b>{best.metrics?.trade_count ?? "-"}</b></div>
              </div>
            </div>
          ) : (
            <div className="empty-inline">
              <Icon name="flask" size={20} />
              <span>还没有回测结果，先运行一次回测。</span>
            </div>
          )}
        </Panel>
      </section>

      <section className="grid-2">
        <Panel
          title="部署实例"
          subtitle="running 状态才允许提交订单"
          actions={<button type="button" className="link-btn" onClick={() => onNavigate("/deployments")}>部署管理 <Icon name="chevron" size={13} /></button>}
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>实例</th><th>策略</th><th>模式</th><th>状态</th><th>更新时间</th></tr>
              </thead>
              <tbody>
                {deployments.length ? deployments.slice(0, 6).map((item) => (
                  <tr key={item.id} className="clickable" onClick={() => onNavigate(`/deployments?focus=${item.id}`)}>
                    <td className="mono">{shortId(item.id)}</td>
                    <td>{item.strategy_id.replace("stg_demo_", "").replaceAll("_", " ")}<span className="cell-sub">v{item.strategy_version}</span></td>
                    <td><Badge value={item.mode} label={item.mode === "live" ? "实盘" : "模拟"} /></td>
                    <td><Badge value={item.status} dot /></td>
                    <td className="muted">{relativeTime(item.updated_at)}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="empty">还没有部署实例</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="最近审计事件"
          subtitle="所有控制面动作都会留痕"
          actions={<button type="button" className="link-btn" onClick={() => onNavigate("/monitoring")}>审计日志 <Icon name="chevron" size={13} /></button>}
        >
          <ol className="timeline">
            {audits.length ? audits.slice(0, 7).map((event) => (
              <li key={event.id}>
                <span className={`timeline-dot tone-${event.action.includes("rejected") || event.action.includes("failed") ? "bad" : event.action.includes("created") || event.action.includes("queued") ? "info" : "good"}`} />
                <div>
                  <div className="timeline-head">
                    <strong>{event.action}</strong>
                    <span>{relativeTime(event.created_at)}</span>
                  </div>
                  <p>{event.resource_type} · <span className="mono">{shortId(event.resource_id, 20)}</span>{event.detail ? ` · ${event.detail}` : ""}</p>
                </div>
              </li>
            )) : <li className="muted">暂无事件</li>}
          </ol>
        </Panel>
      </section>

      <section className="grid-3">
        <Panel title="数据新鲜度" subtitle="采集 → 标准化 → 质量门禁">
          <div className="freshness">
            {data.datasets?.map((dataset) => (
              <div key={dataset.key} className="freshness-row">
                <div>
                  <strong>{dataset.label}</strong>
                  <span>{formatNumber(dataset.symbols)} 只 · {formatNumber(dataset.rows)} 行</span>
                </div>
                <div className="freshness-meta">
                  <Badge value="ok" label={dataset.end ?? "-"} tone="info" />
                  <small>{relativeTime(dataset.updated_at)}</small>
                </div>
              </div>
            )) ?? <p className="muted">行情导出未就绪</p>}
          </div>
        </Panel>
        <Panel title="数据质量" subtitle={`来源：${data.quality?.source ?? "-"}`}>
          <div className="quality-bars">
            <div>
              <span>阻塞 <b>{data.quality?.blockers ?? 0}</b></span>
              <Progress value={data.quality?.blockers ?? 0} max={data.quality?.total ?? 1} tone="red" />
            </div>
            <div>
              <span>警告 <b>{data.quality?.warnings ?? 0}</b></span>
              <Progress value={data.quality?.warnings ?? 0} max={data.quality?.total ?? 1} tone="amber" />
            </div>
          </div>
          <p className="panel-footnote">质量报告用于回测前的数据门禁，阻塞项会阻止快照发布。</p>
        </Panel>
        <Panel title="网关与交易时段" subtitle="执行链路健康度">
          <div className="gateway-list">
            {gateways.map((gateway) => (
              <div key={gateway.name}>
                <span className={`status-dot status-${gateway.status === "ok" ? "ok" : "down"}`} />
                <div>
                  <strong>{gateway.name}</strong>
                  <small>{gateway.latency_ms} ms · {formatDateTime(gateway.checked_at)}</small>
                </div>
                <Badge value={gateway.status} />
              </div>
            ))}
          </div>
          <div className="session-strip">
            <Icon name="clock" size={15} />
            <span>日盘 09:30–11:30 / 13:00–15:00</span>
            <span className="session-open">TC</span>
          </div>
        </Panel>
      </section>

      <Panel title="最近回测" subtitle="按创建时间倒序" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>任务</th><th>策略</th><th>区间</th><th>状态</th><th>区间收益</th><th>夏普</th><th>最大回撤</th><th>创建时间</th></tr>
            </thead>
            <tbody>
              {backtests.length ? backtests.slice(0, 8).map((run) => (
                <tr key={run.id} className="clickable" onClick={() => onNavigate(`/backtests/${run.id}`)}>
                  <td className="mono">{shortId(run.id, 18)}</td>
                  <td>{run.strategy_id.replace("stg_demo_", "")}<span className="cell-sub">v{run.strategy_version} · {run.frequency}</span></td>
                  <td className="mono muted">{run.start_date} → {run.end_date}</td>
                  <td><Badge value={run.status} dot /></td>
                  <td className={trendClass(run.metrics?.total_return_bps)}>{formatSignedBPS(run.metrics?.total_return_bps)}</td>
                  <td>{run.metrics?.sharpe?.toFixed(2) ?? "-"}</td>
                  <td className="negative">{formatBPS(run.metrics?.max_drawdown_bps)}</td>
                  <td className="muted">{formatDateTime(run.created_at)}</td>
                </tr>
              )) : <tr><td colSpan={8} className="empty">还没有回测任务</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}