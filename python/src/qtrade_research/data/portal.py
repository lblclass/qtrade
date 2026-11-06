from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from ..domain import Bar


class DataPortal(Protocol):
    """Point-in-time data access used by research and backtest workers."""

    def bars(
        self,
        symbols: list[str],
        start: date,
        end: date,
        frequency: str = "1d",
        snapshot_id: str | None = None,
    ) -> list[Bar]: ...

    def instruments(self, as_of: date) -> list[dict[str, object]]: ...


@dataclass
class InMemoryDataPortal:
    snapshot_id: str
    bars_by_symbol: dict[str, list[Bar]] = field(default_factory=dict)

    def bars(
        self,
        symbols: list[str],
        start: date,
        end: date,
        frequency: str = "1d",
        snapshot_id: str | None = None,
    ) -> list[Bar]:
        if frequency != "1d":
            raise ValueError("InMemoryDataPortal currently supports 1d bars only")
        if snapshot_id is not None and snapshot_id != self.snapshot_id:
            raise ValueError(f"snapshot {snapshot_id} is not available")

        requested = set(symbols)
        selected: list[Bar] = []
        for symbol in requested:
            for bar in self.bars_by_symbol.get(symbol, []):
                if start <= bar.ts.date() <= end:
                    selected.append(bar)
        selected.sort(key=lambda bar: (bar.ts, bar.symbol))
        return selected

    def instruments(self, as_of: date) -> list[dict[str, object]]:
        return [{"symbol": symbol, "as_of": as_of.isoformat()} for symbol in sorted(self.bars_by_symbol)]

