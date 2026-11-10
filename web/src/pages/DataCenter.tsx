import { useEffect, useState } from "react";
import { api, type DataOverview, type Instrument, type Quote } from "../api";
import { Badge, EmptyState, ErrorBlock, PageHeader, Panel, Progress, Spinner, Stat } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import {
  formatBPS,
  formatCompactCNY,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPrice,
  formatSignedBPS,
  relativeTime,
  shortId,
  trendClass,
} from "../lib/format";

export function DataCenterPage({
  initialQuery,
  onNavigate,
}: {
  initialQuery: string;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [instrumentQuery, setInstrumentQuery] = useState("");
  const [instrumentDraft, setInstrumentDraft] = useState("");

  useEffect(() => {
    setQuery(initialQuery);
    setDraft(initialQuery);
  }, [initialQuery]);

  const overview = useAsync<DataOverview>(() => api.dataOverview(), [], token);
  const quotes = useAsync<{ items: Quote[]; count: number; available: boolean }>(
    () => api.quotes({ q: query, limit: 24 }),
    [query],
    token,
  );
  const instruments = useAsync<{ items: Instrument[]; count: number; available: boolean }>(
    () => api.instruments(instrumentQuery, 30),
    [instrumentQuery],
    token,
  );

  const data = overview.data;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Data platform"
        title="数据中心"
        description="全市场行情落地、快照版本、质量门禁和证券主数据。所有数字都来自真实采集文件与 PostgreSQL。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={overview.reload}>
              <Icon name="refresh" size={16} /> 刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onNavigate("/backtests?create=1")}>
              <Icon name="flask" size={16} /> 用最新快照回测
            </button>
          </>
        }
      />

      {!data && overview.loading ? <Spinner label="读取数据目录" /> : null}
      {overview.error ? <ErrorBlock message={overview.error} onRetry={overview.reload} /> : null}
      {data && !data.available ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={17} />
          <div>
            <strong>数据导出未就绪</strong>
            <p>{data.reason ?? "请先运行 qtrade-data export-ui，并确认 API 容器挂载了 data 目录。"}</p>
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <section className="grid-4">
            <Stat label="数据集" value={data.datasets?.length ?? 0} hint={`证券主数据 ${formatNumber(data.instruments?.count ?? 0)} 只`} icon="database" accent="blue" />
            <Stat label="日线覆盖" value={formatNumber(data.datasets?.[0]?.symbols ?? 0)} hint={`${formatNumber(data.datasets?.[0]?.rows ?? 0)} 行 · ${data.datasets?.[0]?.start ?? "-"} 起`} icon="layers" accent="green" />
            <Stat label="行情最新日" value={data.quotes?.trade_date ?? "-"} hint={data.quotes ? `上涨 ${data.quotes.up} · 下跌 ${data.quotes.down} · 涨停 ${data.quotes.limit_up}` : "无"} icon="activity" accent="violet" />
            <Stat label="质量阻塞" value={data.quality?.blockers ?? 0} hint={`${data.quality?.total ?? 0} 条问题 · ${data.quality?.warnings ?? 0} 条警告`} icon="shield" accent="amber" />
          </section>

          <section className="dataset-grid">
            {data.datasets?.map((dataset) => (
              <article className="dataset-card" key={dataset.key}>
                <div className="dataset-card-head">
                  <div>
                    <span className="eyebrow">{dataset.frequency.toUpperCase()} · {dataset.key}</span>
                    <h3>{dataset.label}</h3>
                  </div>
                  <Badge value="ok" label="已发布" tone="good" />
                </div>
                <div className="dataset-stats">
                  <div><span>标的</span><strong>{formatNumber(dataset.symbols)}</strong></div>
                  <div><span>行数</span><strong>{formatNumber(dataset.rows)}</strong></div>
                </div>
                <div className="dataset-range">
                  <span className="mono">{dataset.start ?? "-"}</span>
                  <span className="range-line" />
                  <span className="mono">{dataset.end ?? "-"}</span>
                </div>
                <div className="dataset-foot">
                  <span>最近写入 {relativeTime(dataset.updated_at)}</span>
                  <span className="mono">{dataset.interval ? `${dataset.interval}m` : "1d"}</span>
                </div>
              </article>
            )) ?? null}
          </section>

          <section className="grid-2">
            <Panel
              title="行情看板"
              subtitle="按成交额排序，支持代码 / 名称搜索；点击行直接进入交易台"
              actions={
                <form
                  className="inline-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setQuery(draft.trim());
                  }}
                >
                  <Icon name="search" size={15} />
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="600519 / 茅台"
                  />
                  <button type="submit" className="btn btn-ghost btn-sm">搜索</button>
                </form>
              }
              flush
            >
              <div className="table-wrap table-scroll">
                <table className="table">
                  <thead>
                    <tr><th>代码</th><th>名称</th><th className="right">最新价</th><th className="right">涨跌幅</th><th className="right">成交额</th><th>日期</th></tr>
                  </thead>
                  <tbody>
                    {quotes.data?.items.length ? quotes.data.items.map((quote) => (
                      <tr key={quote.symbol} className="clickable" onClick={() => onNavigate(`/trading?symbol=${quote.symbol}`)}>
                        <td className="mono">{quote.symbol}</td>
                        <td>{quote.name}</td>
                        <td className="right mono">{formatPrice(quote.close_cents)}</td>
                        <td className={`right mono ${trendClass(quote.change_bps)}`}>{formatSignedBPS(quote.change_bps)}</td>
                        <td className="right mono">{formatCompactCNY(quote.amount_cents)}</td>
                        <td className="muted mono">{quote.trade_date}</td>
                      </tr>
                    )) : <tr><td colSpan={6} className="empty">{quotes.loading ? "加载中…" : query ? "没有匹配的行情" : "暂无行情"}</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="市场宽度" subtitle={`${data.quotes?.count ?? 0} 只证券 · ${data.quotes?.trade_date ?? "-"}`}>
              <div className="breadth">
                <div className="breadth-bar">
                  <span className="breadth-up" style={{ width: `${((data.quotes?.up ?? 0) / Math.max(1, data.quotes?.count ?? 1)) * 100}%` }} />
                  <span className="breadth-flat" style={{ width: `${((data.quotes?.flat ?? 0) / Math.max(1, data.quotes?.count ?? 1)) * 100}%` }} />
                  <span className="breadth-down" style={{ width: `${((data.quotes?.down ?? 0) / Math.max(1, data.quotes?.count ?? 1)) * 100}%` }} />
                </div>
                <div className="breadth-legend">
                  <span><i className="up" />上涨 {data.quotes?.up ?? 0}</span>
                  <span><i className="flat" />平盘 {data.quotes?.flat ?? 0}</span>
                  <span><i className="down" />下跌 {data.quotes?.down ?? 0}</span>
                </div>
                <div className="breadth-grid">
                  <div><span>涨停</span><strong className="positive">{data.quotes?.limit_up ?? 0}</strong></div>
                  <div><span>跌停</span><strong className="negative">{data.quotes?.limit_down ?? 0}</strong></div>
                  <div><span>交易日历</span><strong>{formatNumber(data.quality?.trading_calendar.days ?? 0)}</strong></div>
                  <div><span>最新快照</span><strong className="mono">{shortId(data.snapshots?.[0]?.snapshot_id ?? "-", 16)}</strong></div>
                </div>
              </div>
            </Panel>
          </section>

          <Panel title="快照版本" subtitle="不可变 Parquet 快照，回测任务引用 snapshot_id" flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>快照</th><th>数据集</th><th className="right">行数</th><th className="right">标的</th><th>区间</th><th>来源</th><th>质量</th><th>创建时间</th></tr>
                </thead>
                <tbody>
                  {data.snapshots?.length ? data.snapshots.map((snapshot) => (
                    <tr key={snapshot.snapshot_id}>
                      <td className="mono">{shortId(snapshot.snapshot_id, 22)}</td>
                      <td>{snapshot.dataset}{snapshot.interval ? ` / ${snapshot.interval}m` : ""}<span className="cell-sub">{snapshot.storage} · {snapshot.adjust}</span></td>
                      <td className="right mono">{formatNumber(snapshot.rows)}</td>
                      <td className="right mono">{formatNumber(snapshot.symbols)}</td>
                      <td className="mono muted">{snapshot.start} → {snapshot.end}</td>
                      <td>{snapshot.source}</td>
                      <td>
                        {snapshot.quality.blockers > 0 ? <Badge value="blocker" label={`${snapshot.quality.blockers} 阻塞`} /> : <Badge value="ok" label={`${snapshot.quality.warnings} 警告`} />}
                      </td>
                      <td className="muted">{formatDateTime(snapshot.created_at)}</td>
                    </tr>
                  )) : <tr><td colSpan={8} className="empty">暂无快照</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>

          <section className="grid-2">
            <Panel title="质量门禁" subtitle={`来源：${data.quality?.source ?? "-"} · ${data.quality?.total ?? 0} 条问题`}>
              <div className="quality-list">
                {data.quality?.by_code.length ? data.quality.by_code.map((item) => (
                  <div key={`${item.code}-${item.level}`}>
                    <div className="quality-row">
                      <Badge value={item.level} />
                      <span className="mono">{item.code}</span>
                      <b>{item.count}</b>
                    </div>
                    <Progress value={item.count} max={data.quality?.total ?? 1} tone={item.level === "blocker" ? "red" : "amber"} />
                  </div>
                )) : <p className="muted">质量报告为空</p>}
              </div>
              <div className="quality-samples">
                <p className="eyebrow">最新样本</p>
                {data.quality?.samples.slice(0, 5).map((sample, index) => (
                  <div key={index} className="quality-sample">
                    <Badge value={sample.level} />
                    <span>{sample.message}</span>
                  </div>
                ))}
                {!data.quality?.samples.length ? <p className="muted">没有样本</p> : null}
              </div>
            </Panel>

            <Panel
              title="证券主数据"
              subtitle={`${formatNumber(data.instruments?.count ?? 0)} 只 · 快照 ${data.instruments?.snapshot ?? "-"}`}
              actions={
                <form
                  className="inline-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setInstrumentQuery(instrumentDraft.trim());
                  }}
                >
                  <Icon name="search" size={15} />
                  <input value={instrumentDraft} onChange={(event) => setInstrumentDraft(event.target.value)} placeholder="代码 / 名称" />
                  <button type="submit" className="btn btn-ghost btn-sm">查询</button>
                </form>
              }
              flush
            >
              <div className="table-wrap table-scroll">
                <table className="table">
                  <thead>
                    <tr><th>代码</th><th>名称</th><th>交易所</th><th>板块</th><th>上市日期</th></tr>
                  </thead>
                  <tbody>
                    {instruments.data?.items.length ? instruments.data.items.map((item) => (
                      <tr key={item.symbol} className="clickable" onClick={() => onNavigate(`/trading?symbol=${item.symbol}`)}>
                        <td className="mono">{item.symbol}</td>
                        <td>{item.name}</td>
                        <td>{item.exchange}</td>
                        <td>{item.board}</td>
                        <td className="muted mono">{formatDate(item.list_date)}</td>
                      </tr>
                    )) : <tr><td colSpan={5} className="empty">{instruments.loading ? "加载中…" : "没有匹配的证券"}</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </section>
        </>
      ) : null}
    </div>
  );
}