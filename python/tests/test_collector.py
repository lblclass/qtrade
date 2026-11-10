from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from qtrade_research.data.collector import CollectionRequest, Collector
from qtrade_research.data.sources.base import Capability, Instrument, SourceError, SourceResponse
from qtrade_research.data.store import DatasetStore
from qtrade_research.data.symbols import Symbol
from qtrade_research.domain import Bar


def daily_bar(day: int, close: str = "10.00", symbol: str = "600000.SH") -> Bar:
    price = Decimal(close)
    return Bar(
        symbol=symbol,
        ts=datetime(2025, 1, day, 15, 0),
        open=price,
        high=price,
        low=price,
        close=price,
        volume=1000,
        amount=price * 1000,
    )


class FakeSource:
    name = "fake"
    capability = Capability(daily=True, minute_intervals=(5,), notes="test double")

    def __init__(self, failing: set[str] | None = None) -> None:
        self.failing = failing or set()
        self.calls: list[tuple[str, date, date]] = []

    def instruments(self) -> list[Instrument]:
        return [Instrument(symbol="600000.SH", name="浦发银行", exchange="SH", board="MAIN_SH")]

    def fetch_daily(self, symbol: Symbol, start: date, end: date, adjust: str = "qfq") -> SourceResponse:
        if symbol.key in self.failing:
            raise SourceError("boom")
        self.calls.append((symbol.key, start, end))
        return SourceResponse(
            bars=[daily_bar(2, symbol=symbol.key), daily_bar(3, symbol=symbol.key)],
            raw=b"raw",
            meta={"returned": 2},
        )

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        bar = Bar(
            symbol=symbol.key,
            ts=datetime(2025, 1, 2, 9, 35),
            open=Decimal("10"),
            high=Decimal("10"),
            low=Decimal("10"),
            close=Decimal("10"),
            volume=100,
            amount=Decimal("1000"),
        )
        return SourceResponse(bars=[bar], raw=b"raw", meta={"interval": interval})

    def trading_days(self, start: date, end: date) -> list[date]:
        return [date(2025, 1, 2), date(2025, 1, 3)]


class TestCollector(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = DatasetStore(Path(self._tmp.name), prefer_csv=True)
        self.symbol = Symbol(code="600000", exchange="SH")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, source: FakeSource, **overrides) -> object:
        request = CollectionRequest(
            symbols=[self.symbol],
            start=date(2025, 1, 2),
            end=date(2025, 1, 3),
            **overrides,
        )
        return Collector(source, self.store, progress=lambda message: None).run(request)

    def test_writes_snapshot_and_cleans_quality(self) -> None:
        result = self._run(FakeSource())
        self.assertEqual(result.snapshot.rows, 2)
        self.assertEqual(result.quality.accepted, 2)
        self.assertEqual(len(self.store.load("bars_1d")), 2)

    def test_incremental_skips_covered_range(self) -> None:
        self._run(FakeSource())
        source = FakeSource()
        result = self._run(source, incremental=True)
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.skipped, ["600000.SH"])
        self.assertEqual(source.calls, [])

    def test_failure_is_recorded_and_run_continues(self) -> None:
        other = Symbol(code="000001", exchange="SZ")
        request = CollectionRequest(
            symbols=[self.symbol, other],
            start=date(2025, 1, 2),
            end=date(2025, 1, 3),
        )
        source = FakeSource(failing={"600000.SH"})
        result = Collector(source, self.store, progress=lambda message: None).run(request)
        self.assertIn("600000.SH", result.failures)
        self.assertEqual(result.snapshot.symbols, 1)

    def test_all_failures_raise(self) -> None:
        with self.assertRaises(SourceError):
            self._run(FakeSource(failing={"600000.SH"}))

    def test_concurrent_mode_flushes_and_writes_one_manifest(self) -> None:
        symbols = [
            Symbol(code="600000", exchange="SH"),
            Symbol(code="000001", exchange="SZ"),
            Symbol(code="300750", exchange="SZ"),
        ]
        request = CollectionRequest(
            symbols=symbols,
            start=date(2025, 1, 2),
            end=date(2025, 1, 3),
            workers=3,
            flush_size=2,
        )
        source = FakeSource()
        result = Collector(source, self.store, progress=lambda message: None).run(request)
        self.assertEqual(result.snapshot.symbols, 3)
        self.assertEqual(result.snapshot.rows, 6)
        self.assertEqual(len(self.store.manifests()), 1)
        self.assertEqual(len(self.store.load("bars_1d")), 6)


    def test_minute_collection(self) -> None:
        result = self._run(FakeSource(), frequency="1m", interval=5)
        self.assertEqual(result.snapshot.dataset, "bars_1m")
        bars = self.store.load("bars_1m", interval=5)
        self.assertEqual(len(bars), 1)


if __name__ == "__main__":
    unittest.main()
