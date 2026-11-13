from __future__ import annotations

import unittest
from datetime import date, datetime
from decimal import Decimal

from qtrade_research.data.collector import CollectionRequest, _window_start
from qtrade_research.data.sources.xueqiu import parse_daily_items
from qtrade_research.data.symbols import Symbol

SYMBOL = Symbol(code="600000", exchange="SH")
TODAY = date(2026, 11, 13)


class TestXueqiuParsing(unittest.TestCase):
    def test_daily_row_is_normalised(self) -> None:
        items = [
            [1793894400000, 41_145_181, 10.19, 10.39, 10.12, 10.38, 0.17, 1.66, 0.14, 421_986_515.0],
        ]
        bars = parse_daily_items(items, SYMBOL)
        self.assertEqual(len(bars), 1)
        bar = bars[0]
        self.assertEqual(bar.symbol, "600000.SH")
        self.assertEqual(bar.ts, datetime(2026, 11, 6, 15, 0))
        self.assertEqual(bar.close, Decimal("10.38"))
        self.assertEqual(bar.high, Decimal("10.39"))
        # Xueqiu already reports shares, unlike Eastmoney's lots.
        self.assertEqual(bar.volume, 41_145_181)
        self.assertEqual(bar.amount, Decimal("421986515.0"))

    def test_invalid_row_is_skipped_not_fatal(self) -> None:
        items = [
            [1793894400000, 1_000, 34.6, 34.7, 33.52, 33.09, -2.14, -6.07, 14.83, 1.0],
            [1793808000000, 2_000, 10.0, 10.5, 9.8, 10.2, 0.2, 2.0, 1.0, 2.0],
        ]
        bars = parse_daily_items(items, SYMBOL)
        self.assertEqual([bar.close for bar in bars], [Decimal("10.2")])


class TestBackfillWindow(unittest.TestCase):
    coverage = {"600000.SH": {"start": "2020-01-02", "end": "2026-11-11"}}

    def test_plain_incremental_starts_after_last_bar(self) -> None:
        request = CollectionRequest(
            symbols=[SYMBOL], start=date(1990, 1, 1), end=TODAY, incremental=True
        )
        self.assertEqual(_window_start(request, SYMBOL, self.coverage, TODAY), date(2026, 11, 12))

    def test_backfill_extends_to_requested_start(self) -> None:
        request = CollectionRequest(
            symbols=[SYMBOL], start=date(1990, 1, 1), end=TODAY, incremental=True, backfill=True
        )
        self.assertEqual(_window_start(request, SYMBOL, self.coverage, TODAY), date(1990, 1, 1))

    def test_backfill_is_a_noop_when_already_covered(self) -> None:
        coverage = {"600000.SH": {"start": "1990-01-01", "end": "2026-11-11"}}
        request = CollectionRequest(
            symbols=[SYMBOL], start=date(1990, 1, 1), end=TODAY, incremental=True, backfill=True
        )
        self.assertIsNone(_window_start(request, SYMBOL, coverage, TODAY))


if __name__ == "__main__":
    unittest.main()