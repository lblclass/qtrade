from __future__ import annotations

import unittest
from datetime import datetime
from decimal import Decimal

from qtrade_research.data.sources.sina import parse_payload, parse_rows
from qtrade_research.data.symbols import Symbol

SYMBOL = Symbol(code="600000", exchange="SH")


class TestSinaParsing(unittest.TestCase):
    def test_daily_rows_are_date_only(self) -> None:
        rows = [{"day": "2026-11-06", "open": "9.670", "high": "9.680", "low": "9.660", "close": "9.680",
                 "volume": "1348700", "amount": "13046709.0334"}]
        bars = parse_rows(rows, SYMBOL)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0].ts, datetime(2026, 11, 6, 15, 0))
        self.assertEqual(bars[0].close, Decimal("9.680"))

    def test_intraday_rows_keep_timestamp(self) -> None:
        rows = [{"day": "2026-11-06 09:35:00", "open": "9.67", "high": "9.68", "low": "9.66",
                 "close": "9.68", "volume": "100", "amount": "968"}]
        bars = parse_rows(rows, SYMBOL)
        self.assertEqual(bars[0].ts, datetime(2026, 11, 6, 9, 35))

    def test_jsonp_payload_is_unwrapped(self) -> None:
        text = '/*<script>location.href="//sina.com";</script>*/\nvar _=([{"day":"2026-11-06"}]);'
        self.assertEqual(parse_payload(text), [{"day": "2026-11-06"}])


if __name__ == "__main__":
    unittest.main()
