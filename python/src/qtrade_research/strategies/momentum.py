from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal

from ..domain import Bar
from ..strategy import Context, Strategy


class MomentumStrategy(Strategy):
    """Simple cross-sectional momentum example for the skeleton."""

    def __init__(self, lookback: int = 5, top_n: int = 2, rebalance_every: int = 5) -> None:
        if lookback <= 0:
            raise ValueError("lookback must be positive")
        if top_n <= 0:
            raise ValueError("top_n must be positive")
        if rebalance_every <= 0:
            raise ValueError("rebalance_every must be positive")
        self.lookback = lookback
        self.top_n = top_n
        self.rebalance_every = rebalance_every

    def on_bars(self, ctx: Context, bars: Mapping[str, Bar]) -> None:
        if not ctx.is_rebalance_day(self.rebalance_every):
            return

        scores: dict[str, Decimal] = {}
        for symbol in bars:
            closes = ctx.history(symbol, self.lookback + 1)
            if len(closes) < self.lookback + 1 or closes[0] <= 0:
                continue
            scores[symbol] = closes[-1] / closes[0] - 1

        selected = sorted(scores, key=scores.get, reverse=True)[: self.top_n]
        weight = Decimal("1") / Decimal(len(selected)) if selected else Decimal("0")
        for symbol in bars:
            ctx.order_target_percent(symbol, weight if symbol in selected else Decimal("0"))

