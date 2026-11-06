from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from .backtest import BacktestConfig, BacktestEngine
from .domain import Bar
from .strategies.momentum import MomentumStrategy

CENT = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _demo_bars(days: int = 40) -> list[Bar]:
    rng = random.Random(42)
    symbols = {
        "600000.SH": Decimal("10.00"),
        "000001.SZ": Decimal("15.00"),
        "600519.SH": Decimal("100.00"),
    }
    timestamps: list[datetime] = []
    current = datetime(2025, 1, 2, 15, 0)
    while len(timestamps) < days:
        if current.weekday() < 5:
            timestamps.append(current)
        current += timedelta(days=1)

    bars: list[Bar] = []
    for symbol, base in symbols.items():
        previous_close = base
        for ts in timestamps:
            open_price = _money(previous_close * (Decimal("1") + Decimal(str(rng.uniform(-0.01, 0.01)))))
            close_price = _money(open_price * (Decimal("1") + Decimal(str(rng.uniform(-0.03, 0.03)))))
            high = _money(max(open_price, close_price) * (Decimal("1") + Decimal(str(rng.uniform(0, 0.01)))))
            low = _money(min(open_price, close_price) * (Decimal("1") - Decimal(str(rng.uniform(0, 0.01)))))
            bars.append(
                Bar(
                    symbol=symbol,
                    ts=ts,
                    open=open_price,
                    high=high,
                    low=low,
                    close=close_price,
                    volume=5_000_000,
                    amount=close_price * 5_000_000,
                    limit_up=_money(previous_close * Decimal("1.10")),
                    limit_down=_money(previous_close * Decimal("0.90")),
                )
            )
            previous_close = close_price
    bars.sort(key=lambda bar: (bar.ts, bar.symbol))
    return bars


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] not in ("demo", "backtest"):
        raise SystemExit(f"unknown command: {sys.argv[1]}")

    engine = BacktestEngine(
        BacktestConfig(
            initial_cash=1_000_000,
            commission_bps=2.5,
            min_commission=5,
            stamp_tax_bps=5,
            transfer_fee_bps=0.1,
            slippage_bps=5,
            lot_size=100,
            max_volume_participation=0.05,
        )
    )
    result = engine.run(
        MomentumStrategy(lookback=5, top_n=2, rebalance_every=5),
        _demo_bars(),
    )
    output = {
        "metrics": result.metrics,
        "final_cash": str(result.final_cash),
        "final_equity": str(result.final_equity),
        "realized_pnl": str(result.realized_pnl),
        "fills": len(result.fills),
        "orders": len(result.orders),
        "equity_points": len(result.equity_curve),
    }
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

