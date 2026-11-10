"""Load snapshot data into PostgreSQL.

The Parquet lake stays the immutable history; PostgreSQL holds one ``live_*``
snapshot per dataset so the control plane and research jobs share a fast,
queryable view. Re-running a load replaces only the overlapping keys, which
makes the nightly job idempotent.
"""

from __future__ import annotations

import csv
import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Iterator
from zoneinfo import ZoneInfo

from .symbols import Symbol, board_of
from .store import DatasetStore

SHANGHAI = ZoneInfo("Asia/Shanghai")

BOARD_RULE = {
    "MAIN_SH": "main_10pct",
    "MAIN_SZ": "main_10pct",
    "STAR": "star_20pct",
    "CHINEXT": "chinext_20pct",
    "BSE": "bse_30pct",
}

BAR_1D_COLUMNS = (
    "symbol",
    "trade_date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "adj_factor",
    "source",
    "snapshot_id",
)
BAR_1M_COLUMNS = (
    "symbol",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "source",
    "snapshot_id",
)


class PostgresError(RuntimeError):
    pass


@dataclass
class LoadStats:
    dataset: str
    interval: int | None
    snapshot_id: str
    copied: int
    deleted: int

    def to_dict(self) -> dict[str, object]:
        return {
            "dataset": self.dataset,
            "interval": self.interval,
            "snapshot_id": self.snapshot_id,
            "copied": self.copied,
            "deleted": self.deleted,
        }


class PostgresLoader:
    def __init__(self, dsn: str, store: DatasetStore) -> None:
        self.dsn = dsn
        self.store = store

    # -- public ----------------------------------------------------------
    def load_instruments(self, csv_path: Path | None = None) -> int:
        path = csv_path or _latest_instruments(self.store.root)
        if path is None:
            raise PostgresError("no instruments snapshot found; run `qtrade-data instruments` first")
        rows = list(_read_instruments(path))
        import psycopg

        with psycopg.connect(self.dsn, autocommit=False) as conn, conn.cursor() as cur:
            cur.execute(
                "CREATE TEMP TABLE tmp_instruments (symbol text, name text, exchange text, board text, "
                "list_date date, is_active boolean, price_limit_rule text) ON COMMIT DROP"
            )
            with cur.copy("COPY tmp_instruments FROM STDIN") as copy:
                for row in rows:
                    copy.write_row(row)
            cur.execute(
                """
                INSERT INTO instrument_master (symbol, name, exchange, board, list_date, is_active, price_limit_rule)
                SELECT symbol, name, exchange, board, list_date, is_active, price_limit_rule
                FROM tmp_instruments
                ON CONFLICT (symbol) DO UPDATE
                   SET name = EXCLUDED.name,
                       exchange = EXCLUDED.exchange,
                       board = EXCLUDED.board,
                       list_date = COALESCE(EXCLUDED.list_date, instrument_master.list_date),
                       is_active = EXCLUDED.is_active,
                       price_limit_rule = EXCLUDED.price_limit_rule,
                       updated_at = now()
                """
            )
            conn.commit()
        return len(rows)

    def load_bars(self, dataset: str, interval: int | None = None, since: date | None = None) -> LoadStats:
        import psycopg

        snapshot_id = _live_id(dataset, interval)
        manifest = self._latest_manifest(dataset, interval)
        files = list(self._partitions(dataset, interval))
        if not files:
            raise PostgresError(f"no partitions found for {dataset}")

        bar_columns = BAR_1D_COLUMNS if dataset == "bars_1d" else BAR_1M_COLUMNS
        table = "bar_1d" if dataset == "bars_1d" else "bar_1m"

        with psycopg.connect(self.dsn, autocommit=False) as conn, conn.cursor() as cur:
            self._ensure_snapshot(cur, snapshot_id, manifest, dataset, interval)

            cur.execute(
                f"CREATE TEMP TABLE tmp_bars (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP"
            )
            copied = 0
            with cur.copy(
                f"COPY tmp_bars ({', '.join(bar_columns)}) FROM STDIN"
            ) as copy:
                for row in self._iter_rows(dataset, interval, snapshot_id, since):
                    copy.write_row(row)
                    copied += 1

            cur.execute("CREATE INDEX ON tmp_bars (symbol)")
            cur.execute(
                "INSERT INTO instrument_master (symbol, name, exchange, board) "
                "SELECT DISTINCT symbol, symbol, split_part(symbol, '.', 2), '' FROM tmp_bars "
                "ON CONFLICT (symbol) DO NOTHING"
            )

            if dataset == "bars_1d":
                cur.execute(
                    "DELETE FROM bar_1d b USING tmp_bars t "
                    "WHERE b.snapshot_id = %s AND b.symbol = t.symbol AND b.trade_date = t.trade_date",
                    (snapshot_id,),
                )
            else:
                cur.execute(
                    "DELETE FROM bar_1m b USING tmp_bars t "
                    "WHERE b.snapshot_id = %s AND b.symbol = t.symbol AND b.ts = t.ts",
                    (snapshot_id,),
                )
            deleted = cur.rowcount

            cur.execute(
                f"INSERT INTO {table} ({', '.join(bar_columns)}) "
                f"SELECT {', '.join(bar_columns)} FROM tmp_bars"
            )
            self._record_items(cur, snapshot_id, dataset, interval, files, copied)
            self._load_quality(cur, snapshot_id, dataset, manifest)

            if dataset == "bars_1d":
                cur.execute(
                    "INSERT INTO trading_calendar (exchange, trade_date, is_open, session) "
                    "SELECT 'CN', trade_date, true, 'regular' FROM bar_1d "
                    "WHERE snapshot_id = %s GROUP BY trade_date "
                    "ON CONFLICT (exchange, trade_date) DO NOTHING",
                    (snapshot_id,),
                )
            conn.commit()

        return LoadStats(dataset, interval, snapshot_id, copied, deleted)

    # -- internals -------------------------------------------------------
    def _partitions(self, dataset: str, interval: int | None) -> Iterator[Path]:
        base = self.store.dataset_root / dataset
        if interval is not None:
            base = base / str(interval)
        yield from sorted(base.glob("symbol=*/year=*/data.parquet"))

    def _iter_rows(
        self, dataset: str, interval: int | None, snapshot_id: str, since: date | None
    ) -> Iterator[tuple]:
        import pyarrow.parquet as pq

        for path in self._partitions(dataset, interval):
            if since is not None:
                year = int(path.parent.name.split("=", 1)[1])
                if year < since.year:
                    continue
            table = pq.read_table(path)
            for row in table.to_pylist():
                if since is not None and row["ts"].date() < since:
                    continue
                if dataset == "bars_1d":
                    yield (
                        row["symbol"],
                        row["ts"].date(),
                        row["open"],
                        row["high"],
                        row["low"],
                        row["close"],
                        int(row["volume"]),
                        row["amount"],
                        Decimal("1"),
                        "eastmoney",
                        snapshot_id,
                    )
                else:
                    ts = row["ts"]
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=SHANGHAI)
                    yield (
                        row["symbol"],
                        ts,
                        row["open"],
                        row["high"],
                        row["low"],
                        row["close"],
                        int(row["volume"]),
                        row["amount"],
                        "eastmoney" if interval == 1 else "baostock",
                        snapshot_id,
                    )

    def _ensure_snapshot(self, cur, snapshot_id: str, manifest: dict, dataset: str, interval: int | None) -> None:
        cur.execute(
            "INSERT INTO dataset_snapshots (id, status, manifest, quality_report) "
            "VALUES (%s, 'published', %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET manifest = EXCLUDED.manifest, "
            "quality_report = EXCLUDED.quality_report, created_at = now()",
            (
                snapshot_id,
                json.dumps({"dataset": dataset, "interval": interval, "source": "qtrade-data"}),
                json.dumps((manifest or {}).get("quality", {})),
            ),
        )

    def _record_items(self, cur, snapshot_id: str, dataset: str, interval: int | None, files: list[Path], rows: int) -> None:
        key = dataset if interval is None else f"{dataset}:{interval}"
        cur.execute(
            "INSERT INTO dataset_snapshot_items (snapshot_id, dataset, partition, object_uri, checksum, row_count) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (snapshot_id, dataset, partition) DO UPDATE "
            "SET object_uri = EXCLUDED.object_uri, row_count = EXCLUDED.row_count",
            (snapshot_id, key, "all", str(self.store.dataset_root), "", rows),
        )

    def _load_quality(self, cur, snapshot_id: str, dataset: str, manifest: dict) -> None:
        cur.execute("DELETE FROM data_quality_issues WHERE snapshot_id = %s AND dataset = %s", (snapshot_id, dataset))
        quality = (manifest or {}).get("quality", {}) or {}
        issues = quality.get("issues", []) if isinstance(quality, dict) else []
        for issue in issues[:200]:
            cur.execute(
                "INSERT INTO data_quality_issues (id, snapshot_id, dataset, level, code, message) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (
                    f"dq_{uuid.uuid4().hex[:16]}",
                    snapshot_id,
                    dataset,
                    issue.get("level", "info"),
                    issue.get("code", ""),
                    (f"{issue.get('symbol', '')} {issue.get('message', '')}").strip(),
                ),
            )

    def _latest_manifest(self, dataset: str, interval: int | None) -> dict:
        for manifest in self.store.manifests(limit=200):
            if manifest.get("dataset") == dataset and manifest.get("interval") == interval:
                return manifest
        return {}


def _read_instruments(path: Path) -> Iterator[tuple]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            symbol = row.get("symbol", "")
            if not symbol:
                continue
            try:
                exchange = Symbol(code=symbol.split(".")[0], exchange=symbol.split(".")[1]).exchange
            except (IndexError, ValueError):
                continue
            board = row.get("board") or board_of(Symbol(code=symbol.split(".")[0], exchange=exchange))
            list_date = row.get("list_date") or None
            yield (
                symbol,
                row.get("name") or symbol,
                exchange,
                board,
                date.fromisoformat(list_date) if list_date else None,
                str(row.get("is_active", "True")).lower() in ("true", "1"),
                BOARD_RULE.get(board, "default"),
            )


def _latest_instruments(root: Path) -> Path | None:
    directory = root / "instruments"
    if not directory.exists():
        return None
    snapshots = sorted(path for path in directory.glob("*") if path.is_dir())
    if not snapshots:
        return None
    candidate = snapshots[-1] / "instruments.csv"
    return candidate if candidate.exists() else None


def _live_id(dataset: str, interval: int | None) -> str:
    return f"live_{dataset}" if interval is None else f"live_{dataset}_{interval}"