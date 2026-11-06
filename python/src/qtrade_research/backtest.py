from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from math import sqrt
from statistics import pstdev

from .domain import (
    ZERO,
    Bar,
    Fill,
    Order,
    OrderIntent,
    OrderStatus,
    OrderType,
    Portfolio,
    Position,
    Side,
)
from .strategy import Context, Strategy

BPS = Decimal("10000")
CENT = Decimal("0.01")


def _dec(value: Decimal | int | float | str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class BacktestConfig:
    initial_cash: Decimal = Decimal("1000000")
    commission_bps: Decimal = Decimal("2.5")
    min_commission: Decimal = Decimal("5")
    stamp_tax_bps: Decimal = Decimal("5")
    transfer_fee_bps: Decimal = Decimal("0.1")
    slippage_bps: Decimal = Decimal("5")
    lot_size: int = 100
    max_volume_participation: Decimal = Decimal("0.05")
    t_plus_one: bool = True

    def __post_init__(self) -> None:
        for name in (
            "initial_cash",
            "commission_bps",
            "min_commission",
            "stamp_tax_bps",
            "transfer_fee_bps",
            "slippage_bps",
            "max_volume_participation",
        ):
            object.__setattr__(self, name, _dec(getattr(self, name)))
        if self.initial_cash <= 0:
            raise ValueError("initial_cash must be positive")
        if self.lot_size <= 0:
            raise ValueError("lot_size must be positive")
        if not (ZERO <= self.max_volume_participation <= Decimal("1")):
            raise ValueError("max_volume_participation must be between 0 and 1")


@dataclass(frozen=True)
class EquityPoint:
    ts: datetime
    equity: Decimal
    cash: Decimal
    market_value: Decimal


@dataclass
class BacktestResult:
    equity_curve: list[EquityPoint]
    fills: list[Fill]
    orders: list[Order]
    config: BacktestConfig
    final_cash: Decimal
    final_equity: Decimal
    realized_pnl: Decimal
    metrics: dict[str, float]


class BacktestContext(Context):
    def __init__(
        self,
        portfolio: Portfolio,
        history: dict[str, list[Bar]],
        config: BacktestConfig,
    ) -> None:
        self._portfolio = portfolio
        self._history = history
        self._config = config
        self._ts: datetime | None = None
        self._bars: dict[str, Bar] = {}
        self._day_index = 0
        self._intents: dict[str, OrderIntent] = {}

    def _begin(self, ts: datetime, bars: Mapping[str, Bar], day_index: int) -> None:
        self._ts = ts
        self._bars = dict(bars)
        self._day_index = day_index
        self._intents.clear()

    def _take_intents(self) -> list[OrderIntent]:
        return list(self._intents.values())

    @property
    def cash(self) -> Decimal:
        return self._portfolio.cash

    @property
    def equity(self) -> Decimal:
        return self._portfolio.equity()

    @property
    def positions(self) -> Mapping[str, Position]:
        return self._portfolio.positions

    def history(self, symbol: str, count: int, field: str = "close") -> list[Decimal]:
        if count <= 0:
            return []
        bars = self._history.get(symbol, [])
        selected = bars[-count:]
        if field == "volume":
            return [Decimal(bar.volume) for bar in selected]
        if field not in ("open", "high", "low", "close", "amount"):
            raise ValueError(f"unsupported history field {field!r}")
        return [getattr(bar, field) for bar in selected]

    def order_target_percent(self, symbol: str, target: Decimal | float) -> None:
        target_decimal = _dec(target)
        if not (ZERO <= target_decimal <= Decimal("1")):
            raise ValueError("target must be between 0 and 1 without leverage")
        price = self._current_price(symbol)
        if price <= 0 or self._ts is None:
            return

        position = self._portfolio.positions.get(symbol)
        current_quantity = position.quantity if position else 0
        today = self._ts.date()

        if target_decimal == 0:
            if position is not None:
                quantity = position.available_quantity(today)
                if quantity > 0:
                    self._intents[symbol] = OrderIntent(
                        symbol=symbol,
                        side=Side.SELL,
                        quantity=quantity,
                        reason="target_zero",
                    )
            return

        target_value = self.equity * target_decimal
        current_value = price * current_quantity
        delta = target_value - current_value
        if abs(delta) < price * self._config.lot_size:
            return

        if delta > 0:
            quantity = int(delta / price)
            quantity = (quantity // self._config.lot_size) * self._config.lot_size
            if quantity > 0:
                self._intents[symbol] = OrderIntent(
                    symbol=symbol,
                    side=Side.BUY,
                    quantity=quantity,
                    reason="target_percent",
                )
            return

        quantity = int(-delta / price)
        quantity = (quantity // self._config.lot_size) * self._config.lot_size
        available = position.available_quantity(today) if position else 0
        quantity = min(quantity, available)
        if quantity > 0:
            self._intents[symbol] = OrderIntent(
                symbol=symbol,
                side=Side.SELL,
                quantity=quantity,
                reason="target_percent",
            )

    def order_shares(self, symbol: str, quantity: int) -> None:
        if quantity == 0 or self._ts is None:
            return
        side = Side.BUY if quantity > 0 else Side.SELL
        requested = abs(quantity)
        if side == Side.BUY:
            requested = (requested // self._config.lot_size) * self._config.lot_size
        else:
            position = self._portfolio.positions.get(symbol)
            requested = min(requested, position.available_quantity(self._ts.date()) if position else 0)
        if requested > 0:
            self._intents[symbol] = OrderIntent(symbol=symbol, side=side, quantity=requested, reason="order_shares")

    def is_rebalance_day(self, every_n: int) -> bool:
        return every_n > 0 and self._day_index % every_n == 0

    def _current_price(self, symbol: str) -> Decimal:
        bar = self._bars.get(symbol)
        if bar is not None:
            return bar.close
        position = self._portfolio.positions.get(symbol)
        return position.last_price if position else ZERO


class BacktestEngine:
    def __init__(self, config: BacktestConfig | None = None) -> None:
        self.config = config or BacktestConfig()
        self._fill_sequence = 0

    def run(self, strategy: Strategy, bars: Iterable[Bar]) -> BacktestResult:
        self._fill_sequence = 0
        grouped = self._group(bars)
        portfolio = Portfolio(cash=self.config.initial_cash, initial_cash=self.config.initial_cash)
        history: dict[str, list[Bar]] = defaultdict(list)
        context = BacktestContext(portfolio, history, self.config)
        pending: list[Order] = []
        all_orders: list[Order] = []
        fills: list[Fill] = []
        equity_curve: list[EquityPoint] = []
        order_sequence = 0
        fill_sequence = 0

        strategy.on_start(context)

        for day_index, ts in enumerate(sorted(grouped)):
            day_bars = grouped[ts]
            context._begin(ts, day_bars, day_index)

            executed_fills, changed_orders = self._execute_pending(pending, day_bars, ts, portfolio)
            for order in changed_orders:
                strategy.on_order(context, order)
            for fill in executed_fills:
                fills.append(fill)
                strategy.on_fill(context, fill)

            for symbol, bar in day_bars.items():
                history[symbol].append(bar)
                position = portfolio.positions.get(symbol)
                if position is not None:
                    position.last_price = bar.close

            strategy.on_bars(context, day_bars)

            for intent in context._take_intents():
                order_sequence += 1
                order = Order(
                    order_id=f"ord_{order_sequence:06d}",
                    client_order_id=intent.client_order_id
                    or f"bt_{ts.strftime('%Y%m%d%H%M%S')}_{intent.symbol}_{order_sequence}",
                    symbol=intent.symbol,
                    side=intent.side,
                    order_type=intent.order_type,
                    quantity=intent.quantity,
                    limit_price=intent.limit_price,
                    created_at=ts,
                    remaining=intent.quantity,
                )
                pending.append(order)
                all_orders.append(order)
                strategy.on_order(context, order)

            equity = portfolio.equity()
            equity_curve.append(
                EquityPoint(
                    ts=ts,
                    equity=equity,
                    cash=portfolio.cash,
                    market_value=equity - portfolio.cash,
                )
            )

        for order in pending:
            if order.is_open:
                order.status = OrderStatus.CANCELED

        final_equity = equity_curve[-1].equity if equity_curve else self.config.initial_cash
        final_cash = portfolio.cash
        metrics = self._metrics(equity_curve, fills, all_orders)
        return BacktestResult(
            equity_curve=equity_curve,
            fills=fills,
            orders=all_orders,
            config=self.config,
            final_cash=final_cash,
            final_equity=final_equity,
            realized_pnl=portfolio.realized_pnl,
            metrics=metrics,
        )

    def _execute_pending(
        self,
        pending: list[Order],
        day_bars: Mapping[str, Bar],
        ts: datetime,
        portfolio: Portfolio,
    ) -> tuple[list[Fill], list[Order]]:
        fills: list[Fill] = []
        changed: list[Order] = []
        for order in pending:
            if not order.is_open:
                continue
            bar = day_bars.get(order.symbol)
            if bar is None or bar.suspended:
                if order.order_type == OrderType.MARKET:
                    order.status = OrderStatus.REJECTED
                    order.reject_reason = "no_tradable_bar"
                    order.remaining = 0
                    changed.append(order)
                continue

            quantity, price = self._match(order, bar, portfolio)
            if quantity <= 0:
                if order.order_type == OrderType.MARKET:
                    order.status = OrderStatus.REJECTED
                    order.reject_reason = "unfillable"
                    order.remaining = 0
                    changed.append(order)
                continue

            fill = self._apply_fill(order, quantity, price, ts, portfolio)
            order.remaining -= quantity
            order.status = OrderStatus.FILLED if order.remaining == 0 else OrderStatus.PARTIALLY_FILLED
            fills.append(fill)
            changed.append(order)
        return fills, changed

    def _match(self, order: Order, bar: Bar, portfolio: Portfolio) -> tuple[int, Decimal]:
        if bar.limit_up is not None and bar.low >= bar.limit_up:
            return 0, ZERO
        if bar.limit_down is not None and bar.high <= bar.limit_down:
            return 0, ZERO

        slippage = self.config.slippage_bps / BPS
        if order.order_type == OrderType.MARKET:
            if order.side == Side.BUY:
                price = bar.open * (Decimal("1") + slippage)
                if bar.limit_up is not None:
                    price = min(price, bar.limit_up)
            else:
                price = bar.open * (Decimal("1") - slippage)
                if bar.limit_down is not None:
                    price = max(price, bar.limit_down)
        else:
            if order.limit_price is None:
                return 0, ZERO
            if order.side == Side.BUY:
                if bar.open <= order.limit_price:
                    price = bar.open
                elif bar.low <= order.limit_price:
                    price = order.limit_price
                else:
                    return 0, ZERO
            else:
                if bar.open >= order.limit_price:
                    price = bar.open
                elif bar.high >= order.limit_price:
                    price = order.limit_price
                else:
                    return 0, ZERO

        if order.side == Side.BUY and bar.limit_up is not None and price > bar.limit_up:
            return 0, ZERO
        if order.side == Side.SELL and bar.limit_down is not None and price < bar.limit_down:
            return 0, ZERO

        price = _money(price)
        max_by_volume = int(Decimal(bar.volume) * self.config.max_volume_participation)
        quantity = min(order.remaining, max_by_volume)
        if quantity <= 0:
            return 0, ZERO

        if order.side == Side.BUY:
            quantity = (quantity // self.config.lot_size) * self.config.lot_size
            quantity = min(quantity, self._max_affordable(price, portfolio.cash))
        else:
            position = portfolio.positions.get(order.symbol)
            available = position.available_quantity(bar.ts.date()) if position else 0
            quantity = min(quantity, available)

        if quantity <= 0:
            return 0, ZERO
        return quantity, price

    def _max_affordable(self, price: Decimal, cash: Decimal) -> int:
        fee_rate = (self.config.commission_bps + self.config.transfer_fee_bps) / BPS
        unit_cost = price * (Decimal("1") + fee_rate)
        if unit_cost <= 0:
            return 0
        quantity = int(cash / unit_cost)
        quantity = (quantity // self.config.lot_size) * self.config.lot_size
        while quantity > 0:
            notional = price * quantity
            fees = self._fees(notional, Side.BUY)
            if cash >= notional + fees:
                return quantity
            quantity -= self.config.lot_size
        return 0

    def _apply_fill(
        self,
        order: Order,
        quantity: int,
        price: Decimal,
        ts: datetime,
        portfolio: Portfolio,
    ) -> Fill:
        self._fill_sequence += 1
        notional = price * quantity
        fees = self._fees(notional, order.side)
        commission, stamp_tax, transfer_fee = self._fee_parts(notional, order.side)

        if order.side == Side.BUY:
            total = notional + fees
            if portfolio.cash < total:
                raise RuntimeError("risk/cash check failed during fill")
            portfolio.cash -= total
            position = portfolio.positions.setdefault(order.symbol, Position(symbol=order.symbol))
            available_on = ts.date() + timedelta(days=1) if self.config.t_plus_one else ts.date()
            position.add(quantity, price, fees, available_on)
        else:
            position = portfolio.positions.get(order.symbol)
            cost = position.remove(quantity, ts.date()) if position else None
            if cost is None:
                raise RuntimeError("position check failed during fill")
            portfolio.cash += notional - fees
            portfolio.realized_pnl += notional - fees - cost

        return Fill(
            fill_id=f"fill_{self._fill_sequence:06d}",
            order_id=order.order_id,
            symbol=order.symbol,
            side=order.side,
            quantity=quantity,
            price=price,
            commission=commission,
            stamp_tax=stamp_tax,
            transfer_fee=transfer_fee,
            ts=ts,
        )

    def _fees(self, notional: Decimal, side: Side) -> Decimal:
        commission, stamp_tax, transfer_fee = self._fee_parts(notional, side)
        return commission + stamp_tax + transfer_fee

    def _fee_parts(self, notional: Decimal, side: Side) -> tuple[Decimal, Decimal, Decimal]:
        commission = _money(notional * self.config.commission_bps / BPS)
        if commission < self.config.min_commission:
            commission = _money(self.config.min_commission)
        stamp_tax = _money(notional * self.config.stamp_tax_bps / BPS) if side == Side.SELL else ZERO
        transfer_fee = _money(notional * self.config.transfer_fee_bps / BPS)
        return commission, stamp_tax, transfer_fee

    def _group(self, bars: Iterable[Bar]) -> dict[datetime, dict[str, Bar]]:
        grouped: dict[datetime, dict[str, Bar]] = defaultdict(dict)
        for bar in bars:
            if bar.symbol in grouped[bar.ts]:
                raise ValueError(f"duplicate bar for {bar.symbol} at {bar.ts}")
            grouped[bar.ts][bar.symbol] = bar
        return dict(grouped)

    def _metrics(
        self,
        equity_curve: list[EquityPoint],
        fills: list[Fill],
        orders: list[Order],
    ) -> dict[str, float]:
        if not equity_curve:
            return {
                "total_return": 0.0,
                "annualized_return": 0.0,
                "max_drawdown": 0.0,
                "sharpe": 0.0,
                "turnover": 0.0,
                "trade_count": 0.0,
                "order_count": 0.0,
                "final_equity": float(self.config.initial_cash),
            }

        initial = equity_curve[0].equity
        final = equity_curve[-1].equity
        total_return = float(final / initial - 1) if initial > 0 else 0.0
        days = max((equity_curve[-1].ts - equity_curve[0].ts).days, 1)
        annualized = 0.0
        if total_return > -1:
            annualized = float((Decimal("1") + Decimal(str(total_return))) ** (Decimal("365") / days) - 1)

        returns: list[float] = []
        peak = equity_curve[0].equity
        max_drawdown = 0.0
        for previous, current in zip(equity_curve, equity_curve[1:]):
            if previous.equity > 0:
                returns.append(float(current.equity / previous.equity - 1))
            if current.equity > peak:
                peak = current.equity
            if peak > 0:
                drawdown = float(Decimal("1") - current.equity / peak)
                max_drawdown = max(max_drawdown, drawdown)

        sharpe = 0.0
        if len(returns) > 1:
            mean = sum(returns) / len(returns)
            deviation = pstdev(returns)
            if deviation > 0:
                sharpe = mean / deviation * sqrt(252)

        turnover = float(sum((fill.notional for fill in fills), ZERO) / self.config.initial_cash)
        return {
            "total_return": total_return,
            "annualized_return": annualized,
            "max_drawdown": max_drawdown,
            "sharpe": sharpe,
            "turnover": turnover,
            "trade_count": float(len(fills)),
            "order_count": float(len(orders)),
            "final_equity": float(final),
        }
