import { useEffect, useMemo, useState } from "react";
import {
  api,
  errorMessage,
  type BacktestRun,
  type LiveDeployment,
  type RunLog,
  type Strategy,
  type StrategyStatus,
  type StrategyVersion,
} from "../api";
import { Badge, EmptyState, ErrorBlock, Field, Modal, PageHeader, Panel, Segmented, Spinner, useToast } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatDateTime, formatSignedBPS, relativeTime, shortId, statusMeta, trendClass } from "../lib/format";

const LIFECYCLE: { status: StrategyStatus; label: string; caption: string }[] = [
  { status: "draft", label: "草稿", caption: "定义思路" },
  { status: "backtesting", label: "回测", caption: "验证有效性" },
  { status: "review", label: "评审", caption: "风控与合规" },
  { status: "paper", label: "模拟盘", caption: "仿真运行" },
  { status: "canary", label: "灰度", caption: "小资金实盘" },
  { status: "live", label: "实盘", caption: "正式运行" },
];

const NEXT: Record<StrategyStatus, { status: StrategyStatus; label: string; primary?: boolean }[]> = {
  draft: [{ status: "backtesting", label: "开始回测", primary: true }, { status: "retired", label: "归档" }],
  backtesting: [{ status: "review", label: "提交评审", primary: true }, { status: "draft", label: "退回草稿" }],
  review: [{ status: "paper", label: "进入模拟盘", primary: true }, { status: "backtesting", label: "退回回测" }],
  paper: [{ status: "canary", label: "灰度发布", primary: true }, { status: "live", label: "直接上实盘" }, { status: "paused", label: "暂停" }],
  canary: [{ status: "live", label: "全量实盘", primary: true }, { status: "paper", label: "回到模拟盘" }, { status: "paused", label: "暂停" }],
  live: [{ status: "paused", label: "暂停策略", primary: true }, { status: "retired", label: "退役" }],
  paused: [{ status: "live", label: "恢复实盘", primary: true }, { status: "paper", label: "回到模拟盘" }, { status: "retired", label: "退役" }],
  retired: [],
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "draft", label: "草稿" },
  { value: "backtesting", label: "回测中" },
  { value: "review", label: "评审中" },
  { value: "paper", label: "模拟盘" },
  { value: "live", label: "实盘" },
  { value: "paused", label: "暂停" },
];

export function StrategiesPage({
  onCreate,
  onNavigate,
}: {
  onCreate: boolean;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(onCreate);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setOpen(onCreate), [onCreate]);

  const state = useAsync<{ strategies: Strategy[]; versions: Record<string, StrategyVersion[]> }>(async () => {
    const response = await api.strategies();
    const entries = await Promise.all(
      response.items.map(async (strategy) => {
        const versions = await api.versions(strategy.id);
        return [strategy.id, versions.items] as const;
      }),
    );
    return { strategies: response.items, versions: Object.fromEntries(entries) };
  }, [], token);

  const filtered = useMemo(() => {
    const items = state.data?.strategies ?? [];
    const keyword = search.trim().toLowerCase();
    return items.filter((strategy) => {
      if (filter !== "all" && strategy.status !== filter) return false;
      if (!keyword) return true;
      return strategy.name.toLowerCase().includes(keyword) || strategy.id.toLowerCase().includes(keyword);
    });
  }, [state.data, filter, search]);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.createStrategy({ name: name.trim(), description: description.trim() });
      toast.push("策略已创建", "good");
      setOpen(false);
      setName("");
      setDescription("");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Strategy lifecycle"
        title="策略库"
        description="管理策略从草稿、回测、评审、模拟盘到实盘的完整状态机，并追踪每一次版本发布。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            <Icon name="plus" size={16} /> 新建策略
          </button>
        }
      />

      <div className="toolbar">
        <Segmented value={filter} options={STATUS_OPTIONS} onChange={setFilter} />
        <div className="inline-search">
          <Icon name="search" size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索策略名称 / ID" />
        </div>
      </div>

      {state.loading && !state.data ? <Spinner label="加载策略" /> : null}
      {state.error ? <ErrorBlock message={state.error} onRetry={state.reload} /> : null}

      <Panel title={`策略 ${filtered.length} 个`} subtitle="点击任意策略查看版本、状态流转与关联回测" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>策略</th><th>状态</th><th>版本</th><th>最新版本</th><th>创建时间</th><th>更新时间</th><th /></tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((strategy) => {
                const versions = state.data?.versions[strategy.id] ?? [];
                const latest = versions[versions.length - 1];
                return (
                  <tr key={strategy.id} className="clickable" onClick={() => onNavigate(`/strategies/${strategy.id}`)}>
                    <td>
                      <div className="cell-title">{strategy.name}</div>
                      <div className="cell-sub mono">{strategy.id}</div>
                    </td>
                    <td><Badge value={strategy.status} dot /></td>
                    <td><span className="version-chip">{versions.length}</span></td>
                    <td className="mono">{latest ? `v${latest.version}` : "-"}</td>
                    <td className="muted">{formatDate(strategy.created_at)}</td>
                    <td className="muted">{relativeTime(strategy.updated_at)}</td>
                    <td className="right"><Icon name="chevron" size={16} /></td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={7} className="empty">没有符合条件的策略</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Modal
        open={open}
        title="新建策略"
        subtitle="创建后处于草稿状态，需要发布版本并完成回测才能进入评审。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || !name.trim()}>
              {saving ? "创建中…" : "创建策略"}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="策略名称" required>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：沪深300 动量轮动" />
          </Field>
          <Field label="描述" hint="写清楚信号逻辑、调仓频率和风险约束">
            <textarea className="textarea" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="20 日动量打分，选取前 5 名，每 10 个交易日调仓……" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

export function StrategyDetailPage({
  strategyId,
  onNavigate,
}: {
  strategyId: string;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [versionOpen, setVersionOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [digest, setDigest] = useState("");
  const [pythonVersion, setPythonVersion] = useState("3.13");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateStart, setSimulateStart] = useState("");
  const [simulateEnd, setSimulateEnd] = useState("");
  const [simulateCash, setSimulateCash] = useState("1000000");

  const state = useAsync<{
    strategy: Strategy;
    versions: StrategyVersion[];
    backtests: BacktestRun[];
    deployments: LiveDeployment[];
    logs: RunLog[];
  }>(async () => {
    const [strategy, versions, backtests, deployments] = await Promise.all([
      api.strategy(strategyId),
      api.versions(strategyId),
      api.backtests(),
      api.deployments(),
    ]);
    const relatedBacktests = backtests.items.filter((item) => item.strategy_id === strategyId);
    const relatedDeployments = deployments.items.filter((item) => item.strategy_id === strategyId);
    const logResponses = await Promise.all([
      ...relatedBacktests.map((item) => api.logs({ resource_type: "backtest", resource_id: item.id, limit: 20 })),
      ...relatedDeployments.map((item) => api.logs({ resource_type: "live_deployment", resource_id: item.id, limit: 20 })),
    ]);
    const logs = logResponses
      .flatMap((item) => item.items)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 40);
    return {
      strategy,
      versions: versions.items,
      backtests: relatedBacktests,
      deployments: relatedDeployments,
      logs,
    };
  }, [strategyId], token);

  if (state.loading && !state.data) return <Spinner label="加载策略详情" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { strategy, versions, backtests, deployments, logs } = state.data;
  const currentIndex = LIFECYCLE.findIndex((step) => step.status === strategy.status);
  const transitions = NEXT[strategy.status] ?? [];

  const transition = async (next: StrategyStatus) => {
    setBusy(next);
    try {
      await api.updateStrategyStatus(strategy.id, next);
      toast.push(`策略状态已更新为 ${statusMeta(next).label}`, "good");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!version.trim() || !digest.trim()) return;
    setSaving(true);
    try {
      await api.createVersion(strategy.id, {
        version: version.trim(),
        artifact_digest: digest.trim(),
        python_version: pythonVersion.trim() || "3.13",
      });
      toast.push(`版本 v${version.trim()} 已发布`, "good");
      setVersionOpen(false);
      setVersion("");
      setDigest("");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = () => {
    setEditName(strategy.name);
    setEditDescription(strategy.description ?? "");
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await api.updateStrategy(strategy.id, {
        name: editName.trim(),
        description: editDescription.trim(),
      });
      toast.push("策略信息已保存", "good");
      setEditOpen(false);
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setSaving(false);
    }
  };

  const runSimulation = async () => {
    setBusy("simulate");
    try {
      const run = await api.simulateStrategy(strategy.id, {
        start_date: simulateStart || undefined,
        end_date: simulateEnd || undefined,
        initial_cash_cents: Math.round(Number(simulateCash || "1000000") * 100),
      });
      toast.push("模拟回测已入队，Worker 正在执行", "good");
      setSimulateOpen(false);
      onNavigate(`/backtests/${run.id}`);
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(null);
    }
  };

  const launch = async () => {
    setBusy("deploy");
    try {
      const deployment = await api.deployStrategy(strategy.id, { mode: "paper" });
      toast.push("策略已上线模拟盘并启动", "good");
      state.reload();
      onNavigate(`/deployments?focus=${deployment.id}`);
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => onNavigate("/strategies")}>
        <Icon name="chevron" size={14} /> 返回策略库
      </button>
      <PageHeader
        eyebrow={strategy.id}
        title={strategy.name}
        description={strategy.description || "暂无描述"}
        actions={
          <>
            <Badge value={strategy.status} dot />
            <button type="button" className="btn btn-ghost" onClick={openEdit} disabled={strategy.status === "retired"}>
              <Icon name="edit" size={15} /> 编辑
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setSimulateOpen(true)}
              disabled={busy !== null || versions.length === 0}
              title={versions.length === 0 ? "先发布一个版本" : "用最新行情快照跑一次模拟回测"}
            >
              <Icon name="flask" size={15} /> 模拟运行
            </button>
            {["review", "paper", "canary"].includes(strategy.status) ? (
              <button type="button" className="btn btn-ghost" onClick={launch} disabled={busy !== null}>
                <Icon name="play" size={14} /> {busy === "deploy" ? "上线中…" : "上线模拟盘"}
              </button>
            ) : null}
            {transitions.map((item) => (
              <button
                type="button"
                key={item.status}
                className={`btn ${item.primary ? "btn-primary" : "btn-ghost"}`}
                disabled={busy !== null}
                onClick={() => void transition(item.status)}
              >
                {busy === item.status ? "处理中…" : item.label}
              </button>
            ))}
          </>
        }
      />

      <Panel title="生命周期" subtitle="状态流转受后端状态机约束，不能跳过评审直接上实盘">
        <div className="lifecycle">
          {LIFECYCLE.map((step, index) => {
            const reached = currentIndex >= 0 && index <= currentIndex && strategy.status !== "retired";
            const active = step.status === strategy.status;
            return (
              <div key={step.status} className={`lifecycle-step ${reached ? "reached" : ""} ${active ? "active" : ""}`}>
                <span className="lifecycle-node">{index + 1}</span>
                <div>
                  <strong>{step.label}</strong>
                  <small>{step.caption}</small>
                </div>
                {index < LIFECYCLE.length - 1 ? <span className="lifecycle-line" /> : null}
              </div>
            );
          })}
          {strategy.status === "paused" ? <Badge value="paused" label="当前：暂停" /> : null}
          {strategy.status === "retired" ? <Badge value="retired" label="当前：已退役" /> : null}
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="版本" subtitle={`${versions.length} 个已发布版本`} actions={<button type="button" className="btn btn-ghost btn-sm" onClick={() => setVersionOpen(true)}><Icon name="plus" size={14} /> 发布版本</button>} flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>版本</th><th>artifact</th><th>Python</th><th>发布时间</th></tr></thead>
              <tbody>
                {versions.length ? versions.map((item) => (
                  <tr key={item.id}>
                    <td><span className="version-chip">v{item.version}</span></td>
                    <td className="mono muted">{shortId(item.artifact_digest, 24)}</td>
                    <td>{item.python_version}</td>
                    <td className="muted">{formatDateTime(item.created_at)}</td>
                  </tr>
                )) : <tr><td colSpan={4} className="empty">还没有版本，先发布一个 artifact</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="策略信息" subtitle="控制面记录">
          <dl className="info-list">
            <div><dt>策略 ID</dt><dd className="mono">{strategy.id}</dd></div>
            <div><dt>当前状态</dt><dd><Badge value={strategy.status} dot /></dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(strategy.created_at)}</dd></div>
            <div><dt>最近更新</dt><dd>{formatDateTime(strategy.updated_at)}</dd></div>
            <div><dt>关联回测</dt><dd>{backtests.length} 次</dd></div>
            <div><dt>部署实例</dt><dd>{deployments.length} 个</dd></div>
          </dl>
        </Panel>
      </section>

      <section className="grid-2">
        <Panel title="关联回测" subtitle="点击查看绩效与净值曲线" flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>任务</th><th>版本</th><th>状态</th><th>收益</th><th>创建</th></tr></thead>
              <tbody>
                {backtests.length ? backtests.map((run) => (
                  <tr key={run.id} className="clickable" onClick={() => onNavigate(`/backtests/${run.id}`)}>
                    <td className="mono">{shortId(run.id, 16)}</td>
                    <td>v{run.strategy_version}</td>
                    <td><Badge value={run.status} /></td>
                    <td className={trendClass(run.metrics?.total_return_bps)}>{formatSignedBPS(run.metrics?.total_return_bps)}</td>
                    <td className="muted">{relativeTime(run.created_at)}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="empty">还没有回测</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="部署实例" subtitle="模拟盘与实盘" flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>实例</th><th>模式</th><th>状态</th><th>更新时间</th></tr></thead>
              <tbody>
                {deployments.length ? deployments.map((item) => (
                  <tr key={item.id} className="clickable" onClick={() => onNavigate(`/deployments?focus=${item.id}`)}>
                    <td className="mono">{shortId(item.id, 18)}</td>
                    <td><Badge value={item.mode} label={item.mode === "live" ? "实盘" : "模拟"} /></td>
                    <td><Badge value={item.status} dot /></td>
                    <td className="muted">{relativeTime(item.updated_at)}</td>
                  </tr>
                )) : <tr><td colSpan={4} className="empty">还没有部署</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <Panel title="运行日志" subtitle="策略、回测与部署的最近 40 条日志" flush>
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

      <Modal
        open={editOpen}
        title="编辑策略"
        subtitle="名称与描述会立即生效，状态请用生命周期按钮流转。"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={saving || !editName.trim()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="策略名称" required>
            <input className="input" value={editName} onChange={(event) => setEditName(event.target.value)} />
          </Field>
          <Field label="策略描述" hint="说明信号逻辑、调仓频率与适用市场">
            <textarea
              className="input"
              rows={5}
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={simulateOpen}
        title="模拟运行"
        subtitle="使用最新日线快照与流动性前 60 只标的执行一次真实回测，结果由 Worker 异步回写。"
        onClose={() => setSimulateOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setSimulateOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={runSimulation} disabled={busy !== null}>
              {busy === "simulate" ? "提交中…" : "开始回测"}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="开始日期" hint="留空默认最近 12 个月">
            <input className="input mono" value={simulateStart} onChange={(event) => setSimulateStart(event.target.value)} placeholder="2025-11-01" />
          </Field>
          <Field label="结束日期" hint="留空默认最新交易日">
            <input className="input mono" value={simulateEnd} onChange={(event) => setSimulateEnd(event.target.value)} placeholder="2026-11-09" />
          </Field>
          <Field label="初始资金（元）">
            <input className="input mono" value={simulateCash} onChange={(event) => setSimulateCash(event.target.value)} />
          </Field>
          <Field label="参数" hint="默认 lookback=20 / top_n=5 / 10 日调仓">
            <div className="hint-line mono">lookback 20 · top_n 5 · rebalance 10d · universe 60</div>
          </Field>
        </div>
      </Modal>

      <Modal
        open={versionOpen}
        title="发布策略版本"
        subtitle="artifact_digest 用于回测与实盘的一致性校验。"
        onClose={() => setVersionOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setVersionOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={publish} disabled={saving || !version.trim() || !digest.trim()}>
              {saving ? "发布中…" : "发布版本"}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="版本号" required hint="语义化版本，例如 1.3.0">
            <input className="input" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.3.0" />
          </Field>
          <Field label="Artifact Digest" required hint="sha256:...">
            <input className="input mono" value={digest} onChange={(event) => setDigest(event.target.value)} placeholder="sha256:..." />
          </Field>
          <Field label="Python 版本">
            <input className="input" value={pythonVersion} onChange={(event) => setPythonVersion(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}