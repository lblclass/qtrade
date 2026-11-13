import { useMemo, useState } from "react";
import {
  api,
  errorMessage,
  type Account,
  type IPOAdapter,
  type IPOOffer,
  type IPOLimit,
  type IPOSubscription,
} from "../api";
import {
  Badge,
  EmptyState,
  ErrorBlock,
  Field,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  Stat,
  useToast,
} from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import {
  formatCNY,
  formatCompactCNY,
  formatDate,
  formatNumber,
  formatPrice,
  relativeTime,
} from "../lib/format";

type IPOData = {
  accountId: string;
  accounts: Account[];
  offers: IPOOffer[];
  limits: IPOLimit[];
  subscriptions: IPOSubscription[];
  adapters: IPOAdapter[];
};

function lotSize(offer: IPOOffer): number {
  if (offer.type === "bond") return 10;
  return offer.market === "SH" ? 1000 : 500;
}

export function IPOPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { token } = useRefresh();
  const toast = useToast();
  const [accountId, setAccountId] = useState("");
  const [selected, setSelected] = useState<IPOOffer | null>(null);
  const [quantity, setQuantity] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [acting, setActing] = useState("");

  const state = useAsync<IPOData>(async () => {
    const accounts = await api.accounts();
    const activeId = accountId || accounts.items[0]?.id || "";
    const [offers, limits, subscriptions, adapters] = await Promise.all([
      api.ipoOffers(activeId),
      activeId ? api.ipoLimits(activeId) : Promise.resolve({ items: [], count: 0 }),
      api.ipoSubscriptions(activeId),
      api.ipoAdapters(),
    ]);
    return {
      accountId: activeId,
      accounts: accounts.items,
      offers: offers.items,
      limits: limits.items,
      subscriptions: subscriptions.items,
      adapters: adapters.items,
    };
  }, [accountId], token);

  const offers = useMemo(() => {
    const items = [...(state.data?.offers ?? [])];
    return items.sort((left, right) => {
      const rank = (offer: IPOOffer) => (offer.status === "open" ? 0 : 1);
      if (rank(left) !== rank(right)) return rank(left) - rank(right);
      return right.subscription_date.localeCompare(left.subscription_date);
    });
  }, [state.data]);

  const openOffers = offers.filter((offer) => offer.status === "open");
  const subscriptions = state.data?.subscriptions ?? [];
  const activeSubscriptions = subscriptions.filter(
    (item) => item.status === "submitted" || item.status === "won",
  );
  const wonCount = subscriptions.filter((item) => item.status === "won" || item.status === "paid").length;
  const frozen = activeSubscriptions.reduce((sum, item) => sum + item.amount_cents, 0);
  const stockLimit = state.data?.limits.find((limit) => limit.market === "SH");
  const szLimit = state.data?.limits.find((limit) => limit.market === "SZ");
  const bondLimit = state.data?.limits.find((limit) => limit.market === "BOND");

  const openSubscribe = (offer: IPOOffer) => {
    const ceiling = offer.quota_quantity > 0 ? offer.quota_quantity : offer.max_quantity;
    const initial = Math.max(offer.min_quantity, Math.min(ceiling, offer.max_quantity));
    setSelected(offer);
    setQuantity(String(initial > 0 ? initial : offer.min_quantity));
  };

  const submit = async () => {
    if (!selected || !state.data) return;
    const lot = lotSize(selected);
    const value = Math.floor(Number(quantity) || 0);
    if (value < selected.min_quantity || value % lot !== 0) {
      toast.push(`申购数量不能低于 ${formatNumber(selected.min_quantity)}，且需为 ${lot} 的整数倍`, "bad");
      return;
    }
    setSubmitting(true);
    try {
      await api.ipoSubscribe({
        account_id: state.data.accountId,
        offer_id: selected.id,
        quantity: value,
        client_request_id: `ipo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      toast.push(`申购已受理：${selected.name}`, "good");
      setSelected(null);
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (
    id: string,
    key: string,
    run: () => Promise<unknown>,
    message: string,
  ) => {
    setActing(`${key}:${id}`);
    try {
      await run();
      toast.push(message, "good");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    } finally {
      setActing("");
    }
  };

  if (state.loading && !state.data) return <Spinner label="加载打新日历" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;

  const quota = selected ? (selected.quota_quantity > 0 ? selected.quota_quantity : selected.max_quantity) : 0;
  const quantityValue = Math.max(0, Math.floor(Number(quantity) || 0));
  const estimate = selected ? quantityValue * selected.issue_price_cents : 0;

  return (
    <div className="page">
      <PageHeader
        eyebrow="New issue desk"
        title="打新中心"
        description="新股按 T-2 前 20 个交易日日均市值配号，新债无需市值。当前走本地沙箱通道，可完整演示申购、摇号、中签、缴款与弃购。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => onNavigate("/trading")}>
              <Icon name="trade" size={16} /> 交易台
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => state.reload()}>
              <Icon name="refresh" size={16} /> 刷新
            </button>
          </>
        }
      />

      <div className="banner banner-info">
        <Icon name="flask" size={17} />
        <div>
          <strong>真实通道尚未接入</strong>
          <p>
            沙箱适配器可跑通全流程；QMT / Ptrade 适配器已预留，但需要券商开通权限、资金账号与网关凭证后才能实盘打新。
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate("/monitoring")}>
          查看网关
        </button>
      </div>

      <section className="grid-4">
        <Stat label="今日可申购" value={openOffers.length} hint="新股 + 新债" icon="flask" accent="blue" />
        <Stat label="我的申购" value={subscriptions.length} hint={`${activeSubscriptions.length} 笔待处理`} icon="audit" accent="violet" />
        <Stat label="中签记录" value={wonCount} hint="含已缴款" icon="check" accent="green" />
        <Stat label="冻结 / 缴款金额" value={formatCompactCNY(frozen)} hint="按发行价估算" icon="shield" accent="amber" />
      </section>

      <Panel
        title="申购额度"
        subtitle={`${state.data.accounts.find((item) => item.id === state.data?.accountId)?.name ?? state.data.accountId} · 沪深市值分别计算`}
        actions={
          <select className="select select-sm" value={state.data.accountId} onChange={(event) => setAccountId(event.target.value)}>
            {state.data.accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
        }
      >
        <div className="grid-3">
          {[stockLimit, szLimit, bondLimit].filter(Boolean).map((limit) => (
            <article className="quota-card" key={limit!.market}>
              <div className="quota-head">
                <span>{limit!.label}</span>
                <Badge value={limit!.enabled ? "ok" : "unconfigured"} label={limit!.enabled ? "可用" : "无额度"} />
              </div>
              <strong className="quota-value">
                {formatNumber(limit!.quota_quantity)}
                <small>{limit!.market === "BOND" ? " 张" : " 股"}</small>
              </strong>
              <div className="quota-meta">
                {limit!.market === "BOND"
                  ? "无需市值，单账户上限 100 万张"
                  : `持仓市值 ${formatCNY(limit!.market_value_cents)}`}
              </div>
              <p className="panel-sub">{limit!.note}</p>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="今日可申购" subtitle="按申购日与状态排序，额度已按当前账户市值折算" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>代码 / 名称</th>
                <th>类型</th>
                <th>市场 / 板块</th>
                <th className="right">发行价</th>
                <th className="right">可申购上限</th>
                <th>申购日</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.length ? offers.map((offer) => {
                const enabled = offer.status === "open" && (!offer.requires_market_value || offer.quota_quantity > 0);
                return (
                  <tr key={offer.id}>
                    <td>
                      <div className="cell-title mono">{offer.code}</div>
                      <div className="cell-sub">{offer.name}</div>
                    </td>
                    <td><Badge value={offer.type} label={offer.type === "stock" ? "新股" : "新债"} /></td>
                    <td>
                      <div className="cell-title">{offer.market === "SH" ? "沪市" : "深市"}</div>
                      <div className="cell-sub">{offer.board}</div>
                    </td>
                    <td className="right mono">{formatPrice(offer.issue_price_cents)}</td>
                    <td className="right mono">
                      {formatNumber(offer.quota_quantity || offer.max_quantity)}
                      <span className="cell-sub">{offer.requires_market_value ? " 股" : " 张"}</span>
                    </td>
                    <td className="muted">{formatDate(offer.subscription_date)}</td>
                    <td><Badge value={offer.status} dot /></td>
                    <td className="right">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!enabled}
                        onClick={() => openSubscribe(offer)}
                      >
                        申购
                      </button>
                    </td>
                  </tr>
                );
              }) : <tr><td colSpan={8} className="empty">今日没有可申购标的</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="我的申购" subtitle="中签后 T+2 日 16:00 前需保证资金充足，弃购会记入限制名单" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>标的</th>
                <th>类型</th>
                <th className="right">申购数量</th>
                <th className="right">金额</th>
                <th className="right">中签数量</th>
                <th>状态</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subscriptions.length ? subscriptions.map((item) => {
                const busy = acting.endsWith(`:${item.id}`);
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="cell-title mono">{item.code}</div>
                      <div className="cell-sub">{item.name}</div>
                    </td>
                    <td><Badge value={item.type} label={item.type === "stock" ? "新股" : "新债"} /></td>
                    <td className="right mono">{formatNumber(item.quantity)}</td>
                    <td className="right mono">{formatCNY(item.amount_cents)}</td>
                    <td className="right mono">{item.allotted_quantity ? formatNumber(item.allotted_quantity) : "-"}</td>
                    <td>
                      <Badge value={item.status} dot />
                      {item.message ? <div className="cell-sub">{item.message}</div> : null}
                    </td>
                    <td className="muted">{relativeTime(item.created_at)}</td>
                    <td className="right">
                      <div className="row-actions">
                        {item.status === "submitted" ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void act(item.id, "settle", () => api.ipoSettle(item.id), "摇号完成，结果已更新")}
                          >
                            摇号
                          </button>
                        ) : null}
                        {item.status === "won" ? (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy}
                            onClick={() => void act(item.id, "pay", () => api.ipoPay(item.id), "缴款成功")}
                          >
                            缴款
                          </button>
                        ) : null}
                        {item.status === "submitted" || item.status === "won" ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void act(item.id, "abandon", () => api.ipoAbandon(item.id), "已放弃认购")}
                          >
                            弃购
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              }) : <tr><td colSpan={8} className="empty">还没有申购记录</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="交易通道" subtitle="打新走独立适配器，不与普通委托网关混用">
        <div className="grid-3">
          {state.data.adapters.map((adapter) => (
            <article className="channel-card" key={adapter.name}>
              <div className="channel-head">
                <span className="channel-name">
                  <Icon name={adapter.live_trading ? "server" : "flask"} size={16} />
                  {adapter.display}
                </span>
                <Badge
                  value={adapter.status}
                  label={adapter.status === "ok" ? "可用" : adapter.status === "unconfigured" ? "未配置" : adapter.status}
                  tone={adapter.status === "ok" ? "good" : "warn"}
                />
              </div>
              <p className="channel-msg">{adapter.message}</p>
              <div className="channel-req">
                <span>接入条件</span>
                <p>{adapter.requirement}</p>
              </div>
              <div className="channel-foot">
                <span>{adapter.live_trading ? "实盘通道" : "演示通道"}</span>
              </div>
            </article>
          ))}
        </div>
        {!state.data.adapters.length ? (
          <EmptyState icon="server" title="没有可用的打新适配器" description="检查 API 的 /api/v1/ipo/adapters 配置。" />
        ) : null}
      </Panel>

      <Modal
        open={selected !== null}
        title={selected ? `申购 ${selected.name}` : "申购"}
        subtitle={selected ? `${selected.code} · ${selected.board} · ${selected.type === "stock" ? "新股" : "新债"}` : undefined}
        onClose={() => setSelected(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setSelected(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={submitting || !selected} onClick={() => void submit()}>
              {submitting ? "提交中…" : "确认申购"}
            </button>
          </>
        }
      >
        {selected ? (
          <div className="form-grid">
            <Field label="发行价" hint="价格由发行人固定，不可修改">
              <input className="input mono" value={formatPrice(selected.issue_price_cents)} readOnly />
            </Field>
            <Field label="申购上限" hint={selected.requires_market_value ? "按账户持仓市值折算" : "新债无需市值"}>
              <input className="input mono" value={`${formatNumber(quota)}${selected.type === "bond" ? " 张" : " 股"}`} readOnly />
            </Field>
            <Field
              label="申购数量"
              required
              hint={`最小 ${formatNumber(selected.min_quantity)}，需为 ${lotSize(selected)} 的整数倍`}
            >
              <input
                className="input mono"
                type="number"
                min={selected.min_quantity}
                step={lotSize(selected)}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </Field>
            <Field label="预估冻结金额" hint="按发行价计算，未中签部分自动解冻">
              <input className="input mono" value={formatCNY(estimate)} readOnly />
            </Field>
            <div className="form-wide">
              <div className="banner banner-warn">
                <Icon name="alert" size={16} />
                <div>
                  <strong>申购前请确认</strong>
                  <p>{selected.note || "中签后需在 T+2 日 16:00 前缴款，累计 3 次弃购将被限制申购。"}</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}