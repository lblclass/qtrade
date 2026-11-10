import { useEffect, useMemo, useState } from "react";
import {
  api,
  errorMessage,
  type BacktestRun,
  type DataOverview,
  type RunLog,
  type Strategy,
  type StrategyVersion,
} from "../api";
import { LineChart } from "../components/charts";
import { Badge, EmptyState, ErrorBlock, Field, JsonBlock, KeyValue, Modal, PageHeader, Panel, Segmented, Spinner, Stat, useToast } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import {
  daysAgoISO,
  formatBPS,
  formatCNY,
  formatCompactCNY,
  formatDateTime,
  formatNumber,
  formatSignedBPS,
  relativeTime,
  shortId,
  todayISO,
  toCents,
  trendClass,
} from "../lib/format";

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "运行中" },
  { value: "succeeded", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "canceled", label: "已取消" },
];

export function BacktestsPage({
  onCreate,
  onNavigate,
}: {
  onCreate: boolean;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(onCreate);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [snapshots, setSnapshots] = useState<DataOverview["snapshots"]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [version, setVersion] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [startDate, setStartDate] = useState("2024-01-02");
  const [endDate, setEndDate] = useState(todayISO());
  const [cash, setCash] = useState("1000000");
  const [frequency, setFrequency] = useState("1d");
  const [benchmark, setBenchmark] = useState("000300.SH");
  const [universe, setUniverse] = useState("000300.SH");
  const [paramsText, setParamsText] = useState('{\n  "lookback": 20,\n  "top_n": 5,\n  "rebalance_days": 10\n}');
  const [saving, setSaving] = useState(false);

  useEffect(() => setOpen(onCreate), [onCreate]);

  const state = useAsync<BacktestRun[]>(async () => (await api.backtests()).items, [], token);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      try {
        const [strategyResponse, data] = await Promise.all([api.strategies(), api.dataOverview()]);
        if (!active) return;
        setStrategies(strategyResponse.items);
        setSnapshots((data.snapshots ?? []).filter((item) => item.dataset === "bars_1d"));
        if (!strategyId && strategyResponse.items[0]) setStrategyId(strategyResponse.items[0].id);
        if (!snapshotId && data.snapshots?.[0]) {
          const daily = (data.snapshots ?? []).find((item) => item.dataset === "bars_1d");
          if (daily) setSnapshotId(daily.snapshot_id);
        }
      } catch (error) {
        toast.push(errorMessage(error), "bad");
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!strategyId) return;
    let active = true;
    void api.versions(strategyId).then((response) => {
      if (!active) return;
      setVersions(response.items);
      setVersion(response.items[response.items.length - 1]?.version ?? "");
    }).catch((error: unknown) => toast.push(errorMessage(error), "bad"));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  const filtered = useMemo(() => {
    const items = state.data ?? [];
    return filter === "all" ? items : items.filter((item) => item.status === filter);
  }, [state.data, filter]);

  const succeeded = (state.data ?? []).filter((item) => item.status === "succeeded");
  const averageReturn = succeeded.length
    ? succeeded.reduce((sum, item) => sum + (item.metrics?.total_return_bps ?? 0), 0) / succeeded.length
    : 0;

  const submit = async () => {
    if (!strategyId || !version || !snapshotId) {
      toast.push("请选择策略、版本和数据快照", "bad");
      return;
    }
    let params: Record<string, unknown> | undefined;
    try {
      params = paramsText.trim() ? JSON.parse(paramsText) : undefined;
    } catch {
      toast.push("参数不是合法 JSON", "bad");
      return;
    }
    setSaving(true);
    try {
      const run = await api.createBacktest({
        strategy_id: strategyId,
        strategy_version: version,
        data_snapshot_id: snapshotId,
        start_date: startDate,
        end_date: endDate,
        initial_cash_cents: toCents(Number(cash) || 0),
        benchmark,
        universe,
        frequency,
        params,
      });
      toast.push("回测任务已入队", "good");
      setOpen(false);
      state.reload();
      onNavigate(`/backtests/${run.id}`);
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Research & backtesting"
        title="回测中心"
        description="以不可变数据快照驱动事件回测，记录收益、回撤、夏普、换手和逐笔成交。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            <Icon name="flask" size={16} /> 新建回测
          </button>
        }
      />

      <section className="grid-4">
        <Stat label="回测任务" value={(state.data ?? []).length} hint={`${succeeded.length} 次成功`} icon="backtest" accent="blue" />
        <Stat label="平均区间收益" value={formatSignedBPS(averageReturn)} hint="仅统计成功任务" icon="activity" accent="green" />
        <Stat label="运行 / 排队" value={(state.data ?? []).filter((item) => item.status === "running" || item.status === "queued").length} hint="需要 Worker 消费" icon="clock" accent="amber" />
        <Stat label="失败任务" value={(state.data ?? []).filter((item) => item.status === "failed").length} hint="查看失败原因与参数" icon="alert" accent="violet" />
      </section>

      <div className="toolbar">
        <Segmented value={filter} options={FILTERS} onChange={setFilter} />
        <span className="muted">{filtered.length} 条任务</span>
      </div>

      {state.loading && !state.data ? <Spinner label="加载回测任务" /> : null}
      {state.error ? <ErrorBlock message={state.error} onRetry={state.reload} /> : null}

      <Panel title="回测任务" subtitle="点击任务查看净值曲线、指标与参数" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>任务</th><th>策略 / 版本</th><th>数据快照</th><th>区间</th><th>状态</th><th className="right">收益</th><th className="right">夏普</th><th className="right">回撤</th><th>创建</th></tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((run) => (
                <tr key={run.id} className="clickable" onClick={() => onNavigate(`/backtests/${run.id}`)}>
                  <td className="mono">{shortId(run.id, 18)}</td>
                  <td>
                    <div className="cell-title">{run.strategy_id.replace("stg_demo_", "").replaceAll("_", " ")}</div>
                    <div className="cell-sub">v{run.strategy_version} · {run.frequency}</div>
                  </td>
                  <td className="mono muted">{shortId(run.data_snapshot_id, 18)}</td>
                  <td className="mono muted">{run.start_date} → {run.end_date}</td>
                  <td><Badge value={run.status} dot /></td>
                  <td className={`right mono ${trendClass(run.metrics?.total_return_bps)}`}>{formatSignedBPS(run.metrics?.total_return_bps)}</td>
                  <td className="right mono">{run.metrics?.sharpe?.toFixed(2) ?? "-"}</td>
                  <td className="right mono negative">{formatBPS(run.metrics?.max_drawdown_bps)}</td>
                  <td className="muted">{relativeTime(run.created_at)}</td>
                </tr>
              )) : <tr><td colSpan={9} className="empty">没有符合条件的任务</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Modal
        open={open}
        title="新建回测"
        subtitle="选择策略版本与数据快照；任务会以 queued 状态进入队列。"
        onClose={() => setOpen(false)}
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
              {saving ? "提交中…" : "提交回测"}
            </button>
          </>
        }
      >
        <div className="form-grid two">
          <Field label="策略" required>
            <select className="select" value={strategyId} onChange={(event) => setStrategyId(event.target.value)}>
              <option value="">选择策略</option>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
            </select>
          </Field>
          <Field label="版本" required>
            <select className="select" value={version} onChange={(event) => setVersion(event.target.value)}>
              <option value="">选择版本</option>
              {versions.map((item) => <option key={item.id} value={item.version}>v{item.version} · {item.python_version}</option>)}
            </select>
          </Field>
          <Field label="数据快照" required hint="来自已发布的日线 Parquet 快照">
            <select className="select" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>
              <option value="">选择快照</option>
              {snapshots?.map((snapshot) => (
                <option key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
                  {snapshot.snapshot_id} · {snapshot.start} → {snapshot.end}
                </option>
              ))}
            </select>
          </Field>
          <Field label="回测频率">
            <select className="select" value={frequency} onChange={(event) => setFrequency(event.target.value)}>
              <option value="1d">日线 1d</option>
              <option value="1m">分钟 1m</option>
              <option value="5m">分钟 5m</option>
            </select>
          </Field>
          <Field label="开始日期" required>
            <input className="input" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </Field>
          <Field label="结束日期" required>
            <input className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </Field>
          <Field label="初始资金（元）" required>
            <input className="input mono" type="number" min={0} step={10000} value={cash} onChange={(event) => setCash(event.target.value)} />
          </Field>
          <Field label="基准">
            <input className="input mono" value={benchmark} onChange={(event) => setBenchmark(event.target.value)} />
          </Field>
          <Field label="股票池">
            <input className="input mono" value={universe} onChange={(event) => setUniverse(event.target.value)} />
          </Field>
          <Field label="策略参数 (JSON)" hint="会原样写入回测任务的 params">
            <textarea className="textarea mono" rows={5} value={paramsText} onChange={(event) => setParamsText(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

export function BacktestDetailPage({
  backtestId,
  onNavigate,
}: {
  backtestId: string;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const state = useAsync<{ run: BacktestRun; strategy: Strategy | null; logs: RunLog[] }>(async () => {
    const run = await api.backtest(backtestId);
    let strategy: Strategy | null = null;
    try {
      strategy = await api.strategy(run.strategy_id);
    } catch {
      strategy = null;
    }
    const logs = await api.logs({ resource_type: "backtest", resource_id: backtestId, limit: 30 });
    return { run, strategy, logs: logs.items };
  }, [backtestId], token);

  const liveStatus = state.data?.run.status;
  useEffect(() => {
    if (liveStatus !== "queued" && liveStatus !== "running") return;
    const timer = window.setInterval(() => state.reload(), 3000);
    return () => window.clearInterval(timer);
  }, [liveStatus]);

  if (state.loading && !state.data) return <Spinner label="加载回测详情" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { run, strategy, logs } = state.data;
  const metrics = run.metrics ?? {};
  const equity = (metrics.equity_curve ?? []).map((point) => ({ label: point.date, value: point.equity_cents ?? 0 }));
  const benchmarkSeries = (metrics.benchmark_curve ?? []).map((point) => ({ label: point.date, value: point.benchmark_cents ?? point.equity_cents ?? 0 }));
  const drawdown: { label: string; value: number }[] = [];
  let peak = 0;
  for (const point of equity) {
    peak = Math.max(peak, point.value);
    drawdown.push({ label: point.label, value: peak > 0 ? -((peak - point.value) / peak) * 10_000 : 0 });
  }

  const cancel = async () => {
    setBusy(true);
    try {
      await api.cancelBacktest(run.id);
      toast.push("回测任务已取消", "good");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => onNavigate("/backtests")}>
        <Icon name="chevron" size={14} /> 返回回测中心
      </button>
      <PageHeader
        eyebrow={run.id}
        title={strategy?.name ?? run.strategy_id}
        description={`${run.strategy_id} @ v${run.strategy_version} · ${run.start_date} → ${run.end_date} · ${run.frequency}`}
        actions={
          <>
            <Badge value={run.status} dot />
            {run.status === "queued" || run.status === "running" ? (
              <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy}>
                <Icon name="stop" size={15} /> {busy ? "取消中…" : "取消任务"}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={() => onNavigate("/backtests?create=1")}>
              <Icon name="plus" size={15} /> 再跑一次
            </button>
          </>
        }
      />

      {metrics.error ? (
        <div className="banner banner-bad">
          <Icon name="alert" size={17} />
          <div><strong>回测失败</strong><p>{String(metrics.error)}</p></div>
        </div>
      ) : null}

      {equity.length ? (
        <>
          <Panel
            title="净值曲线"
            subtitle={`初始资金 ${formatCNY(run.initial_cash_cents)} · 基准 ${String(metrics.benchmark_label ?? run.benchmark)}`}
            actions={<span className={`badge badge-${metrics.total_return_bps && metrics.total_return_bps > 0 ? "good" : "neutral"}`}>{formatSignedBPS(metrics.total_return_bps)}</span>}
          >
            <LineChart
              series={[
                { name: "策略净值", color: "#4f8cff", points: equity },
                ...(benchmarkSeries.length ? [{ name: "基准", color: "#8b9bb0", points: benchmarkSeries }] : []),
              ]}
              formatValue={(value) => formatCompactCNY(value)}
              height={300}
            />
          </Panel>

          <section className="grid-4">
            <Stat label="区间收益" value={formatSignedBPS(metrics.total_return_bps)} hint={`年化 ${formatSignedBPS(metrics.annualized_return_bps)}`} accent="blue" />
            <Stat label="最大回撤" value={formatBPS(metrics.max_drawdown_bps)} hint={`Calmar ${metrics.calmar?.toFixed(2) ?? "-"}`} accent="amber" />
            <Stat label="夏普比率" value={metrics.sharpe?.toFixed(2) ?? "-"} hint={`Sortino ${metrics.sortino?.toFixed(2) ?? "-"}`} accent="green" />
            <Stat label="胜率 / 交易" value={formatBPS(metrics.win_rate_bps)} hint={`${metrics.trade_count ?? "-"} 笔 · 换手 ${formatBPS(metrics.turnover_bps)}`} accent="violet" />
          </section>

          <Panel title="回撤曲线" subtitle="从历史净值高点回落的幅度">
            <LineChart
              series={[{ name: "回撤", color: "#ff6b81", points: drawdown }]}
              formatValue={(value) => `${(value / 100).toFixed(1)}%`}
              height={190}
              showLegend={false}
            />
          </Panel>
        </>
      ) : (
        <Panel title="回测结果">
          <EmptyState
            icon="flask"
            title={run.status === "queued" ? "任务已入队，等待 Worker 执行" : run.status === "running" ? "回测运行中" : "暂无绩效数据"}
            description={
              run.status === "queued"
                ? "Go 已把任务写入队列，Worker 每 5 秒轮询一次，认领后会读取真实日线快照并回写净值曲线，页面会自动刷新。"
                : "任务没有返回净值序列，请检查数据快照与参数。"
            }
            action={<button type="button" className="btn btn-ghost" onClick={() => onNavigate("/backtests?create=1")}>重新创建任务</button>}
          />
        </Panel>
      )}

      <section className="grid-2">
        <Panel title="回测配置">
          <KeyValue
            items={[
              { label: "任务 ID", value: <span className="mono">{run.id}</span> },
              { label: "策略", value: strategy ? <button type="button" className="link-btn" onClick={() => onNavigate(`/strategies/${run.strategy_id}`)}>{strategy.name}</button> : run.strategy_id },
              { label: "版本", value: `v${run.strategy_version}` },
              { label: "数据快照", value: <span className="mono">{run.data_snapshot_id}</span> },
              { label: "初始资金", value: formatCNY(run.initial_cash_cents) },
              { label: "基准 / 股票池", value: `${String(metrics.benchmark_label ?? run.benchmark)} / ${run.universe}` },
              { label: "频率", value: run.frequency },
              { label: "创建 / 更新", value: `${formatDateTime(run.created_at)} · ${formatDateTime(run.updated_at)}` },
            ]}
          />
        </Panel>
        <Panel title="策略参数" subtitle="params">
          <JsonBlock value={run.params ?? {}} />
        </Panel>
      </section>

      <Panel title="运行日志" subtitle={`Worker 与执行器输出 · ${logs.length} 条`} flush>
        <div className="log-list">
          {logs.length ? logs.map((item) => (
            <div className="log-row" key={item.id}>
              <span className={`log-level log-${item.level}`}>{item.level.toUpperCase()}</span>
              <span className="log-time mono">{formatDateTime(item.created_at)}</span>
              <span className="log-source">{item.source}</span>
              <span className="log-message">{item.message}</span>
            </div>
          )) : <div className="empty">暂无日志</div>}
        </div>
      </Panel>

      <Panel title="完整指标" subtitle="原始 metrics 字段" flush>
        <div className="metric-grid">
          {Object.entries(metrics)
            .filter(([key]) => !key.endsWith("_curve"))
            .map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <strong>{typeof value === "number" ? formatNumber(value) : String(value)}</strong>
              </div>
            ))}
        </div>
      </Panel>
    </div>
  );
}