import { useMemo, useState } from "react";
import { api, type AuditEvent, type DataOverview, type GatewayHealth, type Health, type Meta } from "../api";
import { Badge, ErrorBlock, PageHeader, Panel, Segmented, Spinner, Stat } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import { formatDateTime, formatNumber, relativeTime, shortId } from "../lib/format";

const ACTION_FILTERS = [
  { value: "all", label: "全部" },
  { value: "order", label: "订单" },
  { value: "strategy", label: "策略" },
  { value: "backtest", label: "回测" },
  { value: "deployment", label: "部署" },
];

export function MonitoringPage() {
  const { token } = useRefresh();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const state = useAsync<{
    health: Health;
    meta: Meta;
    gateways: GatewayHealth[];
    audits: AuditEvent[];
    data: DataOverview;
    latency: number;
  }>(async () => {
    const started = performance.now();
    const health = await api.health();
    const latency = Math.round(performance.now() - started);
    const [meta, gateways, audits, data] = await Promise.all([
      api.meta(),
      api.gateways(),
      api.auditLogs(200),
      api.dataOverview(),
    ]);
    return { health, meta, gateways: gateways.items, audits: audits.items, data, latency };
  }, [], token);

  const audits = useMemo(() => {
    const items = state.data?.audits ?? [];
    const keyword = search.trim().toLowerCase();
    return items.filter((event) => {
      if (filter !== "all" && !event.action.startsWith(filter)) return false;
      if (!keyword) return true;
      return (
        event.action.toLowerCase().includes(keyword) ||
        event.actor.toLowerCase().includes(keyword) ||
        event.resource_id.toLowerCase().includes(keyword) ||
        (event.detail ?? "").toLowerCase().includes(keyword)
      );
    });
  }, [state.data, filter, search]);

  if (state.loading && !state.data) return <Spinner label="加载系统监控" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { health, meta, gateways, data, latency } = state.data;
  const latest = data.snapshots?.[0];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Observability"
        title="监控与审计"
        description="控制面健康、执行网关、数据新鲜度和全量审计事件。所有写操作都会在这里留下不可变记录。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={state.reload}>
            <Icon name="refresh" size={16} /> 刷新
          </button>
        }
      />

      <section className="grid-4">
        <Stat label="API 状态" value={health.status.toUpperCase()} hint={`${health.service} · ${latency} ms`} icon="server" accent="green" />
        <Stat label="环境" value={meta.environment} hint={`API ${meta.api_version} · ${formatDateTime(meta.now)}`} icon="activity" accent="blue" />
        <Stat label="执行网关" value={`${gateways.filter((item) => item.status === "ok").length} / ${gateways.length}`} hint={gateways[0]?.name ?? "-"} icon="deployment" accent="violet" />
        <Stat label="审计事件" value={formatNumber(state.data.audits.length)} hint="最近 200 条" icon="audit" accent="amber" />
      </section>

      <section className="grid-3">
        {gateways.map((gateway) => (
          <article key={gateway.name} className="gateway-card">
            <div className="gateway-card-head">
              <span className={`status-dot status-${gateway.status === "ok" ? "ok" : "down"}`} />
              <div><strong>{gateway.name}</strong><small>BrokerGateway</small></div>
              <Badge value={gateway.status} />
            </div>
            <div className="gateway-card-meta">
              <div><span>延迟</span><b>{gateway.latency_ms} ms</b></div>
              <div><span>检查时间</span><b>{formatDateTime(gateway.checked_at)}</b></div>
            </div>
            <p className="panel-footnote">当前为 Mock 网关：订单受理后不会发送到真实券商，实盘接入需要 QMT/miniQMT sidecar。</p>
          </article>
        ))}

        <article className="gateway-card">
          <div className="gateway-card-head">
            <span className={`status-dot status-${data.available ? "ok" : "down"}`} />
            <div><strong>行情数据</strong><small>market data pipeline</small></div>
            <Badge value={data.available ? "ok" : "down"} />
          </div>
          <div className="gateway-card-meta">
            <div><span>最新交易日</span><b>{data.quotes?.trade_date ?? "-"}</b></div>
            <div><span>证券数</span><b>{formatNumber(data.quotes?.count ?? 0)}</b></div>
            <div><span>导出时间</span><b>{relativeTime(data.generated_at)}</b></div>
          </div>
          <p className="panel-footnote">Windows 计划任务每天 17:30 增量采集、落库并刷新控制台 JSON。</p>
        </article>

        <article className="gateway-card">
          <div className="gateway-card-head">
            <span className="status-dot status-ok" />
            <div><strong>回测 Worker</strong><small>python worker container</small></div>
            <Badge value="running" label="运行中" />
          </div>
          <div className="gateway-card-meta">
            <div><span>轮询</span><b>5s</b></div>
            <div><span>状态</span><b>queued → succeeded</b></div>
          </div>
          <p className="panel-footnote">Worker 认领 queued 任务，读取 _series.json 真实日线执行回测，回写净值曲线、绩效指标与运行日志。</p>
        </article>
      </section>

      <Panel
        title="审计日志"
        subtitle="按动作前缀筛选，支持 actor / resource / detail 搜索"
        actions={
          <div className="toolbar-inline">
            <Segmented value={filter} options={ACTION_FILTERS} onChange={setFilter} />
            <div className="inline-search">
              <Icon name="search" size={15} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 actor / 资源 / 详情" />
            </div>
          </div>
        }
        flush
      >
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>时间</th><th>动作</th><th>资源</th><th>资源 ID</th><th>操作者</th><th>详情</th></tr></thead>
            <tbody>
              {audits.length ? audits.map((event) => (
                <tr key={event.id}>
                  <td className="muted">{formatDateTime(event.created_at)}<span className="cell-sub">{relativeTime(event.created_at)}</span></td>
                  <td><span className="code-chip">{event.action}</span></td>
                  <td>{event.resource_type}</td>
                  <td className="mono">{shortId(event.resource_id, 24)}</td>
                  <td>{event.actor}</td>
                  <td className="muted">{event.detail ?? "-"}</td>
                </tr>
              )) : <tr><td colSpan={6} className="empty">没有符合条件的审计事件</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="数据管道" subtitle="采集 → 原始落地 → 标准化 → 质量校验 → 快照">
          <dl className="info-list">
            <div><dt>最新快照</dt><dd className="mono">{latest ? shortId(latest.snapshot_id, 30) : "-"}</dd></div>
            <div><dt>数据集</dt><dd>{latest ? `${latest.dataset}${latest.interval ? ` / ${latest.interval}m` : ""}` : "-"}</dd></div>
            <div><dt>覆盖区间</dt><dd className="mono">{latest ? `${latest.start} → ${latest.end}` : "-"}</dd></div>
            <div><dt>行数 / 标的</dt><dd>{latest ? `${formatNumber(latest.rows)} / ${formatNumber(latest.symbols)}` : "-"}</dd></div>
            <div><dt>来源 / 复权</dt><dd>{latest ? `${latest.source} · ${latest.adjust}` : "-"}</dd></div>
            <div><dt>质量</dt><dd>{latest ? `${latest.quality.blockers} 阻塞 · ${latest.quality.warnings} 警告` : "-"}</dd></div>
          </dl>
        </Panel>

        <Panel title="控制面接口" subtitle="Go API v1">
          <div className="endpoint-list">
            {[
              ["GET", "/healthz", "存活探针"],
              ["GET", "/api/v1/meta", "版本与环境"],
              ["GET", "/api/v1/strategies", "策略与版本"],
              ["GET", "/api/v1/backtests", "回测任务"],
              ["GET", "/api/v1/live-deployments", "部署状态机"],
              ["GET", "/api/v1/orders", "订单与风控"],
              ["GET", "/api/v1/data/overview", "数据目录"],
              ["GET", "/api/v1/audit-logs", "审计日志"],
            ].map(([method, path, label]) => (
              <div key={path}>
                <span className={`method method-${method.toLowerCase()}`}>{method}</span>
                <span className="mono">{path}</span>
                <span className="muted">{label}</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </div>
  );
}