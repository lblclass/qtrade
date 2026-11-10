import { api, type Order, type RiskLimits } from "../api";
import { Badge, ErrorBlock, PageHeader, Panel, Spinner, Stat } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import { formatBPS, formatCNY, formatDateTime, formatNumber, formatPrice, relativeTime, shortId } from "../lib/format";

export function RiskPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { token } = useRefresh();
  const state = useAsync<{ limits: RiskLimits; orders: Order[] }>(async () => {
    const [limits, orders] = await Promise.all([api.riskLimits(), api.orders()]);
    return { limits, orders: orders.items };
  }, [], token);

  if (state.loading && !state.data) return <Spinner label="加载风控规则" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const { limits, orders } = state.data;
  const rejected = orders.filter((item) => item.status === "rejected");
  const open = orders.filter((item) => item.status === "accepted" || item.status === "partially_filled");

  const rules = [
    { name: "单笔名义金额", value: formatCNY(limits.max_order_notional_cents), code: "max_order_notional", desc: "数量 × 价格不得超过该上限，超限直接拒绝。" },
    { name: "单票持仓占比", value: formatBPS(limits.max_position_percent_bps, 1), code: "max_position_percent", desc: "买入后该标的市值不得超过账户权益的该比例。" },
    { name: "价格偏离", value: formatBPS(limits.max_price_deviation_bps, 1), code: "price_deviation", desc: "委托价与最新价偏离超过阈值时拒绝，防止乌龙指。" },
    { name: "单笔最大数量", value: `${formatNumber(limits.max_order_quantity)} 股`, code: "max_order_quantity", desc: "单笔数量上限，避免拆单绕过金额限制。" },
    { name: "买入整手", value: `${limits.lot_size} 股`, code: "lot_size", desc: "买入数量必须是整手倍数，卖出允许零股。" },
    { name: "佣金", value: `${formatBPS(limits.commission_bps)} · 最低 ${formatCNY(limits.min_commission_cents)}`, code: "commission", desc: "按成交额计提，不足最低佣金按最低收取。" },
    { name: "印花税", value: `${formatBPS(limits.stamp_tax_bps)}（卖出）`, code: "stamp_tax", desc: "仅卖出方向计提。" },
    { name: "过户费", value: formatBPS(limits.transfer_fee_bps), code: "transfer_fee", desc: "买卖双向计提。" },
    { name: "可用资金", value: "实时校验", code: "insufficient_cash", desc: "买入需覆盖名义金额与预估费用。" },
    { name: "可用持仓", value: "T+1", code: "insufficient_available_position", desc: "卖出数量不得超过可用持仓，当日买入不可卖。" },
    { name: "涨跌停", value: "参考价校验", code: "above_limit_up", desc: "委托价高于涨停或低于跌停时拒绝。" },
    { name: "订单幂等", value: "client_order_id", code: "duplicate_client_order_id", desc: "相同 client_order_id 重复提交返回 409。" },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Risk engine"
        title="风险控制"
        description="服务端 fail-closed 风控：任何一项检查失败，订单都会被拒绝并写入审计。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate("/trading")}>
            <Icon name="trade" size={16} /> 去交易台
          </button>
        }
      />

      <section className="grid-4">
        <Stat label="单笔金额上限" value={formatCNY(limits.max_order_notional_cents)} hint={`${formatNumber(limits.max_order_quantity)} 股数量上限`} icon="shield" accent="blue" />
        <Stat label="价格偏离阈值" value={formatBPS(limits.max_price_deviation_bps, 1)} hint="相对最新价" icon="activity" accent="amber" />
        <Stat label="累计拒绝" value={rejected.length} hint={`${orders.length} 笔订单中`} icon="alert" accent="violet" />
        <Stat label="待处理订单" value={open.length} hint="accepted / partially_filled" icon="clock" accent="green" />
      </section>

      <Panel title="风控链路" subtitle="每一笔订单的固定检查顺序">
        <div className="risk-chain">
          {[
            { title: "订单入口", caption: "client_order_id 幂等" },
            { title: "账户校验", caption: "账户与部署一致" },
            { title: "资金 / 持仓", caption: "现金、可用持仓" },
            { title: "价格校验", caption: "偏离、涨跌停" },
            { title: "数量校验", caption: "整手、单笔上限" },
            { title: "受理", caption: "写入订单与审计" },
          ].map((step, index) => (
            <div key={step.title} className="risk-chain-step">
              <span>{index + 1}</span>
              <strong>{step.title}</strong>
              <small>{step.caption}</small>
              {index < 5 ? <Icon name="chevron" size={14} /> : null}
            </div>
          ))}
        </div>
      </Panel>

      <section className="grid-2">
        <Panel title="限额配置" subtitle="domain.DefaultRiskLimits" flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>规则</th><th>当前值</th><th>错误码</th></tr></thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.code}>
                    <td>
                      <div className="cell-title">{rule.name}</div>
                      <div className="cell-sub">{rule.desc}</div>
                    </td>
                    <td className="mono">{rule.value}</td>
                    <td><span className="code-chip">{rule.code}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="风控拒绝" subtitle="订单被拒绝时仍会留痕，可回溯原因" flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>订单</th><th>代码</th><th>方向</th><th className="right">数量 / 价格</th><th>原因</th><th>时间</th></tr></thead>
              <tbody>
                {rejected.length ? rejected.map((order) => (
                  <tr key={order.id} className="clickable" onClick={() => onNavigate(`/trading?symbol=${order.symbol}`)}>
                    <td className="mono">{shortId(order.id, 18)}</td>
                    <td className="mono">{order.symbol}</td>
                    <td><Badge value={order.side} /></td>
                    <td className="right mono">{formatNumber(order.quantity)} / {formatPrice(order.price_cents)}</td>
                    <td><Badge value="rejected" label={order.reject_reason ?? "risk_rejected"} /></td>
                    <td className="muted">{formatDateTime(order.created_at)}</td>
                  </tr>
                )) : <tr><td colSpan={6} className="empty">没有被拒绝的订单</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <Panel title="审计提示" subtitle="审计事件与订单一一对应">
        <div className="audit-hint-grid">
          <div><span className="mono">order.accepted</span><p>风控通过，订单进入 accepted 状态，等待执行网关回报。</p></div>
          <div><span className="mono">order.rejected</span><p>任一风控规则失败，返回 422 并在订单上记录 reject_reason。</p></div>
          <div><span className="mono">order.canceled</span><p>交易台撤单成功，更新订单状态并写入审计。</p></div>
          <div><span className="mono">deployment.*</span><p>启动、暂停、降级、停止、强杀等动作全部留痕。</p></div>
        </div>
      </Panel>
    </div>
  );
}