import { useEffect, useState } from "react";
import {
  createDemoStrategy,
  fetchDashboard,
  formatCNY,
  type Account,
  type Deployment,
  type RiskLimits,
  type Strategy,
} from "./api";

type Dashboard = {
  health: { status: string; service: string };
  strategies: { items: Strategy[]; count: number };
  deployments: { items: Deployment[]; count: number };
  accounts: { items: Account[]; count: number };
  risk: RiskLimits;
};

function StatusBadge({ value }: { value: string }) {
  const tone = ["running", "ok", "live", "filled"].includes(value)
    ? "good"
    : ["paused", "degraded", "queued"].includes(value)
      ? "warn"
      : ["stopped", "rejected", "failed"].includes(value)
        ? "bad"
        : "neutral";
  return <span className={`badge badge-${tone}`}>{value}</span>;
}

export default function App() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDashboard());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleCreate = async () => {
    try {
      await createDemoStrategy(`demo-${Date.now()}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "unknown error");
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">qtrade / control plane</p>
          <h1>量化交易控制台</h1>
        </div>
        <div className="actions">
          <button className="button ghost" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
          <button className="button" onClick={() => void handleCreate()}>
            创建示例策略
          </button>
        </div>
      </header>

      {error ? <div className="alert">{error}</div> : null}

      <section className="grid">
        <article className="panel metric">
          <span className="label">API</span>
          <strong>{data?.health.status ?? "..."}</strong>
          <small>{data?.health.service ?? "waiting for api"}</small>
        </article>
        <article className="panel metric">
          <span className="label">策略</span>
          <strong>{data?.strategies.count ?? 0}</strong>
          <small>已登记策略</small>
        </article>
        <article className="panel metric">
          <span className="label">部署</span>
          <strong>{data?.deployments.count ?? 0}</strong>
          <small>模拟盘 / 实盘实例</small>
        </article>
        <article className="panel metric">
          <span className="label">账户权益</span>
          <strong>{formatCNY(data?.accounts.items[0]?.equity_cents ?? 0)}</strong>
          <small>{data?.accounts.items[0]?.id ?? "no account"}</small>
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>策略</h2>
          <span className="muted">注册、版本与生命周期</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>状态</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {data?.strategies.items.length ? (
                data.strategies.items.map((strategy) => (
                  <tr key={strategy.id}>
                    <td className="mono">{strategy.id}</td>
                    <td>{strategy.name}</td>
                    <td><StatusBadge value={strategy.status} /></td>
                    <td className="muted">{new Date(strategy.created_at).toLocaleString("zh-CN")}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={4} className="empty">还没有策略，点击右上角创建。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>部署</h2>
          <span className="muted">Running 状态的实例才允许提交订单</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>模式</th>
                <th>状态</th>
                <th>账户</th>
              </tr>
            </thead>
            <tbody>
              {data?.deployments.items.length ? (
                data.deployments.items.map((deployment) => (
                  <tr key={deployment.id}>
                    <td className="mono">{deployment.id}</td>
                    <td>{deployment.mode}</td>
                    <td><StatusBadge value={deployment.status} /></td>
                    <td className="mono">{deployment.account_id}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={4} className="empty">还没有部署实例。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel risk">
        <div className="panel-head">
          <h2>默认风控</h2>
          <span className="muted">服务端 fail-closed 规则</span>
        </div>
        {data ? (
          <dl>
            <div><dt>单笔上限</dt><dd>{formatCNY(data.risk.max_order_notional_cents)}</dd></div>
            <div><dt>单票上限</dt><dd>{data.risk.max_position_percent_bps / 100}%</dd></div>
            <div><dt>价格偏离</dt><dd>{data.risk.max_price_deviation_bps / 100}%</dd></div>
            <div><dt>买入单位</dt><dd>{data.risk.lot_size} 股</dd></div>
          </dl>
        ) : <p className="muted">加载中...</p>}
      </section>
    </main>
  );
}

