import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  errorMessage,
  type Account,
  type LiveDeployment,
  type Order,
  type Position,
  type Quote,
  type RiskLimits,
  type Strategy,
  type SymbolSeries,
  type Violation,
} from "../api";
import { Badge, ErrorBlock, Field, PageHeader, Panel, Segmented, Spinner, useToast } from "../components/ui";
import { Icon } from "../components/icons";
import { useRefresh } from "../lib/refresh";
import { useAsync } from "../lib/useAsync";
import { CandleChart, type CandleBar } from "../components/charts";
import {
  formatCNY,
  formatCompactCNY,
  formatNumber,
  formatPrice,
  formatSignedBPS,
  relativeTime,
  shortId,
  trendClass,
} from "../lib/format";

type TradeData = {
  deployments: LiveDeployment[];
  accounts: Account[];
  positions: Position[];
  orders: Order[];
  risk: RiskLimits;
  strategies: Strategy[];
};

const RANGES: { value: "60" | "120" | "250"; label: string }[] = [
  { value: "60", label: "60日" },
  { value: "120", label: "120日" },
  { value: "250", label: "250日" },
] ;

const ORDER_FILTERS = [
  { value: "all", label: "全部" },
  { value: "open", label: "未完成" },
  { value: "filled", label: "已成交" },
  { value: "rejected", label: "已拒绝" },
  { value: "canceled", label: "已取消" },
];

export function TradingPage({
  initialSymbol,
  initialDeployment,
  onNavigate,
}: {
  initialSymbol: string;
  initialDeployment: string;
  onNavigate: (path: string) => void;
}) {
  const { token } = useRefresh();
  const toast = useToast();
  const [deploymentId, setDeploymentId] = useState(initialDeployment);
  const [symbol, setSymbol] = useState(initialSymbol || "600519.SH");
  const [symbolDraft, setSymbolDraft] = useState(initialSymbol || "600519.SH");
  const [suggestions, setSuggestions] = useState<Quote[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [positionQuotes, setPositionQuotes] = useState<Record<string, Quote>>({});
  const [series, setSeries] = useState<SymbolSeries | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [range, setRange] = useState<"60" | "120" | "250">("120");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [quantity, setQuantity] = useState("100");
  const [price, setPrice] = useState("0");
  const [lastPrice, setLastPrice] = useState("0");
  const [limitUp, setLimitUp] = useState("0");
  const [limitDown, setLimitDown] = useState("0");
  const [showRiskInputs, setShowRiskInputs] = useState(false);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [orderFilter, setOrderFilter] = useState("all");
  const autoFilled = useRef<string>("");

  const state = useAsync<TradeData>(async () => {
    const [deployments, accounts, positions, orders, risk, strategies] = await Promise.all([
      api.deployments(),
      api.accounts(),
      api.positions(),
      api.orders(),
      api.riskLimits(),
      api.strategies(),
    ]);
    return {
      deployments: deployments.items,
      accounts: accounts.items,
      positions: positions.items,
      orders: orders.items,
      risk,
      strategies: strategies.items,
    };
  }, [], token);

  const running = useMemo(() => (state.data?.deployments ?? []).filter((item) => item.status === "running"), [state.data]);
  const selected = (state.data?.deployments ?? []).find((item) => item.id === deploymentId) ?? running[0] ?? null;
  const account = (state.data?.accounts ?? []).find((item) => item.id === selected?.account_id) ?? (state.data?.accounts ?? [])[0];
  const positions = (state.data?.positions ?? []).filter((item) => item.account_id === account?.id);
  const position = positions.find((item) => item.symbol === symbol);

  const priceOf = (item: Position) => positionQuotes[item.symbol]?.close_cents ?? item.market_price_cents;
  const positionKey = positions.map((item) => item.symbol).sort().join(",");

  useEffect(() => {
    if (!deploymentId && running[0]) setDeploymentId(running[0].id);
  }, [deploymentId, running]);

  useEffect(() => {
    if (initialSymbol) {
      setSymbol(initialSymbol);
      setSymbolDraft(initialSymbol);
    }
  }, [initialSymbol]);

  useEffect(() => {
    if (initialDeployment) setDeploymentId(initialDeployment);
  }, [initialDeployment]);

  useEffect(() => {
    if (!suggestOpen) return;
    const query = symbolDraft.trim();
    if (!query) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api.quotes({ q: query, limit: 8 })
        .then((response) => { if (active) setSuggestions(response.items); })
        .catch(() => { if (active) setSuggestions([]); });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [symbolDraft, suggestOpen]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api.quotes({ symbols: symbol, limit: 1 })
        .then((response) => {
          if (!active) return;
          const found = response.items[0] ?? null;
          setQuote(found);
          if (found && autoFilled.current !== found.symbol) {
            autoFilled.current = found.symbol;
            setPrice((found.close_cents / 100).toFixed(2));
            setLastPrice((found.close_cents / 100).toFixed(2));
            setLimitUp(found.limit_up_cents ? (found.limit_up_cents / 100).toFixed(2) : "0");
            setLimitDown(found.limit_down_cents ? (found.limit_down_cents / 100).toFixed(2) : "0");
          }
        })
        .catch(() => { if (active) setQuote(null); });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [symbol, token]);

  useEffect(() => {
    if (!positionKey) {
      setPositionQuotes({});
      return;
    }
    let active = true;
    void api.quotes({ symbols: positionKey, limit: 200 })
      .then((response) => {
        if (!active) return;
        const next: Record<string, Quote> = {};
        for (const item of response.items) next[item.symbol] = item;
        setPositionQuotes(next);
      })
      .catch(() => { if (active) setPositionQuotes({}); });
    return () => {
      active = false;
    };
  }, [positionKey, token]);
  useEffect(() => {
    let active = true;
    setSeriesError(null);
    void api.series(symbol, Number(range))
      .then((response) => { if (active) setSeries(response); })
      .catch((error) => {
        if (!active) return;
        setSeries(null);
        setSeriesError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [symbol, range, token]);

  const candles = useMemo<CandleBar[]>(() => {
    if (!series) return [];
    return series.dates.map((date, index) => ({
      date,
      open: series.open[index] ?? 0,
      high: series.high[index] ?? 0,
      low: series.low[index] ?? 0,
      close: series.close[index] ?? 0,
      volume: series.volume[index] ?? 0,
    }));
  }, [series]);

  const selectQuote = (item: Quote) => {
    setSymbol(item.symbol);
    setSymbolDraft(item.symbol);
    setSuggestOpen(false);
    setSuggestions([]);
  };

  const priceCents = Math.round((Number(price) || 0) * 100);
  const lastCents = Math.round((Number(lastPrice) || 0) * 100);
  const quantityValue = Math.max(0, Math.floor(Number(quantity) || 0));
  const notional = quantityValue * (orderType === "market" ? lastCents : priceCents);
  const limits = state.data?.risk;
  const commission = limits ? Math.max(Math.round((notional * limits.commission_bps) / 10_000), limits.min_commission_cents) : 0;
  const transferFee = limits ? Math.round((notional * limits.transfer_fee_bps) / 10_000) : 0;
  const stampTax = limits && side === "sell" ? Math.round((notional * limits.stamp_tax_bps) / 10_000) : 0;
  const fees = commission + transferFee + stampTax;
  const cashNeeded = side === "buy" ? notional + fees : 0;

  const filteredOrders = useMemo(() => {
    const items = state.data?.orders ?? [];
    if (orderFilter === "all") return items;
    if (orderFilter === "open") return items.filter((item) => item.status === "accepted" || item.status === "partially_filled");
    return items.filter((item) => item.status === orderFilter);
  }, [state.data, orderFilter]);

  const submit = async () => {
    setViolations([]);
    if (!selected) {
      toast.push("没有运行中的部署实例", "bad");
      return;
    }
    if (!symbol || quantityValue <= 0 || priceCents <= 0) {
      toast.push("请填写代码、数量和价格", "bad");
      return;
    }
    setSubmitting(true);
    try {
      const order = await api.createOrder({
        client_order_id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        deployment_id: selected.id,
        account_id: selected.account_id,
        symbol,
        side,
        order_type: orderType,
        quantity: quantityValue,
        price_cents: orderType === "market" ? lastCents || priceCents : priceCents,
        last_price_cents: lastCents || undefined,
        limit_up_cents: Math.round((Number(limitUp) || 0) * 100) || undefined,
        limit_down_cents: Math.round((Number(limitDown) || 0) * 100) || undefined,
      });
      toast.push(`订单已受理：${order.id}`, "good");
      setQuantity("100");
      state.reload();
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.details) && error.details.length > 0) {
        setViolations(error.details as Violation[]);
      }
      toast.push(errorMessage(error), "bad");
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (order: Order) => {
    try {
      await api.cancelOrder(order.id);
      toast.push("订单已取消", "good");
      state.reload();
    } catch (error) {
      toast.push(errorMessage(error), "bad");
    }
  };

  if (state.loading && !state.data) return <Spinner label="加载交易账户" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Execution desk"
        title="交易台"
        description="订单先经过幂等、资金/持仓、价格偏离和涨跌停校验，通过后才进入执行网关。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate("/deployments")}>
            <Icon name="deployment" size={16} /> 部署管理
          </button>
        }
      />

      {!selected ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={17} />
          <div>
            <strong>没有运行中的部署实例</strong>
            <p>先在部署管理中创建并启动一个实例，交易台才会发送订单。</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate("/deployments?create=1")}>去创建</button>
        </div>
      ) : null}

      <section className="grid-4">
        <div className="kpi kpi-blue">
          <div className="kpi-top"><span className="kpi-label">账户权益</span><Icon name="shield" size={16} /></div>
          <strong className="kpi-value">{formatCompactCNY(account?.equity_cents ?? 0)}</strong>
          <div className="kpi-foot"><span className="kpi-hint">{account?.name ?? "-"}</span></div>
        </div>
        <div className="kpi kpi-green">
          <div className="kpi-top"><span className="kpi-label">可用资金</span><Icon name="activity" size={16} /></div>
          <strong className="kpi-value">{formatCompactCNY(account?.cash_cents ?? 0)}</strong>
          <div className="kpi-foot"><span className="kpi-hint">下单前校验</span></div>
        </div>
        <div className="kpi kpi-violet">
          <div className="kpi-top"><span className="kpi-label">持仓市值</span><Icon name="layers" size={16} /></div>
          <strong className="kpi-value">{formatCompactCNY(positions.reduce((sum, item) => sum + item.quantity * priceOf(item), 0))}</strong>
          <div className="kpi-foot"><span className="kpi-hint">{positions.length} 个持仓</span></div>
        </div>
        <div className="kpi kpi-amber">
          <div className="kpi-top"><span className="kpi-label">待处理订单</span><Icon name="clock" size={16} /></div>
          <strong className="kpi-value">{filteredOrders.filter((item) => item.status === "accepted" || item.status === "partially_filled").length}</strong>
          <div className="kpi-foot"><span className="kpi-hint">可撤单</span></div>
        </div>
      </section>

      <section className="chart-panel">
        <Panel
          title={`行情走势 · ${quote?.name ?? symbol}`}
          subtitle={`${series?.days ?? 0} 个交易日 · 日线不复权 · 本地落库数据`}
          actions={<Segmented value={range} options={RANGES} onChange={setRange} />}
          flush
        >
          {seriesError ? (
            <p className="empty">{seriesError}</p>
          ) : candles.length ? (
            <CandleChart bars={candles} height={320} />
          ) : (
            <div className="chart-empty">加载中…</div>
          )}
        </Panel>
      </section>
      <section className="trade-layout">
        <Panel
          title="下单"
          subtitle={selected ? `${selected.mode === "live" ? "实盘" : "模拟盘"} · ${shortId(selected.id, 20)}` : "无运行实例"}
          className={!selected ? "disabled-panel" : ""}
        >
          <div className="form-grid">
            <Field label="部署实例" required hint="只有 running 状态可下单">
              <select className="select" value={selected?.id ?? ""} onChange={(event) => setDeploymentId(event.target.value)}>
                {running.map((item) => {
                  const strategy = state.data?.strategies.find((candidate) => candidate.id === item.strategy_id);
                  return <option key={item.id} value={item.id}>{strategy?.name ?? item.strategy_id} · v{item.strategy_version}</option>;
                })}
                {!running.length ? <option value="">无运行中实例</option> : null}
              </select>
            </Field>

            <Field label="证券代码" required>
              <div className="suggest-wrap">
                <input
                  className="input mono"
                  value={symbolDraft}
                  onFocus={() => setSuggestOpen(true)}
                  onChange={(event) => {
                    setSymbolDraft(event.target.value.toUpperCase());
                    setSuggestOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && suggestions[0]) {
                      event.preventDefault();
                      selectQuote(suggestions[0]);
                    }
                  }}
                  placeholder="600519.SH / 茅台"
                />
                {suggestOpen && suggestions.length ? (
                  <div className="suggest-list">
                    {suggestions.map((item) => (
                      <button type="button" key={item.symbol} onMouseDown={() => selectQuote(item)}>
                        <span className="mono">{item.symbol}</span>
                        <span>{item.name}</span>
                        <span className={`mono ${trendClass(item.change_bps)}`}>{formatSignedBPS(item.change_bps)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </Field>

            {quote ? (
              <div className="quote-strip">
                <div><span>{quote.name}</span><strong>{formatPrice(quote.close_cents)}</strong></div>
                <div><span>涨跌幅</span><strong className={trendClass(quote.change_bps)}>{formatSignedBPS(quote.change_bps)}</strong></div>
                <div><span>成交额</span><strong>{formatCompactCNY(quote.amount_cents)}</strong></div>
                <div><span>日期</span><strong className="mono">{quote.trade_date}</strong></div>
              </div>
            ) : null}

            <div className="side-toggle">
              <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>买入</button>
              <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>卖出</button>
            </div>

            <Field label="订单类型">
              <div className="segmented">
                <button type="button" className={orderType === "limit" ? "active" : ""} onClick={() => setOrderType("limit")}>限价</button>
                <button type="button" className={orderType === "market" ? "active" : ""} onClick={() => setOrderType("market")}>市价</button>
              </div>
            </Field>

            <div className="form-two">
              <Field label="数量（股）" required hint={`主板买入需为 ${limits?.lot_size ?? 100} 的整数倍`}>
                <input className="input mono" type="number" min={0} step={100} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
              </Field>
              <Field label="价格（元）" required>
                <input className="input mono" type="number" min={0} step={0.01} value={price} onChange={(event) => setPrice(event.target.value)} disabled={orderType === "market"} />
              </Field>
            </div>

            <button type="button" className="advanced-toggle" onClick={() => setShowRiskInputs((value) => !value)}>
              <Icon name="shield" size={14} /> 风控参考价 {showRiskInputs ? "收起" : "展开"}
            </button>
            {showRiskInputs ? (
              <div className="form-two">
                <Field label="最新价（元）"><input className="input mono" value={lastPrice} onChange={(event) => setLastPrice(event.target.value)} /></Field>
                <Field label="涨停价（元）"><input className="input mono" value={limitUp} onChange={(event) => setLimitUp(event.target.value)} /></Field>
                <Field label="跌停价（元）"><input className="input mono" value={limitDown} onChange={(event) => setLimitDown(event.target.value)} /></Field>
              </div>
            ) : null}

            <div className="order-summary">
              <div><span>名义金额</span><strong>{formatCNY(notional)}</strong></div>
              <div><span>预估费用</span><strong>{formatCNY(fees)}</strong></div>
              <div><span>{side === "buy" ? "需冻结资金" : "可卖数量"}</span><strong>{side === "buy" ? formatCNY(cashNeeded) : formatNumber(position?.available_quantity ?? 0)}</strong></div>
              <div><span>当前持仓</span><strong>{formatNumber(position?.quantity ?? 0)} 股</strong></div>
            </div>

            {violations.length ? (
              <div className="risk-violations">
                <strong><Icon name="alert" size={15} /> 风控拒绝</strong>
                <ul>{violations.map((item) => <li key={item.code}><span className="mono">{item.code}</span>{item.message}</li>)}</ul>
              </div>
            ) : null}

            <button type="button" className={`btn submit-btn ${side === "buy" ? "btn-buy" : "btn-sell"}`} onClick={submit} disabled={!selected || submitting}>
              {submitting ? "提交中…" : `${side === "buy" ? "买入" : "卖出"} ${symbol || ""}`}
            </button>
            <p className="ticket-note">订单会写入审计；市价单使用最新价作为风控参考价。</p>
          </div>
        </Panel>

        <Panel
          title="订单"
          subtitle={`${filteredOrders.length} 笔 · 支持撤单`}
          actions={<Segmented value={orderFilter} options={ORDER_FILTERS} onChange={setOrderFilter} />}
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>订单</th><th>代码</th><th>方向</th><th className="right">数量 / 成交</th><th className="right">价格</th><th>状态</th><th>时间</th><th /></tr></thead>
              <tbody>
                {filteredOrders.length ? filteredOrders.map((order) => {
                  const canCancel = order.status === "accepted" || order.status === "partially_filled";
                  return (
                    <tr key={order.id}>
                      <td className="mono">{shortId(order.id, 16)}</td>
                      <td><div className="cell-title mono">{order.symbol}</div><div className="cell-sub">{order.order_type === "market" ? "市价" : "限价"}</div></td>
                      <td><Badge value={order.side} /></td>
                      <td className="right mono">{formatNumber(order.quantity)} / {formatNumber(order.filled_quantity)}</td>
                      <td className="right mono">{formatPrice(order.price_cents)}</td>
                      <td><Badge value={order.status} dot /></td>
                      <td className="muted">{relativeTime(order.created_at)}</td>
                      <td className="right">{canCancel ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel(order)}>撤单</button> : null}</td>
                    </tr>
                  );
                }) : <tr><td colSpan={8} className="empty">没有订单</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <Panel title="持仓" subtitle={account ? `${account.name} · ${account.id}` : ""} flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>代码</th><th className="right">持仓</th><th className="right">可用</th><th className="right">成本价</th><th className="right">现价</th><th className="right">市值</th><th className="right">浮动盈亏</th><th className="right">收益率</th></tr></thead>
            <tbody>
              {positions.length ? positions.map((item) => {
                const pnl = (priceOf(item) - item.avg_cost_cents) * item.quantity;
                const pnlBps = item.avg_cost_cents ? ((priceOf(item) - item.avg_cost_cents) * 10_000) / item.avg_cost_cents : 0;
                return (
                  <tr key={item.symbol} className="clickable" onClick={() => { setSymbol(item.symbol); setSymbolDraft(item.symbol); }}>
                    <td className="mono">{item.symbol}</td>
                    <td className="right mono">{formatNumber(item.quantity)}</td>
                    <td className="right mono">{formatNumber(item.available_quantity)}</td>
                    <td className="right mono">{formatPrice(item.avg_cost_cents)}</td>
                    <td className="right mono">{formatPrice(priceOf(item))}</td>
                    <td className="right mono">{formatCNY(item.quantity * priceOf(item))}</td>
                    <td className={`right mono ${trendClass(pnl)}`}>{formatCNY(pnl)}</td>
                    <td className={`right mono ${trendClass(pnlBps)}`}>{formatSignedBPS(pnlBps)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={8} className="empty">当前账户没有持仓</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}