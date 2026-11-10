"""Contracts shared by every market data adapter."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Protocol, runtime_checkable

from ...domain import Bar
from ..symbols import Symbol


class SourceError(RuntimeError):
    """A data source failed for one request (network, auth, malformed payload)."""


@dataclass(frozen=True)
class Instrument:
    symbol: str
    name: str
    exchange: str
    board: str
    is_active: bool = True
    list_date: date | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "exchange": self.exchange,
            "board": self.board,
            "is_active": self.is_active,
            "list_date": self.list_date.isoformat() if self.list_date else None,
        }


@dataclass(frozen=True)
class Capability:
    """What an adapter can deliver, used by ``qtrade-data sources``."""

    daily: bool = True
    minute_intervals: tuple[int, ...] = ()
    instruments: bool = True
    calendar: bool = True
    adjustments: tuple[str, ...] = ("none",)
    notes: str = ""


@dataclass
class SourceResponse:
    """Bars plus the untouched vendor payload for raw landing."""

    bars: list[Bar]
    raw: bytes | None = None
    meta: dict[str, object] = field(default_factory=dict)


@runtime_checkable
class MarketDataSource(Protocol):
    name: str
    capability: Capability

    def instruments(self) -> list[Instrument]: ...

    def fetch_daily(
        self, symbol: Symbol, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse: ...

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse: ...

    def trading_days(self, start: date, end: date) -> list[date]: ...