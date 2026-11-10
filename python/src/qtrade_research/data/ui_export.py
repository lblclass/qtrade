"""Compact JSON exports consumed by the Go API and the web console.

The console never reads Parquet or PostgreSQL directly. This module condenses
the catalog, manifest metadata, quality report and latest quotes into three
small files under the dataset root:

    _ui_summary.json   coverage, snapshots, quality aggregates
    _quotes.json       last two daily closes per symbol (for the order ticket)

Run it after every collection/load cycle:

    qtrade-data export-ui --out data --dsn postgresql://...
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from .store import DatasetStore

DATASET_LABELS = {
    "bars_1d": ("日线", "1d", None),
    "bars_1m:1": ("1 分钟", "1m", 1),
    "bars_1m:5": ("5 分钟", "1m", 5),
}


def _cents(value: Any) -> int:
    if value is None:
        return 0
    return int((Decimal(str(value)) * 100).quantize(Decimal("1")))


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _dataset_rows(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key, payload in sorted(catalog.get("datasets", {}).items()):
        symbols = payload.get("symbols", {})
        if not symbols:
            continue
        starts = [str(item["start"]) for item in symbols.values() if item.get("start")]
        ends = [str(item["end"]) for item in symbols.values() if item.get("end")]
        updated = [str(item["updated_at"]) for item in symbols.values() if item.get("updated_at")]
        label, frequency, interval = DATASET_LABELS.get(key, (key, key, None))
        rows.append(
            {
                "key": key,
                "label": label,
                "frequency": frequency,
                "interval": interval,
                "symbols": len(symbols),
                "rows": sum(int(item.get("rows", 0)) for item in symbols.values()),
                "start": min(starts) if starts else None,
                "end": max(ends) if ends else None,
                "updated_at": max(updated) if updated else None,
            }
        )
    rows.sort(key=lambda item: (item["frequency"] != "1d", item["interval"] or 0))
    return rows


def _latest_instruments(root: Path) -> tuple[list[dict[str, Any]], str | None]:
    base = root / "instruments"
    if not base.exists():
        return [], None
    dirs = sorted(item for item in base.iterdir() if item.is_dir())
    if not dirs:
        return [], None
    path = dirs[-1] / "instruments.json"
    payload = _load_json(path, [])
    return payload if isinstance(payload, list) else [], dirs[-1].name


def _snapshot_rows(root: Path, limit: int = 30) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    manifests = sorted((root / "_manifests").glob("*.json"))
    for path in manifests:
        payload = _load_json(path, {})
        if not isinstance(payload, dict):
            continue
        quality = payload.get("quality") or {}
        rows.append(
            {
                "snapshot_id": payload.get("snapshot_id", path.stem),
                "dataset": payload.get("dataset"),
                "interval": payload.get("interval"),
                "rows": payload.get("rows", 0),
                "symbols": payload.get("symbols", 0),
                "start": payload.get("start"),
                "end": payload.get("end"),
                "source": payload.get("source"),
                "adjust": payload.get("adjust"),
                "storage": payload.get("storage"),
                "created_at": payload.get("created_at"),
                "quality": {
                    "checked": quality.get("checked", 0),
                    "accepted": quality.get("accepted", 0),
                    "dropped": quality.get("dropped", 0),
                    "blockers": quality.get("blockers", 0),
                    "warnings": quality.get("warnings", 0),
                    "duplicates": quality.get("duplicates", 0),
                },
            }
        )
    rows.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return rows[:limit]


def _quality_from_db(dsn: str) -> dict[str, Any]:
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as conn:
        total, blockers, warnings = conn.execute(
            """
            select count(*),
                   count(*) filter (where level = 'blocker'),
                   count(*) filter (where level = 'warning')
            from data_quality_issues
            """
        ).fetchone()
        by_code = [
            {"code": code, "level": level, "count": count}
            for code, level, count in conn.execute(
                """
                select code, level, count(*) as total
                from data_quality_issues
                group by code, level
                order by total desc, code
                limit 12
                """
            ).fetchall()
        ]
        samples = [
            {"code": code, "level": level, "message": message}
            for code, level, message in conn.execute(
                """
                select code, level, message
                from data_quality_issues
                order by created_at desc
                limit 12
                """
            ).fetchall()
        ]
        calendar = conn.execute(
            """
            select count(*), min(trade_date), max(trade_date)
            from trading_calendar
            where is_open
            """
        ).fetchone()
        instruments = conn.execute("select count(*) from instrument_master").fetchone()[0]
    return {
        "source": "postgres",
        "total": total,
        "blockers": blockers,
        "warnings": warnings,
        "by_code": by_code,
        "samples": samples,
        "trading_calendar": {
            "days": calendar[0],
            "start": _iso(calendar[1]),
            "end": _iso(calendar[2]),
        },
        "instrument_master_rows": instruments,
    }


def _quality_from_manifests(snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    latest = snapshots[0]["quality"] if snapshots else {}
    return {
        "source": "manifest",
        "total": int(latest.get("blockers", 0)) + int(latest.get("warnings", 0)),
        "blockers": int(latest.get("blockers", 0)),
        "warnings": int(latest.get("warnings", 0)),
        "by_code": [],
        "samples": [],
        "trading_calendar": {"days": 0, "start": None, "end": None},
        "instrument_master_rows": 0,
    }


def _quotes_from_db(dsn: str, names: dict[str, str]) -> list[dict[str, Any]]:
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as conn:
        rows = conn.execute(
            """
            select symbol, trade_date, close, volume, amount
            from (
                select symbol, trade_date, close, volume, amount,
                       row_number() over (partition by symbol order by trade_date desc) as rn
                from bar_1d
            ) latest
            where rn <= 2
            order by symbol, trade_date desc
            """
        ).fetchall()
    grouped: dict[str, list[tuple[Any, ...]]] = {}
    for row in rows:
        grouped.setdefault(row[0], []).append(row)
    return _build_quotes(grouped, names)


def _quotes_from_parquet(root: Path, names: dict[str, str]) -> list[dict[str, Any]]:
    import pyarrow.parquet as pq

    grouped: dict[str, list[tuple[Any, ...]]] = {}
    base = root / "dataset" / "bars_1d"
    for symbol_dir in sorted(base.glob("symbol=*")):
        years = sorted(symbol_dir.glob("year=*/data.parquet"))
        if not years:
            continue
        table = pq.read_table(
            years[-1],
            columns=["symbol", "ts", "close", "volume", "amount"],
        )
        tail = table.slice(max(0, table.num_rows - 30), 30).to_pylist()
        tail.sort(key=lambda item: item["ts"], reverse=True)
        for item in tail[:2]:
            grouped.setdefault(item["symbol"], []).append(
                (item["symbol"], item["ts"].date(), item["close"], item["volume"], item["amount"])
            )
    return _build_quotes(grouped, names)


def _build_quotes(grouped: dict[str, list[tuple[Any, ...]]], names: dict[str, str]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for symbol, rows in grouped.items():
        latest = rows[0]
        previous = rows[1] if len(rows) > 1 else None
        close = _cents(latest[2])
        prev_close = _cents(previous[2]) if previous else 0
        change = 0
        if prev_close:
            change = int(round((close - prev_close) * 10_000 / prev_close))
        items.append(
            {
                "symbol": symbol,
                "name": names.get(symbol, symbol),
                "exchange": symbol.split(".")[-1] if "." in symbol else "",
                "close_cents": close,
                "prev_close_cents": prev_close,
                "change_bps": change,
                "volume": int(latest[3] or 0),
                "amount_cents": _cents(latest[4]),
                "limit_up_cents": int(round(prev_close * 1.1)) if prev_close else 0,
                "limit_down_cents": int(round(prev_close * 0.9)) if prev_close else 0,
                "trade_date": _iso(latest[1]),
            }
        )
    items.sort(key=lambda item: item["amount_cents"], reverse=True)
    return items


def _series_from_parquet(
    root: Path,
    quotes: list[dict[str, Any]],
    *,
    days: int = 250,
    max_symbols: int = 300,
) -> dict[str, Any] | None:
    """Export a rolling OHLCV window the Go API and the worker can read without
    touching Parquet.

    Symbols must actually cover the window: a delisted name with 13 stray rows
    used to stretch the date axis back to 2020 and silently corrupt every
    downstream chart, so coverage is filtered *before* the axis is built.
    """
    try:
        import pyarrow.parquet as pq
    except ModuleNotFoundError:
        return None
    base = root / "dataset" / "bars_1d"
    if not base.exists():
        return None
    chosen = [item["symbol"] for item in quotes[:max_symbols]]
    names = {item["symbol"]: item.get("name", item["symbol"]) for item in quotes}

    raw: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for symbol in chosen:
        symbol_dir = base / f"symbol={symbol}"
        if not symbol_dir.exists():
            continue
        paths = sorted(symbol_dir.glob("year=*/data.parquet"))[-2:]
        rows: list[dict[str, Any]] = []
        for path in paths:
            table = pq.read_table(
                path,
                columns=[
                    "symbol", "ts", "open", "high", "low", "close",
                    "volume", "limit_up", "limit_down",
                ],
            )
            rows.extend(table.to_pylist())
        if not rows:
            continue
        rows.sort(key=lambda item: item["ts"])
        rows = rows[-days:]
        dated = [
            (_iso(item["ts"].date() if hasattr(item["ts"], "date") else item["ts"]), item)
            for item in rows
        ]
        raw[symbol] = dated

    if not raw:
        return None
    global_end = max(dated[-1][0] for dated in raw.values() if dated)
    minimum_rows = max(40, int(days * 0.4))
    symbols: dict[str, Any] = {}
    for symbol, dated in raw.items():
        if len(dated) < minimum_rows:
            continue
        if dated[-1][0] < global_end:
            # Tolerate a few missing sessions at the tail, but not a delisting.
            try:
                gap = (date.fromisoformat(global_end) - date.fromisoformat(dated[-1][0])).days
            except ValueError:
                gap = 0
            if gap > 15:
                continue
        symbols[symbol] = {
            "name": names.get(symbol, symbol),
            "dates": [day for day, _ in dated],
            "open": [_cents(item["open"]) for _, item in dated],
            "high": [_cents(item["high"]) for _, item in dated],
            "low": [_cents(item["low"]) for _, item in dated],
            "close": [_cents(item["close"]) for _, item in dated],
            "volume": [int(item["volume"] or 0) for _, item in dated],
            "limit_up": [_cents(item["limit_up"]) for _, item in dated],
            "limit_down": [_cents(item["limit_down"]) for _, item in dated],
        }
    if not symbols:
        return None

    date_union: set[str] = set()
    for payload in symbols.values():
        date_union.update(payload["dates"])
    dates = sorted(date_union)

    # Equal-weight index: every symbol normalised to its first available close.
    totals: dict[str, float] = {day: 0.0 for day in dates}
    counts: dict[str, int] = {day: 0 for day in dates}
    for payload in symbols.values():
        closes = payload["close"]
        base_close = next((value for value in closes if value > 0), 0)
        if base_close <= 0:
            continue
        for day, close in zip(payload["dates"], closes):
            if close > 0:
                totals[day] += close / base_close
                counts[day] += 1
    benchmark_dates: list[str] = []
    benchmark_values: list[float] = []
    minimum = max(1, len(symbols) // 5)
    for day in dates:
        count = counts[day]
        if count < minimum:
            continue
        benchmark_dates.append(day)
        benchmark_values.append(round(totals[day] / count * 1000.0, 4))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "end": benchmark_dates[-1] if benchmark_dates else dates[-1],
        "days": days,
        "symbols": symbols,
        "benchmark": {
            "label": "等权基准",
            "dates": benchmark_dates or dates,
            "values": benchmark_values,
        },
    }

def export_ui(root: str | Path, dsn: str | None = None) -> dict[str, Any]:
    root = Path(root)
    store = DatasetStore(root)
    catalog = _load_json(store.catalog_path, {"datasets": {}})
    datasets = _dataset_rows(catalog)
    instruments, instruments_date = _latest_instruments(root)
    names = {item["symbol"]: item.get("name", item["symbol"]) for item in instruments if item.get("symbol")}
    snapshots = _snapshot_rows(root)

    quality: dict[str, Any]
    quotes: list[dict[str, Any]]
    if dsn:
        try:
            quality = _quality_from_db(dsn)
            quotes = _quotes_from_db(dsn, names)
        except Exception:  # noqa: BLE001 - fall back to files, the console must still load
            quality = _quality_from_manifests(snapshots)
            quotes = _quotes_from_parquet(root, names)
    else:
        quality = _quality_from_manifests(snapshots)
        quotes = _quotes_from_parquet(root, names)

    latest_trade_date = quotes[0]["trade_date"] if quotes else None
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_root": str(root),
        "datasets": datasets,
        "snapshots": snapshots,
        "quality": quality,
        "instruments": {
            "count": len(instruments),
            "active": sum(1 for item in instruments if item.get("is_active")),
            "snapshot": instruments_date,
        },
        "quotes": {
            "count": len(quotes),
            "trade_date": latest_trade_date,
            "up": sum(1 for item in quotes if item["change_bps"] > 0),
            "down": sum(1 for item in quotes if item["change_bps"] < 0),
            "flat": sum(1 for item in quotes if item["change_bps"] == 0),
            "limit_up": sum(1 for item in quotes if item["limit_up_cents"] and item["close_cents"] >= item["limit_up_cents"]),
            "limit_down": sum(
                1 for item in quotes if item["limit_down_cents"] and item["close_cents"] <= item["limit_down_cents"]
            ),
        },
    }
    (root / "_ui_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (root / "_quotes.json").write_text(
        json.dumps(
            {"generated_at": summary["generated_at"], "trade_date": latest_trade_date, "items": quotes},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    series = _series_from_parquet(root, quotes)
    if series is not None:
        (root / "_series.json").write_text(
            json.dumps(series, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    return {
        "summary": str(root / "_ui_summary.json"),
        "quotes": str(root / "_quotes.json"),
        "series": str(root / "_series.json") if series else None,
        "series_symbols": len(series["symbols"]) if series else 0,
        "datasets": len(datasets),
        "snapshots": len(snapshots),
        "instruments": len(instruments),
        "quotes_count": len(quotes),
        "quality_source": quality["source"],
    }
