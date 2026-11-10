"""``qtrade-data`` command line entry point.

Examples::

    qtrade-data sources --probe
    qtrade-data instruments
    qtrade-data daily --symbols 600000.SH,000001.SZ --start 2020-01-01
    qtrade-data minute --symbols 600000.SH --interval 5 --start 2024-01-01
    qtrade-data minute --symbols 600000.SH --interval 1 --today
    qtrade-data catalog
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from ..domain import Bar
from .collector import CollectionRequest, Collector
from .quality import check_bars
from .sources import SOURCES
from .sources.base import SourceError
from .store import DatasetStore
from .symbols import Symbol, parse_symbols


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    handler = {
        "sources": _cmd_sources,
        "instruments": _cmd_instruments,
        "daily": _cmd_daily,
        "minute": _cmd_minute,
        "catalog": _cmd_catalog,
        "export-ui": _cmd_export_ui,
        "verify": _cmd_verify,
        "load-postgres": _cmd_load_postgres,
    }[args.command]
    try:
        return handler(args)
    except SourceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qtrade-data", description="qtrade market data collector")
    sub = parser.add_subparsers(dest="command", required=True)

    sources = sub.add_parser("sources", help="list adapters and their capabilities")
    sources.add_argument("--probe", action="store_true", help="make a live request per source")
    sources.add_argument("--json", action="store_true")

    instruments = sub.add_parser("instruments", help="download the A-share instrument master")
    _add_store_args(instruments)
    instruments.add_argument("--source", default="eastmoney", choices=sorted(SOURCES))
    instruments.add_argument("--limit", type=int, default=0)
    instruments.add_argument("--json", action="store_true")

    daily = sub.add_parser("daily", help="collect daily bars")
    _add_store_args(daily)
    _add_universe_args(daily)
    daily.add_argument("--source", default="eastmoney", choices=sorted(SOURCES))
    daily.add_argument("--start", default="2020-01-01")
    daily.add_argument("--end", default="today")
    daily.add_argument("--adjust", default="qfq", choices=("none", "qfq", "hfq"))
    daily.add_argument("--limit", type=int, default=0)
    daily.add_argument("--workers", type=int, default=1)
    daily.add_argument("--rate", type=float, default=0.25, help="min seconds between HTTP requests")
    daily.add_argument("--incremental", action="store_true", default=True)
    daily.add_argument("--full-refresh", dest="incremental", action="store_false")
    daily.add_argument("--json", action="store_true")

    minute = sub.add_parser("minute", help="collect intraday bars")
    _add_store_args(minute)
    _add_universe_args(minute)
    minute.add_argument("--interval", type=int, default=5, choices=(1, 5, 15, 30, 60))
    minute.add_argument("--source", default="auto", choices=("auto", *sorted(SOURCES)))
    minute.add_argument("--start", default="today")
    minute.add_argument("--end", default="today")
    minute.add_argument("--today", action="store_true", help="shortcut for --start today --end today")
    minute.add_argument("--adjust", default="qfq", choices=("none", "qfq", "hfq"))
    minute.add_argument("--limit", type=int, default=0)
    minute.add_argument("--workers", type=int, default=1)
    minute.add_argument("--rate", type=float, default=0.25, help="min seconds between HTTP requests")
    minute.add_argument("--incremental", action="store_true", default=True)
    minute.add_argument("--full-refresh", dest="incremental", action="store_false")
    minute.add_argument("--json", action="store_true")

    catalog = sub.add_parser("catalog", help="show collected coverage")
    _add_store_args(catalog)
    catalog.add_argument("--json", action="store_true")

    export_ui = sub.add_parser("export-ui", help="write compact JSON for the web console")
    _add_store_args(export_ui)
    export_ui.add_argument(
        "--dsn",
        default="",
        help="postgres DSN (default: QTRADE_DATABASE_URL / DATABASE_URL / local qtrade)",
    )
    export_ui.add_argument("--json", action="store_true")

    load = sub.add_parser("load-postgres", help="copy snapshots into PostgreSQL")
    _add_store_args(load)
    load.add_argument(
        "--dataset", default="all", choices=("all", "instruments", "bars_1d", "bars_1m")
    )
    load.add_argument("--intervals", default="1,5", help="minute intervals to load, e.g. 1,5")
    load.add_argument("--since", default="", help="only load bars on/after this date (YYYY-MM-DD)")
    load.add_argument(
        "--dsn",
        default="",
        help="postgres DSN (default: QTRADE_DATABASE_URL / DATABASE_URL / local qtrade)",
    )
    load.add_argument("--json", action="store_true")

    verify = sub.add_parser("verify", help="re-run quality checks on stored data")
    _add_store_args(verify)
    verify.add_argument("--dataset", default="bars_1d", choices=("bars_1d", "bars_1m"))
    verify.add_argument("--interval", type=int, default=None)
    verify.add_argument("--json", action="store_true")

    return parser


def _add_store_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--out", default="data", help="snapshot root (default: ./data)")
    parser.add_argument("--format", default="auto", choices=("auto", "parquet", "csv"))
    parser.add_argument("--quiet", action="store_true")


def _add_universe_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--symbols", default="", help="comma separated symbols")
    parser.add_argument("--universe", default="", choices=("", "all"), help="all = every listed A share")
    parser.add_argument("--universe-file", default="", help="file with one symbol per line")


# -- commands ------------------------------------------------------------
def _cmd_sources(args: argparse.Namespace) -> int:
    rows = []
    for name, factory in sorted(SOURCES.items()):
        capability = factory.capability
        row = {
            "source": name,
            "daily": capability.daily,
            "minute": ",".join(str(item) for item in capability.minute_intervals) or "-",
            "instruments": capability.instruments,
            "calendar": capability.calendar,
            "adjustments": ",".join(capability.adjustments),
            "notes": capability.notes,
        }
        if args.probe:
            row.update(_probe(name, factory))
        rows.append(row)

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    headers = ("source", "daily", "minute", "instruments", "calendar", "adjustments", "notes")
    keys = headers + (("probe",) if args.probe else ())
    widths = {key: len(key) for key in keys}
    for row in rows:
        for key in keys:
            widths[key] = max(widths[key], len(str(row.get(key, ""))))
    print("  ".join(key.ljust(widths[key]) for key in keys))
    print("  ".join("-" * widths[key] for key in keys))
    for row in rows:
        print("  ".join(str(row.get(key, "")).ljust(widths[key]) for key in keys))
    return 0


def _probe(name: str, factory) -> dict[str, str]:
    symbol = Symbol(code="600000", exchange="SH")
    end = date.today()
    start = end - timedelta(days=10)
    try:
        source = factory()
        try:
            response = source.fetch_daily(symbol, start, end, "qfq")
        finally:
            close = getattr(source, "close", None)
            if close:
                close()
        return {"probe": f"ok ({len(response.bars)} bars)"}
    except Exception as exc:  # noqa: BLE001 - probe reports, never raises
        return {"probe": f"failed: {exc}"}


def _cmd_instruments(args: argparse.Namespace) -> int:
    store = _store(args)
    source = _source(args.source)
    try:
        instruments = source.instruments()
    finally:
        _close(source)
    if args.limit:
        instruments = instruments[: args.limit]

    stamp = datetime.now().strftime("%Y%m%d")
    directory = store.root / "instruments" / stamp
    directory.mkdir(parents=True, exist_ok=True)
    csv_path = directory / "instruments.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(instruments[0].to_dict().keys()))
        writer.writeheader()
        for instrument in instruments:
            writer.writerow(instrument.to_dict())
    json_path = directory / "instruments.json"
    payload = [instrument.to_dict() for instrument in instruments]
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "source": args.source,
        "count": len(instruments),
        "csv": str(csv_path),
        "json": str(json_path),
        "active": sum(1 for item in instruments if item.is_active),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"{summary['count']} instruments -> {csv_path}")
    return 0


def _cmd_daily(args: argparse.Namespace) -> int:
    return _collect(args, frequency="1d", interval=None)


def _cmd_minute(args: argparse.Namespace) -> int:
    if args.today:
        args.start = "today"
        args.end = "today"
    return _collect(args, frequency="1m", interval=args.interval)


def _collect(args: argparse.Namespace, *, frequency: str, interval: int | None) -> int:
    store = _store(args)
    start = _parse_date(args.start)
    end = _parse_date(args.end)
    if start > end:
        raise ValueError(f"start {start} is after end {end}")

    symbol_name = args.source if args.source != "auto" else ("eastmoney" if interval == 1 else "baostock")
    workers = max(1, int(getattr(args, "workers", 1)))
    if workers > 1 and symbol_name == "baostock":
        raise ValueError("baostock uses a single socket session; run it with --workers 1")
    source = _source(symbol_name, min_interval=float(getattr(args, "rate", 0.25)))
    try:
        symbols = _resolve_symbols(args, source)
    finally:
        pass

    if not symbols:
        raise ValueError("no symbols selected")
    if args.limit:
        symbols = symbols[: args.limit]

    names: dict[str, str] = {}
    if getattr(args, "universe", "") == "all":
        try:
            names = {item.symbol: item.name for item in source.instruments()}
        except Exception:  # noqa: BLE001 - names only affect the ST limit heuristic
            names = {}

    progress = (lambda message: None) if args.quiet else _print_progress
    collector = Collector(source, store, names=names, progress=progress)
    request = CollectionRequest(
        symbols=symbols,
        start=start,
        end=end,
        frequency=frequency,
        interval=interval,
        adjust=args.adjust,
        incremental=args.incremental,
        save_raw=True,
        workers=workers,
    )
    try:
        result = collector.run(request)
    finally:
        _close(source)

    summary = {
        "source": symbol_name,
        "dataset": request.dataset,
        "interval": interval,
        "symbols_requested": len(symbols),
        "rows": result.snapshot.rows if result.snapshot else 0,
        "snapshot_id": result.snapshot.snapshot_id if result.snapshot else None,
        "failures": result.failures,
        "skipped": len(result.skipped),
        "history_truncated": result.truncated,
        "quality": result.quality.to_dict(),
        "workers": workers,
    "elapsed_seconds": round(result.elapsed, 2),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(
            f"{summary['rows']} bars, {len(result.failures)} failures, "
            f"{len(result.truncated)} truncated, {summary['elapsed_seconds']}s "
            f"-> {result.snapshot.path if result.snapshot else store.root}"
        )
        if result.failures:
            for key, message in list(result.failures.items())[:5]:
                print(f"  {key}: {message}", file=sys.stderr)
    return 0 if result.snapshot or result.skipped else 1


def _cmd_catalog(args: argparse.Namespace) -> int:
    store = _store(args)
    payload = {}
    for dataset in ("bars_1d", "bars_1m"):
        keys = [dataset] + ([f"{dataset}:{interval}" for interval in (1, 5, 15, 30, 60)] if dataset == "bars_1m" else [])
        for key in keys:
            base, _, interval_text = key.partition(":")
            interval = int(interval_text) if interval_text else None
            coverage = store.coverage(base, interval)
            if coverage:
                payload[key] = coverage

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if not payload:
        print("no data collected yet")
        return 0
    for key, coverage in payload.items():
        rows = sum(int(item.get("rows", 0)) for item in coverage.values())
        starts = [str(item.get("start")) for item in coverage.values() if item.get("start")]
        ends = [str(item.get("end")) for item in coverage.values() if item.get("end")]
        print(
            f"{key:12s} symbols={len(coverage):4d} rows={rows:9d} "
            f"{min(starts) if starts else '-'} .. {max(ends) if ends else '-'}"
        )
    return 0


def _cmd_load_postgres(args: argparse.Namespace) -> int:
    from .postgres import PostgresError, PostgresLoader

    store = _store(args)
    dsn = (
        args.dsn
        or os.environ.get("QTRADE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or "postgresql://qtrade:qtrade@localhost:15432/qtrade"
    )
    loader = PostgresLoader(dsn, store)
    since = _parse_date(args.since) if args.since else None
    results: dict[str, object] = {}
    try:
        if args.dataset in ("all", "instruments"):
            results["instruments"] = loader.load_instruments()
        if args.dataset in ("all", "bars_1d"):
            stats = loader.load_bars("bars_1d", since=since)
            results["bars_1d"] = stats.to_dict()
        if args.dataset in ("all", "bars_1m"):
            intervals = [
                int(item)
                for item in str(args.intervals).replace(" ", "").split(",")
                if item and Path(store.dataset_root / "bars_1m" / item).exists()
            ]
            results["bars_1m"] = [
                loader.load_bars("bars_1m", item, since=since).to_dict() for item in intervals
            ]
    except PostgresError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    store = _store(args)
    bars = store.load(args.dataset, interval=args.interval)
    accepted, report = check_bars(bars, "1d" if args.dataset == "bars_1d" else "1m")
    summary = {
        "dataset": args.dataset,
        "interval": args.interval,
        "rows": len(bars),
        "accepted": len(accepted),
        "duplicates": report.duplicates,
        "dropped": report.dropped,
        "blockers": len(report.blockers),
        "warnings": len(report.warnings),
        "sample_issues": [issue.to_dict() for issue in report.issues[:10]],
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(
            f"{summary['dataset']}: rows={summary['rows']} accepted={summary['accepted']} "
            f"dropped={summary['dropped']} warnings={summary['warnings']}"
        )
        for issue in report.issues[:5]:
            print(f"  [{issue.level}] {issue.symbol} {issue.code}: {issue.message}")
    return 0


def _cmd_export_ui(args: argparse.Namespace) -> int:
    from .ui_export import export_ui

    dsn = (
        args.dsn
        or os.environ.get("QTRADE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or "postgresql://qtrade:qtrade@localhost:15432/qtrade"
    )
    result = export_ui(Path(args.out), dsn=dsn)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


# -- helpers -------------------------------------------------------------
def _store(args: argparse.Namespace) -> DatasetStore:
    return DatasetStore(Path(args.out), prefer_csv=args.format == "csv")


def _source(name: str, *, min_interval: float | None = None):
    if name not in SOURCES:
        raise ValueError(f"unknown source: {name}")
    factory = SOURCES[name]
    if min_interval is None:
        return factory()
    try:
        return factory(min_interval=min_interval)
    except TypeError:
        return factory()


def _close(source) -> None:
    close = getattr(source, "close", None)
    if callable(close):
        close()


def _resolve_symbols(args: argparse.Namespace, source) -> list[Symbol]:
    symbols: list[Symbol] = []
    if args.symbols:
        symbols.extend(parse_symbols(args.symbols))
    if args.universe_file:
        path = Path(args.universe_file)
        lines = [line.split("#", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines()]
        symbols.extend(parse_symbols([line for line in lines if line]))
    if args.universe == "all":
        instruments = source.instruments()
        symbols.extend(parse_symbols([item.symbol for item in instruments if item.is_active]))

    seen: set[str] = set()
    unique: list[Symbol] = []
    for symbol in symbols:
        if symbol.key in seen:
            continue
        seen.add(symbol.key)
        unique.append(symbol)
    return unique


def _parse_date(text: str) -> date:
    value = text.strip().lower()
    if value == "today":
        return date.today()
    if value == "yesterday":
        return date.today() - timedelta(days=1)
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text.strip(), fmt).date()
        except ValueError:
            continue
    raise ValueError(f"invalid date: {text}")


def _print_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
