from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Protocol

from ..domain import Bar

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .store import DatasetStore


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



@dataclass
class SnapshotDataPortal:
    """Read point-in-time bars from the partitioned snapshot store."""

    store: "DatasetStore"
    dataset: str = "bars_1d"
    interval: int | None = None
    snapshot_id: str = ""

    def bars(
        self,
        symbols: list[str],
        start: date,
        end: date,
        frequency: str = "1d",
        snapshot_id: str | None = None,
    ) -> list[Bar]:
        if snapshot_id is not None and self.snapshot_id and snapshot_id != self.snapshot_id:
            raise ValueError(f"snapshot {snapshot_id} is not available")
        if frequency == "1d":
            dataset, interval = self.dataset, None
        elif frequency == "1m":
            dataset, interval = "bars_1m", self.interval
        else:
            raise ValueError(f"unsupported frequency: {frequency}")
        keys = [item if isinstance(item, str) else item.key for item in symbols]
        return self.store.load(dataset, symbols=keys, start=start, end=end, interval=interval)

    def instruments(self, as_of: date) -> list[dict[str, object]]:
        directory = self.store.root / "instruments"
        snapshots = sorted(path for path in directory.glob("*") if path.is_dir()) if directory.exists() else []
        if snapshots:
            instruments: list[dict[str, object]] = []
            with (snapshots[-1] / "instruments.csv").open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    list_date = row.get("list_date") or ""
                    if list_date and date.fromisoformat(list_date) > as_of:
                        continue
                    if str(row.get("is_active", "True")).lower() not in ("true", "1"):
                        continue
                    instruments.append(dict(row))
            if instruments:
                return instruments

        coverage = self.store.coverage(self.dataset, self.interval)
        return [{"symbol": symbol, "as_of": as_of.isoformat()} for symbol in sorted(coverage)]
