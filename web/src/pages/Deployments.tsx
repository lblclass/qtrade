import { useEffect, useMemo, useState } from "react";
import {
  api,
  errorMessage,
  type Account,
  type LiveDeployment,
  type Order,
  type Strategy,
  type StrategyVersion,
} from "../api";
import { Badge, EmptyState, ErrorBlock, Field, Modal, PageHeader, Panel, Segmented, Spinner, Stat, useToast } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import { formatDateTime, formatNumber, relativeTime, shortId } from "../lib/format";

type ActionSpec = { action: string; label: string; danger?: boolean };

const ACTIONS: Record<string, ActionSpec[]> = {
  created: [{ action: "start", label: "启动" }, { action: "stop", label: "停止", danger: true }],
  running: [
    { action: "pause", label: "暂停" },
    { action: "degrade", label: "降级" },
    { action: "stop", label: "停止", danger: true },
    { action: "kill", label: "强杀", danger: true },
  ],
  paused: [{ action: "resume", label: "恢复" }, { action: "stop", label: "停止", danger: true }],
  degraded: [{ action: "pause", label: "暂停" }, { action: "stop", label: "停止", danger: true }, { action: "kill", label: "强杀", danger: true }],
  stopped: [],
};

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "paused", label: "暂停" },
  { value: "degraded", label: "降级" },
  { value: "created", label: "待启动" },
  { value: "stopped", label: "已停止" },
];

export function DeploymentsPage({
  create,
  focus,
  onNavigate,
}: {
  create: boolean;
  focus: string;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(create);
  const [detail, setDetail] = useState<LiveDeployment | null>(null);
  const [confirming, setConfirming] = useState<{ deployment: LiveDeployment; action: ActionSpec } | null>(null);
  const [busy, setBusy] = useState(false);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [accountId, setAccountId] = useState("acc_demo");

  useEffect(() => setOpen(create), [create]);

  const state = useAsync<LiveDeployment[]>(async () => {
    const response = await api.deployments();
    if (focus) {
      const target = response.items.find((item) => item.id === focus);
      if (target) setDetail(target);
    }
    return response.items;
  }, [focus], token);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      try {
        const [strategyResponse, accountResponse] = await Promise.all([api.strategies(), api.accounts()]);
        if (!active) return;
        setStrategies(strategyResponse.items);
        setAccounts(accountResponse.items);
        if (!strategyId && strategyResponse.items[0]) setStrategyId(strategyResponse.items[0].id);
        if (accountResponse.items[0]) setAccountId(accountResponse.items[0].id);
      } catch (error) {
        toast.push(errorMessage(error), "bad");
      }
    })();
    return () => { active = false; };
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
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  const filtered = useMemo(() => {
    const items = state.data ?? [];
    return filter === "all" ? items : items.filter((item) => item.status === filter);
  }, [state.data, filter]);

  const runAction = async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      const updated = await api.deploymentAction(confirming.deployment.id, confirming.action.action);
      toast.push(`${confirming.action.label}成功，当前 ${updated.status}`, "good");
      setConfirming(null);
      setDetail((current) => (current?.id === updated.id ? updated : current));
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!strategyId || !version || !accountId) {
      toast.push("请选择策略、版本和账户", "bad");
      return;
    }
    setBusy(true);
    try {
      await api.createDeployment({ strategy_id: strategyId, strategy_version: version, mode, account_id: accountId });
      toast.push("部署实例已创建", "good");
      setOpen(false);
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(false);
    }
  };

  const running = (state.data ?? []).filter((item) => item.status === "running");
  const live = (state.data ?? []).filter((item) => item.mode === "live");

  return (
    <div className="page">
      <PageHeader
        eyebrow="Deployment control"
        title="部署管理"
        description="从模拟盘到实盘的状态机：启动、暂停、恢复、降级、停止与强杀，所有动作写入审计。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            <Icon name="plus" size={16} /> 新建部署
          </button>
        }
      />

      <section className="grid-4">
        <Stat label="部署实例" value={(state.data ?? []).length} hint={`${live.length} 个实盘 · ${(state.data ?? []).length - live.length} 个模拟`} icon="deployment" accent="blue" />
        <Stat label="运行中" value={running.length} hint="可接受订单" icon="play" accent="green" />
        <Stat label="降级 / 异常" value={(state.data ?? []).filter((item) => item.status === "degraded").length} hint="需要人工介入" icon="alert" accent="amber" />
        <Stat label="已停止" value={(state.data ?? []).filter((item) => item.status === "stopped").length} hint="保留审计与历史" icon="stop" accent="violet" />
      </section>

      <div className="toolbar">
        <Segmented value={filter} options={FILTERS} onChange={setFilter} />
        <span className="muted">running 状态才允许在交易台下单</span>
      </div>

      {state.loading && !state.data ? <Spinner label="加载部署实例" /> : null}
      {state.error ? <ErrorBlock message={state.error} onRetry={state.reload} /> : null}

      <Panel title="部署实例" subtitle="状态流转由后端 LiveDeployment.Apply 校验" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>实例</th><th>策略</th><th>模式</th><th>账户</th><th>状态</th><th>最近错误</th><th>更新时间</th><th className="right">操作</th></tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((deployment) => (
                <tr key={deployment.id} className={focus === deployment.id ? "highlight" : ""}>
                  <td className="mono clickable" onClick={() => setDetail(deployment)}>{shortId(deployment.id, 20)}</td>
                  <td>
                    <div className="cell-title">{deployment.strategy_id.replace("stg_demo_", "").replaceAll("_", " ")}</div>
                    <div className="cell-sub">v{deployment.strategy_version}</div>
                  </td>
                  <td><Badge value={deployment.mode} label={deployment.mode === "live" ? "实盘" : "模拟"} /></td>
                  <td className="mono muted">{deployment.account_id}</td>
                  <td><Badge value={deployment.status} dot /></td>
                  <td className="muted">{deployment.last_error ? deployment.last_error : "-"}</td>
                  <td className="muted">{relativeTime(deployment.updated_at)}</td>
                  <td className="right">
                    <div className="row-actions">
                      {(ACTIONS[deployment.status] ?? []).map((action) => (
                        <button
                          type="button"
                          key={action.action}
                          className={`btn btn-sm ${action.danger ? "btn-danger-ghost" : "btn-ghost"}`}
                          onClick={() => setConfirming({ deployment, action })}
                        >
                          {action.label}
                        </button>
                      ))}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate(`/trading?deployment=${deployment.id}`)}>交易台</button>
                    </div>
                  </td>
                </tr>
              )) : <tr><td colSpan={8} className="empty">没有符合条件的部署</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Modal
        open={open}
        title="新建部署"
        subtitle="模拟盘使用同一账户与风控规则，实盘需要券商网关。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? "创建中…" : "创建部署"}
            </button>
          </>
        }
      >
        <div className="form-grid two">
          <Field label="策略" required>
            <select className="select" value={strategyId} onChange={(event) => setStrategyId(event.target.value)}>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
            </select>
          </Field>
          <Field label="版本" required>
            <select className="select" value={version} onChange={(event) => setVersion(event.target.value)}>
              {versions.map((item) => <option key={item.id} value={item.version}>v{item.version}</option>)}
            </select>
          </Field>
          <Field label="模式" required>
            <div className="segmented">
              <button type="button" className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>模拟盘</button>
              <button type="button" className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>实盘</button>
            </div>
          </Field>
          <Field label="账户" required>
            <select className="select" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.id}</option>)}
            </select>
          </Field>
        </div>
        {mode === "live" ? (
          <div className="banner banner-warn">
            <Icon name="alert" size={16} />
            <div><strong>实盘模式</strong><p>当前仅接入 Mock 网关，真实券商（QMT/miniQMT）尚未连接；订单不会到达交易所。</p></div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={confirming !== null}
        title={confirming ? `${confirming.action.label}实例` : ""}
        subtitle={confirming?.deployment.id}
        onClose={() => setConfirming(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>取消</button>
            <button type="button" className={`btn ${confirming?.action.danger ? "btn-danger" : "btn-primary"}`} onClick={runAction} disabled={busy}>
              {busy ? "处理中…" : `确认${confirming?.action.label ?? ""}`}
            </button>
          </>
        }
      >
        {confirming ? (
          <p className="confirm-text">
            即将对 <span className="mono">{confirming.deployment.id}</span> 执行
            <strong> {confirming.action.label} </strong>
            操作。{confirming.action.action === "kill" ? "强杀会立即停止运行时并记录审计，可能造成未平仓头寸。" : "该动作会写入审计事件。"}
          </p>
        ) : null}
      </Modal>

      <DeploymentDetail
        deployment={detail}
        onClose={() => setDetail(null)}
        onNavigate={onNavigate}
        onAction={(action) => detail && setConfirming({ deployment: detail, action })}
      />
    </div>
  );
}

function DeploymentDetail({
  deployment,
  onClose,
  onNavigate,
  onAction,
}: {
  deployment: LiveDeployment | null;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onAction: (action: ActionSpec) => void;
}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!deployment) return;
    let active = true;
    setLoading(true);
    void api.orders({ deployment_id: deployment.id })
      .then((response) => { if (active) setOrders(response.items); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [deployment]);

  return (
    <Modal
      open={deployment !== null}
      title={deployment ? deployment.strategy_id.replace("stg_demo_", "").replaceAll("_", " ") : ""}
      subtitle={deployment?.id}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
          <button type="button" className="btn btn-primary" onClick={() => deployment && onNavigate(`/trading?deployment=${deployment.id}`)}>去交易台</button>
        </>
      }
    >
      {deployment ? (
        <>
          <dl className="info-list two">
            <div><dt>状态</dt><dd><Badge value={deployment.status} dot /></dd></div>
            <div><dt>模式</dt><dd>{deployment.mode === "live" ? "实盘" : "模拟盘"}</dd></div>
            <div><dt>策略版本</dt><dd>v{deployment.strategy_version}</dd></div>
            <div><dt>账户</dt><dd className="mono">{deployment.account_id}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(deployment.created_at)}</dd></div>
            <div><dt>更新时间</dt><dd>{formatDateTime(deployment.updated_at)}</dd></div>
            <div><dt>最近错误</dt><dd>{deployment.last_error ?? "无"}</dd></div>
            <div><dt>可执行动作</dt><dd>{(ACTIONS[deployment.status] ?? []).map((action) => action.label).join(" / ") || "无"}</dd></div>
          </dl>
          {deployment.last_error ? (
            <div className="banner banner-bad"><Icon name="alert" size={16} /><div><strong>运行时错误</strong><p>{deployment.last_error}</p></div></div>
          ) : null}
          <h3 className="subhead">最近订单 <span>{formatNumber(orders.length)} 笔</span></h3>
          <div className="table-wrap table-scroll">
            <table className="table">
              <thead><tr><th>订单</th><th>代码</th><th>方向</th><th className="right">数量</th><th className="right">价格</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>
                {orders.length ? orders.slice(0, 12).map((order) => (
                  <tr key={order.id}>
                    <td className="mono">{shortId(order.id, 16)}</td>
                    <td className="mono">{order.symbol}</td>
                    <td><Badge value={order.side} /></td>
                    <td className="right mono">{formatNumber(order.quantity)}</td>
                    <td className="right mono">{(order.price_cents / 100).toFixed(2)}</td>
                    <td><Badge value={order.status} /></td>
                    <td className="muted">{formatDateTime(order.created_at)}</td>
                  </tr>
                )) : <tr><td colSpan={7} className="empty">{loading ? "加载中…" : "还没有订单"}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            {(ACTIONS[deployment.status] ?? []).map((action) => (
              <button key={action.action} type="button" className={`btn btn-sm ${action.danger ? "btn-danger-ghost" : "btn-ghost"}`} onClick={() => onAction(action)}>
                {action.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}