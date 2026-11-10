from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from qtrade_research.data.store import DatasetStore
from qtrade_research.domain import Bar


def bar(ts: datetime, close: str = "10.0000") -> Bar:
    price = Decimal(close)
    return Bar(
        symbol="600000.SH",
        ts=ts,
        open=price,
        high=price,
        low=price,
        close=price,
        volume=100,
        amount=price * 100,
    )


class TestDatasetStoreCSV(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = DatasetStore(Path(self._tmp.name), prefer_csv=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_is_idempotent_and_updates_rows(self) -> None:
        first = bar(datetime(2025, 1, 2, 15, 0))
        second = bar(datetime(2025, 1, 3, 15, 0))
        record = self.store.append(
            "bars_1d", [first, second], source="test", frequency="1d", adjust="qfq"
        )
        self.assertEqual(record.rows, 2)
        self.assertEqual(self.store.storage, "csv")

        updated = bar(datetime(2025, 1, 3, 15, 0), close="11.0000")
        self.store.append("bars_1d", [updated], source="test", frequency="1d", adjust="qfq")

        loaded = self.store.load("bars_1d")
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded[-1].close, Decimal("11.0000"))

        coverage = self.store.coverage("bars_1d")
        self.assertEqual(coverage["600000.SH"]["rows"], 2)
        self.assertEqual(coverage["600000.SH"]["start"], "2025-01-02")
        self.assertEqual(coverage["600000.SH"]["end"], "2025-01-03")

    def test_load_filters_by_range_and_symbol(self) -> None:
        bars = [bar(datetime(2025, 1, day, 15, 0)) for day in (2, 3, 6)]
        self.store.append("bars_1d", bars, source="test", frequency="1d")
        result = self.store.load("bars_1d", start=date(2025, 1, 3), end=date(2025, 1, 3))
        self.assertEqual([item.ts.day for item in result], [3])

    def test_manifest_and_raw_landing(self) -> None:
        record = self.store.append(
            "bars_1d", [bar(datetime(2025, 1, 2, 15, 0))], source="test", frequency="1d"
        )
        manifests = self.store.manifests()
        self.assertEqual(manifests[0]["snapshot_id"], record.snapshot_id)

        relative = self.store.write_raw("eastmoney", "bars_1d", "600000.SH", b'{"ok":1}')
        self.assertTrue((self.store.root / relative).exists())

        catalog = json.loads((self.store.root / "_catalog.json").read_text(encoding="utf-8"))
        self.assertIn("bars_1d", catalog["datasets"])


class TestDatasetStoreParquet(unittest.TestCase):
    def setUp(self) -> None:
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("pyarrow not installed")
        self._tmp = tempfile.TemporaryDirectory()
        self.store = DatasetStore(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_round_trip_keeps_decimal_precision(self) -> None:
        item = bar(datetime(2025, 1, 2, 15, 0), close="10.1234")
        self.store.append("bars_1d", [item], source="test", frequency="1d")
        loaded = self.store.load("bars_1d")
        self.assertEqual(loaded[0].close, Decimal("10.1234"))
        self.assertEqual(self.store.storage, "parquet")


if __name__ == "__main__":
    unittest.main()