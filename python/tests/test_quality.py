from __future__ import annotations

import unittest
from datetime import date, datetime
from decimal import Decimal

from qtrade_research.data.quality import check_bars
from qtrade_research.domain import Bar


def bar(day: int, close: str = "10.00", hour: int = 15, minute: int = 0, volume: int = 1000) -> Bar:
    price = Decimal(close)
    return Bar(
        symbol="600000.SH",
        ts=datetime(2025, 1, day, hour, minute),
        open=price,
        high=price * Decimal("1.01"),
        low=price * Decimal("0.99"),
        close=price,
        volume=volume,
        amount=price * volume,
    )


class TestQualityGate(unittest.TestCase):
    def test_duplicate_timestamp_keeps_last(self) -> None:
        accepted, report = check_bars([bar(2), bar(2, close="11.00")], "1d")
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0].close, Decimal("11.00"))
        self.assertEqual(report.duplicates, 1)

    def test_calendar_gap_is_reported(self) -> None:
        calendar = [date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 6)]
        accepted, report = check_bars([bar(2), bar(6)], "1d", calendar=calendar)
        self.assertEqual(len(accepted), 2)
        codes = [issue.code for issue in report.issues]
        self.assertIn("calendar_gap", codes)

    def test_return_outlier_is_reported(self) -> None:
        _, report = check_bars([bar(2, "10.00"), bar(3, "18.00")], "1d")
        codes = [issue.code for issue in report.issues]
        self.assertIn("return_outlier", codes)

    def test_off_session_minute_bar_warns(self) -> None:
        _, report = check_bars([bar(2, hour=16)], "1m")
        codes = [issue.code for issue in report.issues]
        self.assertIn("off_session", codes)

    def test_zero_amount_warns(self) -> None:
        stub = Bar(
            symbol="600000.SH",
            ts=datetime(2025, 1, 2, 15, 0),
            open=Decimal("10"),
            high=Decimal("10"),
            low=Decimal("10"),
            close=Decimal("10"),
            volume=100,
            amount=Decimal("0"),
        )
        _, report = check_bars([stub], "1d")
        self.assertIn("zero_amount", [issue.code for issue in report.issues])


if __name__ == "__main__":
    unittest.main()