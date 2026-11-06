from __future__ import annotations

import unittest
from datetime import date, datetime
from decimal import Decimal

from qtrade_research.backtest import BacktestConfig, BacktestEngine
from qtrade_research.domain import Bar, OrderStatus, Position, Side
from qtrade_research.strategies.momentum import MomentumStrategy
from qtrade_research.strategy import Context, Strategy
from qtrade_research.cli import _demo_bars


def make_bar(
    ts: datetime,
    *,
    open_price: str = "10",
    close_price: str | None = None,
    high: str | None = None,
    low: str | None = None,
    volume: int = 1_000_000,
    limit_up: str | None = None,
    limit_down: str | None = None,
) -> Bar:
    close = Decimal(close_price or open_price)
    open_decimal = Decimal(open_price)
    high_decimal = Decimal(high) if high is not None else max(open_decimal, close)
    low_decimal = Decimal(low) if low is not None else min(open_decimal, close)
    return Bar(
        symbol="600000.SH",
        ts=ts,
        open=open_decimal,
        high=high_decimal,
        low=low_decimal,
        close=close,
        volume=volume,
        limit_up=Decimal(limit_up) if limit_up is not None else None,
        limit_down=Decimal(limit_down) if limit_down is not None else None,
    )


class BuyOnce(Strategy):
    def __init__(self, quantity: int = 100) -> None:
        self.quantity = quantity
        self.called = False

    def on_bars(self, ctx: Context, bars: dict[str, Bar]) -> None:
        if self.called:
            return
        self.called = True
        ctx.order_shares("600000.SH", self.quantity)


class HalfPosition(Strategy):
    def __init__(self) -> None:
        self.called = False

    def on_bars(self, ctx: Context, bars: dict[str, Bar]) -> None:
        if self.called:
            return
        self.called = True
        ctx.order_target_percent("600000.SH", Decimal("0.5"))


class BuyThenSellAll(Strategy):
    def __init__(self) -> None:
        self.calls = 0

    def on_bars(self, ctx: Context, bars: dict[str, Bar]) -> None:
        self.calls += 1
        if self.calls == 1:
            ctx.order_shares("600000.SH", 100)
        elif self.calls >= 3:
            ctx.order_target_percent("600000.SH", Decimal("0"))


class TestPositionSettlement(unittest.TestCase):
    def test_t_plus_one_available_quantity_and_cost(self) -> None:
        position = Position(symbol="600000.SH")
        position.add(
            quantity=100,
            price=Decimal("10"),
            fees=Decimal("5"),
            available_on=date(2025, 1, 3),
        )
        self.assertEqual(position.available_quantity(date(2025, 1, 2)), 0)
        self.assertEqual(position.available_quantity(date(2025, 1, 3)), 100)
        cost = position.remove(100, date(2025, 1, 2))
        self.assertIsNone(cost)
        cost = position.remove(100, date(2025, 1, 3))
        self.assertEqual(cost, Decimal("1005.00"))
        self.assertEqual(position.quantity, 0)


class TestBacktestEngine(unittest.TestCase):
    def test_buy_is_filled_on_next_bar(self) -> None:
        bars = [
            make_bar(datetime(2025, 1, 2, 9, 30)),
            make_bar(datetime(2025, 1, 2, 9, 31), open_price="10.10"),
        ]
        result = BacktestEngine(
            BacktestConfig(initial_cash=100_000, slippage_bps=0, max_volume_participation=1)
        ).run(BuyOnce(), bars)
        self.assertEqual(len(result.fills), 1)
        self.assertEqual(result.fills[0].quantity, 100)
        self.assertEqual(result.fills[0].price, Decimal("10.10"))
        self.assertGreater(result.final_equity, Decimal("0"))

    def test_limit_up_blocks_buy(self) -> None:
        bars = [
            make_bar(datetime(2025, 1, 2, 9, 30)),
            make_bar(
                datetime(2025, 1, 2, 9, 31),
                open_price="11",
                high="11",
                low="11",
                limit_up="11",
            ),
        ]
        result = BacktestEngine(
            BacktestConfig(initial_cash=100_000, slippage_bps=0, max_volume_participation=1)
        ).run(BuyOnce(), bars)
        self.assertEqual(len(result.fills), 0)
        self.assertEqual(result.orders[0].status, OrderStatus.REJECTED)
        self.assertEqual(result.orders[0].reject_reason, "unfillable")

    def test_fees_are_applied(self) -> None:
        bars = [
            make_bar(datetime(2025, 1, 2, 9, 30)),
            make_bar(datetime(2025, 1, 2, 9, 31), open_price="10", close_price="10"),
        ]
        result = BacktestEngine(
            BacktestConfig(
                initial_cash=100_000,
                commission_bps=2.5,
                min_commission=5,
                stamp_tax_bps=5,
                transfer_fee_bps=0.1,
                slippage_bps=0,
                max_volume_participation=1,
            )
        ).run(BuyOnce(), bars)
        self.assertEqual(len(result.fills), 1)
        self.assertEqual(result.fills[0].commission, Decimal("5.00"))
        self.assertEqual(result.fills[0].transfer_fee, Decimal("0.01"))
        self.assertEqual(result.final_cash, Decimal("98994.99"))

    def test_target_percent_sizing(self) -> None:
        bars = [
            make_bar(datetime(2025, 1, 2, 9, 30)),
            make_bar(datetime(2025, 1, 2, 9, 31), open_price="10", close_price="10"),
            make_bar(datetime(2025, 1, 3, 9, 30), open_price="10", close_price="10"),
        ]
        result = BacktestEngine(
            BacktestConfig(initial_cash=100_000, slippage_bps=0, max_volume_participation=1)
        ).run(HalfPosition(), bars)
        self.assertEqual(len(result.fills), 1)
        self.assertEqual(result.fills[0].quantity, 5_000)

    def test_t_plus_one_allows_sell_on_next_trading_day(self) -> None:
        bars = [
            make_bar(datetime(2025, 1, 2, 9, 30)),
            make_bar(datetime(2025, 1, 3, 9, 30), open_price="10", close_price="10"),
            make_bar(datetime(2025, 1, 4, 9, 30), open_price="10", close_price="10"),
            make_bar(datetime(2025, 1, 5, 9, 30), open_price="10", close_price="10"),
        ]
        result = BacktestEngine(
            BacktestConfig(initial_cash=100_000, slippage_bps=0, max_volume_participation=1)
        ).run(BuyThenSellAll(), bars)
        self.assertEqual(len(result.fills), 2)
        self.assertEqual(result.fills[0].side, Side.BUY)
        self.assertEqual(result.fills[1].side, Side.SELL)
        self.assertEqual(result.fills[1].quantity, 100)

    def test_backtest_is_deterministic(self) -> None:
        engine = BacktestEngine(BacktestConfig(initial_cash=1_000_000))
        first = engine.run(MomentumStrategy(), _demo_bars())
        second = engine.run(MomentumStrategy(), _demo_bars())
        self.assertEqual(first.metrics, second.metrics)
        self.assertEqual(
            [(point.equity, point.cash) for point in first.equity_curve],
            [(point.equity, point.cash) for point in second.equity_curve],
        )


if __name__ == "__main__":
    unittest.main()
