"""Partitioned snapshot store: raw landing, normalised bars, manifests, catalog.

Layout under ``data/`` (the root is configurable)::

    raw/<source>/<dataset>/<yyyymmdd>/<symbol>.json.gz   # untouched vendor payload
    dataset/bars_1d/symbol=600000.SH/year=2025/data.parquet
    dataset/bars_1m/5/symbol=600000.SH/year=2026/data.parquet
    _manifests/snap_20261106T124714_ab12cd.json
    _catalog.json

Writes merge on ``(symbol, ts)`` so re-running a collection is idempotent and
incremental runs can simply overlap the previous window.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from ..domain import Bar

PRICE_QUANT = Decimal("0.0001")
AMOUNT_QUANT = Decimal("0.01")
CSV_COLUMNS = (
    "symbol",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "limit_up",
    "limit_down",
    "suspended",
)


@dataclass(frozen=True)
class SnapshotRecord:
    snapshot_id: str
    dataset: str
    interval: int | None
    path: Path
    rows: int
    symbols: int
    start: date | None
    end: date | None
    storage: str

    def to_dict(self) -> dict[str, object]:
        return {
            "snapshot_id": self.snapshot_id,
            "dataset": self.dataset,
            "interval": self.interval,
            "path": str(self.path),
            "rows": self.rows,
            "symbols": self.symbols,
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "storage": self.storage,
        }


class DatasetStore:
    def __init__(self, root: str | Path, *, prefer_csv: bool = False) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.raw_dir = self.root / "raw"
        self.dataset_root = self.root / "dataset"
        self.manifest_dir = self.root / "_manifests"
        self.catalog_path = self.root / "_catalog.json"
        self._pa = None if prefer_csv else _import_pyarrow()
        self.storage = "parquet" if self._pa is not None else "csv"

    # -- raw landing -----------------------------------------------------
    def write_raw(
        self,
        source: str,
        dataset: str,
        symbol: str,
        payload: bytes,
        *,
        suffix: str = ".json",
        interval: int | None = None,
    ) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
        directory = self.raw_dir / source / dataset
        if interval is not None:
            directory = directory / str(interval)
        directory = directory / stamp
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{symbol}{suffix}.gz"
        path = directory / name
        with gzip.open(path, "wb") as handle:
            handle.write(payload)
        return str(path.relative_to(self.root)).replace("\\", "/")

    # -- normalised bars -------------------------------------------------
    def append(
        self,
        dataset: str,
        bars: list[Bar],
        *,
        source: str,
        frequency: str,
        interval: int | None = None,
        adjust: str = "none",
        quality: dict[str, object] | None = None,
        extra: dict[str, object] | None = None,
        snapshot_id: str | None = None,
        write_manifest: bool = True,
        manifest_parts: list[dict[str, object]] | None = None,
    ) -> SnapshotRecord:
        snapshot_id = snapshot_id or new_snapshot_id()
        groups: dict[tuple[str, int], list[Bar]] = {}
        for bar in bars:
            groups.setdefault((bar.symbol, bar.ts.year), []).append(bar)

        partitions: list[dict[str, object]] = []
        symbol_stats: dict[str, dict[str, object]] = {}
        for (symbol, year), items in sorted(groups.items()):
            path = self._partition_path(dataset, symbol, year, interval)
            stats = self._merge_partition(path, items)
            partitions.append(
                {
                    "symbol": symbol,
                    "year": year,
                    "path": str(path.relative_to(self.root)).replace("\\", "/"),
                    "rows": stats["rows"],
                    "added": stats["added"],
                    "checksum": stats["checksum"],
                    "start": stats["start"].isoformat() if stats["start"] else None,
                    "end": stats["end"].isoformat() if stats["end"] else None,
                }
            )
            entry = symbol_stats.setdefault(symbol, {"rows": 0, "start": None, "end": None})
            entry["rows"] = int(entry["rows"]) + int(stats["rows"])
            if stats["start"] is not None:
                current = entry["start"]
                entry["start"] = stats["start"] if current is None or stats["start"] < current else current
            if stats["end"] is not None:
                current = entry["end"]
                entry["end"] = stats["end"] if current is None or stats["end"] > current else current

        self._update_catalog(dataset, interval, symbol_stats)
        symbols = set(symbol_stats)

        start = min(bar.ts.date() for bar in bars) if bars else None
        end = max(bar.ts.date() for bar in bars) if bars else None
        record = SnapshotRecord(
            snapshot_id=snapshot_id,
            dataset=dataset,
            interval=interval,
            path=self._dataset_dir(dataset, interval),
            rows=len(bars),
            symbols=len(symbols),
            start=start,
            end=end,
            storage=self.storage,
        )
        if manifest_parts is not None:
            manifest_parts.extend(partitions)
        if write_manifest:
            self.write_manifest(
                snapshot_id,
                {
                    **record.to_dict(),
                    "source": source,
                    "frequency": frequency,
                    "adjust": adjust,
                    "partitions": manifest_parts if manifest_parts is not None else partitions,
                    "quality": quality or {},
                    "extra": extra or {},
                },
            )
        return record

    def write_manifest(self, snapshot_id: str, payload: dict[str, object]) -> None:
        manifest = {
            **payload,
            "snapshot_id": snapshot_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._write_json(self.manifest_dir / f"{snapshot_id}.json", manifest)

    def load(
        self,
        dataset: str,
        *,
        symbols: list[str] | None = None,
        start: date | None = None,
        end: date | None = None,
        interval: int | None = None,
    ) -> list[Bar]:
        base = self._dataset_dir(dataset, interval)
        if not base.exists():
            return []
        wanted = set(symbols) if symbols else None
        bars: list[Bar] = []
        for symbol_dir in sorted(base.glob("symbol=*")):
            symbol = symbol_dir.name.split("=", 1)[1]
            if wanted is not None and symbol not in wanted:
                continue
            for path in sorted(symbol_dir.glob("year=*/data.*")):
                for bar in self._read_partition(path):
                    day = bar.ts.date()
                    if start is not None and day < start:
                        continue
                    if end is not None and day > end:
                        continue
                    bars.append(bar)
        bars.sort(key=lambda bar: (bar.ts, bar.symbol))
        return bars

    def coverage(self, dataset: str, interval: int | None = None) -> dict[str, dict[str, object]]:
        catalog = self._read_catalog()
        key = _catalog_key(dataset, interval)
        datasets = catalog.get("datasets", {})
        return dict((datasets.get(key) or {}).get("symbols") or {})

    def manifests(self, limit: int = 20) -> list[dict[str, object]]:
        if not self.manifest_dir.exists():
            return []
        files = sorted(self.manifest_dir.glob("snap_*.json"), reverse=True)[:limit]
        return [json.loads(path.read_text(encoding="utf-8")) for path in files]

    # -- internals -------------------------------------------------------
    def _dataset_dir(self, dataset: str, interval: int | None) -> Path:
        base = self.dataset_root / dataset
        return base / str(interval) if interval is not None else base

    def _partition_path(self, dataset: str, symbol: str, year: int, interval: int | None) -> Path:
        extension = "parquet" if self.storage == "parquet" else "csv"
        return self._dataset_dir(dataset, interval) / f"symbol={symbol}" / f"year={year}" / f"data.{extension}"

    def _merge_partition(self, path: Path, incoming: list[Bar]) -> dict[str, object]:
        existing = self._read_partition(path) if path.exists() else []
        merged: dict[datetime, Bar] = {bar.ts: bar for bar in existing}
        added = 0
        for bar in incoming:
            if bar.ts not in merged:
                added += 1
            merged[bar.ts] = bar
        rows = [merged[key] for key in sorted(merged)]
        self._write_partition(path, rows)
        digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""
        return {
            "rows": len(rows),
            "added": added,
            "checksum": digest,
            "start": rows[0].ts if rows else None,
            "end": rows[-1].ts if rows else None,
        }

    def _write_partition(self, path: Path, rows: list[Bar]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        if self.storage == "parquet":
            self._write_parquet(tmp, rows)
        else:
            self._write_csv(tmp, rows)
        os.replace(tmp, path)

    def _write_parquet(self, path: Path, rows: list[Bar]) -> None:
        import pyarrow as pa  # type: ignore[import-not-found]
        import pyarrow.parquet as pq  # type: ignore[import-not-found]

        schema = pa.schema(
            [
                ("symbol", pa.string()),
                ("ts", pa.timestamp("ms")),
                ("open", pa.decimal128(18, 4)),
                ("high", pa.decimal128(18, 4)),
                ("low", pa.decimal128(18, 4)),
                ("close", pa.decimal128(18, 4)),
                ("volume", pa.int64()),
                ("amount", pa.decimal128(20, 2)),
                ("limit_up", pa.decimal128(18, 4)),
                ("limit_down", pa.decimal128(18, 4)),
                ("suspended", pa.bool_()),
            ]
        )
        table = pa.table(
            {
                "symbol": pa.array([bar.symbol for bar in rows], type=pa.string()),
                "ts": pa.array([bar.ts for bar in rows], type=pa.timestamp("ms")),
                "open": pa.array([_price(bar.open) for bar in rows], type=pa.decimal128(18, 4)),
                "high": pa.array([_price(bar.high) for bar in rows], type=pa.decimal128(18, 4)),
                "low": pa.array([_price(bar.low) for bar in rows], type=pa.decimal128(18, 4)),
                "close": pa.array([_price(bar.close) for bar in rows], type=pa.decimal128(18, 4)),
                "volume": pa.array([bar.volume for bar in rows], type=pa.int64()),
                "amount": pa.array([_amount(bar.amount) for bar in rows], type=pa.decimal128(20, 2)),
                "limit_up": pa.array(
                    [_price(bar.limit_up) if bar.limit_up is not None else None for bar in rows],
                    type=pa.decimal128(18, 4),
                ),
                "limit_down": pa.array(
                    [_price(bar.limit_down) if bar.limit_down is not None else None for bar in rows],
                    type=pa.decimal128(18, 4),
                ),
                "suspended": pa.array([bar.suspended for bar in rows], type=pa.bool_()),
            },
            schema=schema,
        )
        pq.write_table(table, path, compression="zstd")

    def _write_csv(self, path: Path, rows: list[Bar]) -> None:
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(CSV_COLUMNS))
            writer.writeheader()
            for bar in rows:
                writer.writerow(
                    {
                        "symbol": bar.symbol,
                        "ts": bar.ts.isoformat(),
                        "open": _price(bar.open),
                        "high": _price(bar.high),
                        "low": _price(bar.low),
                        "close": _price(bar.close),
                        "volume": bar.volume,
                        "amount": _amount(bar.amount),
                        "limit_up": "" if bar.limit_up is None else _price(bar.limit_up),
                        "limit_down": "" if bar.limit_down is None else _price(bar.limit_down),
                        "suspended": int(bar.suspended),
                    }
                )

    def _read_partition(self, path: Path) -> list[Bar]:
        if path.suffix == ".parquet":
            import pyarrow.parquet as pq  # type: ignore[import-not-found]

            table = pq.read_table(path)
            return [
                Bar(
                    symbol=row["symbol"],
                    ts=row["ts"],
                    open=row["open"],
                    high=row["high"],
                    low=row["low"],
                    close=row["close"],
                    volume=int(row["volume"]),
                    amount=row["amount"] or Decimal("0"),
                    limit_up=row["limit_up"],
                    limit_down=row["limit_down"],
                    suspended=bool(row["suspended"]),
                )
                for row in table.to_pylist()
            ]

        bars: list[Bar] = []
        with path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                bars.append(
                    Bar(
                        symbol=row["symbol"],
                        ts=datetime.fromisoformat(row["ts"]),
                        open=Decimal(row["open"]),
                        high=Decimal(row["high"]),
                        low=Decimal(row["low"]),
                        close=Decimal(row["close"]),
                        volume=int(row["volume"]),
                        amount=Decimal(row["amount"] or "0"),
                        limit_up=Decimal(row["limit_up"]) if row["limit_up"] else None,
                        limit_down=Decimal(row["limit_down"]) if row["limit_down"] else None,
                        suspended=bool(int(row["suspended"] or 0)),
                    )
                )
        return bars

    def _update_catalog(
        self,
        dataset: str,
        interval: int | None,
        stats: dict[str, dict[str, object]],
    ) -> None:
        if not stats:
            return
        catalog = self._read_catalog()
        key = _catalog_key(dataset, interval)
        datasets = catalog.setdefault("datasets", {})
        entry = datasets.setdefault(key, {"symbols": {}})
        now = datetime.now(timezone.utc).isoformat()
        for symbol in stats:
            coverage = self._symbol_coverage(self._dataset_dir(dataset, interval) / f"symbol={symbol}")
            entry["symbols"][symbol] = {**coverage, "updated_at": now}
        self._write_json(self.catalog_path, catalog)

    def _symbol_coverage(self, base: Path) -> dict[str, object]:
        """Rows and date span for one symbol, summed across its year partitions."""
        rows = 0
        start = None
        end = None
        for path in sorted(base.glob("year=*/data.*")):
            low, high, count = _partition_bounds(path)
            rows += count
            if low is not None and (start is None or low < start):
                start = low
            if high is not None and (end is None or high > end):
                end = high
        return {
            "rows": rows,
            "start": start.date().isoformat() if start else None,
            "end": end.date().isoformat() if end else None,
        }

    def rebuild_catalog(self) -> dict[str, object]:
        """Recompute ``_catalog.json`` from the partitions on disk."""
        catalog: dict[str, object] = {"version": 1, "datasets": {}}
        if not self.dataset_root.exists():
            return catalog
        for entry in sorted(self.dataset_root.iterdir()):
            if not entry.is_dir():
                continue
            if any(entry.glob("symbol=*")):
                self._rebuild_dataset(catalog, entry.name, None, entry)
                continue
            for sub in sorted(entry.iterdir()):
                if sub.is_dir() and any(sub.glob("symbol=*")):
                    self._rebuild_dataset(catalog, entry.name, int(sub.name), sub)
        self._write_json(self.catalog_path, catalog)
        return catalog

    def _rebuild_dataset(
        self,
        catalog: dict[str, object],
        dataset: str,
        interval: int | None,
        base: Path,
    ) -> None:
        datasets = catalog.setdefault("datasets", {})
        key = _catalog_key(dataset, interval)
        entry = datasets.setdefault(key, {"symbols": {}})
        now = datetime.now(timezone.utc).isoformat()
        for symbol_dir in sorted(base.glob("symbol=*")):
            symbol = symbol_dir.name.split("=", 1)[1]
            entry["symbols"][symbol] = {
                **self._symbol_coverage(symbol_dir),
                "updated_at": now,
            }

    def _read_catalog(self) -> dict[str, object]:
        if not self.catalog_path.exists():
            return {"version": 1, "datasets": {}}
        return json.loads(self.catalog_path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)


def _partition_bounds(path: Path) -> tuple[datetime | None, datetime | None, int]:
    if path.suffix == ".parquet":
        try:
            import pyarrow.parquet as pq  # type: ignore[import-not-found]

            metadata = pq.ParquetFile(path).metadata
            rows = metadata.num_rows
            low = None
            high = None
            names = metadata.schema.names
            index = names.index("ts") if "ts" in names else 1
            for group in range(metadata.num_row_groups):
                stats = metadata.row_group(group).column(index).statistics
                if stats is None:
                    continue
                lo = _as_datetime(stats.min)
                hi = _as_datetime(stats.max)
                if lo is not None and (low is None or lo < low):
                    low = lo
                if hi is not None and (high is None or hi > high):
                    high = hi
            return low, high, rows
        except Exception:  # noqa: BLE001 - fall back to a full read
            pass
    return _read_partition_bounds(path)


def _read_partition_bounds(path: Path) -> tuple[datetime | None, datetime | None, int]:
    import csv as _csv

    rows = 0
    low = None
    high = None
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in _csv.DictReader(handle):
            rows += 1
            value = datetime.fromisoformat(row["ts"])
            low = value if low is None or value < low else low
            high = value if high is None or value > high else high
    return low, high, rows


def _as_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)
    return None


def _import_pyarrow():
    try:
        import pyarrow  # type: ignore[import-not-found]  # noqa: F401
    except ImportError:
        return None
    return pyarrow


def _price(value: Decimal) -> Decimal:
    return value.quantize(PRICE_QUANT, rounding=ROUND_HALF_UP)


def _amount(value: Decimal) -> Decimal:
    return value.quantize(AMOUNT_QUANT, rounding=ROUND_HALF_UP)


def new_snapshot_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"snap_{stamp}_{uuid.uuid4().hex[:6]}"


def _catalog_key(dataset: str, interval: int | None) -> str:
    return dataset if interval is None else f"{dataset}:{interval}"