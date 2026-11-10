from __future__ import annotations

import unittest
from datetime import date, datetime
from decimal import Decimal

from qtrade_research.data import InMemoryDataPortal, SnapshotDataPortal
from qtrade_research.domain import Bar


def bar(symbol: str, day: int) -> Bar:
    return Bar(
        symbol=symbol,
        ts=datetime(2025, 1, day, 15, 0),
        open=Decimal("10"),
        high=Decimal("10.5"),
        low=Decimal("9.5"),
        close=Decimal("10.2"),
        volume=1_000_000,
    )


class TestInMemoryDataPortal(unittest.TestCase):
    def test_bars_are_filtered_and_sorted(self) -> None:
        portal = InMemoryDataPortal(
            snapshot_id="snap_1",
            bars_by_symbol={
                "600000.SH": [bar("600000.SH", 3), bar("600000.SH", 2)],
                "000001.SZ": [bar("000001.SZ", 2)],
            },
        )
        result = portal.bars(
            ["600000.SH", "000001.SZ"],
            date(2025, 1, 2),
            date(2025, 1, 2),
            snapshot_id="snap_1",
        )
        self.assertEqual([(item.ts.day, item.symbol) for item in result], [(2, "000001.SZ"), (2, "600000.SH")])

    def test_unknown_snapshot_is_rejected(self) -> None:
        portal = InMemoryDataPortal(snapshot_id="snap_1")
        with self.assertRaises(ValueError):
            portal.bars(["600000.SH"], date(2025, 1, 2), date(2025, 1, 3), snapshot_id="snap_2")


if __name__ == "__main__":
    unittest.main()

class TestSnapshotDataPortal(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        from pathlib import Path

        from qtrade_research.data.store import DatasetStore

        self._tmp = tempfile.TemporaryDirectory()
        self.store = DatasetStore(Path(self._tmp.name), prefer_csv=True)
        self.store.append(
            "bars_1d",
            [bar("600000.SH", 2), bar("600000.SH", 3), bar("000001.SZ", 3)],
            source="test",
            frequency="1d",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_bars_come_from_snapshot(self) -> None:
        portal = SnapshotDataPortal(store=self.store)
        result = portal.bars(["600000.SH"], date(2025, 1, 3), date(2025, 1, 3))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].symbol, "600000.SH")

    def test_instruments_fall_back_to_coverage(self) -> None:
        portal = SnapshotDataPortal(store=self.store)
        rows = portal.instruments(date(2025, 1, 3))
        self.assertEqual([row["symbol"] for row in rows], ["000001.SZ", "600000.SH"])

if __name__ == "__main__":
    unittest.main()
