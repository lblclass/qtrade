from __future__ import annotations

import unittest
from datetime import datetime
from decimal import Decimal

from qtrade_research.data.sources.eastmoney import parse_daily_klines, parse_minute_klines
from qtrade_research.data.symbols import Symbol

SYMBOL = Symbol(code="600000", exchange="SH")


class TestEastMoneyParsing(unittest.TestCase):
    def test_daily_row_is_normalised(self) -> None:
        lines = ["2025-01-02,9.47,9.30,9.59,9.22,789071,803904040.00,3.91,-1.69,-0.16,0.27"]
        bars = parse_daily_klines(lines, SYMBOL)
        self.assertEqual(len(bars), 1)
        bar = bars[0]
        self.assertEqual(bar.symbol, "600000.SH")
        self.assertEqual(bar.ts, datetime(2025, 1, 2, 15, 0))
        self.assertEqual(bar.close, Decimal("9.30"))
        self.assertEqual(bar.high, Decimal("9.59"))
        # Eastmoney reports lots; the domain stores shares.
        self.assertEqual(bar.volume, 78_907_100)
        self.assertEqual(bar.amount, Decimal("803904040.00"))

    def test_minute_row_is_normalised(self) -> None:
        lines = ["2026-11-06 09:31,9.91,9.88,9.95,9.84,44821,44355186.00"]
        bars = parse_minute_klines(lines, SYMBOL)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0].ts, datetime(2026, 11, 6, 9, 31))
        self.assertEqual(bars[0].volume, 4_482_100)

    def test_malformed_rows_are_skipped(self) -> None:
        lines = ["", "bad,row", "2025-01-02,abc,9.30,9.59,9.22,789071,803904040.00"]
        self.assertEqual(parse_daily_klines(lines, SYMBOL), [])


if __name__ == "__main__":
    unittest.main()