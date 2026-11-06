from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Protocol

from .domain import Bar, Fill, Order, Position


class Context(Protocol):
    @property
    def cash(self) -> Decimal: ...

    @property
    def equity(self) -> Decimal: ...

    @property
    def positions(self) -> Mapping[str, Position]: ...

    def history(self, symbol: str, count: int, field: str = "close") -> list[Decimal]: ...

    def order_target_percent(self, symbol: str, target: Decimal | float) -> None: ...

    def order_shares(self, symbol: str, quantity: int) -> None: ...

    def is_rebalance_day(self, every_n: int) -> bool: ...


class Strategy:
    """Base class for strategies shared by backtest, paper and live runtimes."""

    def on_start(self, ctx: Context) -> None:
        """Called once before the first bar."""

    def on_bars(self, ctx: Context, bars: Mapping[str, Bar]) -> None:
        """Called once per timestamp with all symbols that have a bar."""
        raise NotImplementedError

    def on_fill(self, ctx: Context, fill: Fill) -> None:
        """Called after a fill is applied."""

    def on_order(self, ctx: Context, order: Order) -> None:
        """Called when an order changes state."""

