"""Collection orchestration: fetch -> validate -> append snapshot.

Two execution modes:

* serial (default): one request at a time, used by the socket-based BaoStock
  adapter and by tests;
* concurrent: a thread pool over HTTP adapters, with periodic flushes so a
  full-market pull does not hold millions of ``Bar`` objects in memory.
"""

from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from .quality import QualityReport, check_bars
from .sources.base import MarketDataSource, SourceResponse, SourceError
from .store import DatasetStore, SnapshotRecord, new_snapshot_id
from .symbols import Symbol


@dataclass
class CollectionRequest:
    symbols: list[Symbol]
    start: date
    end: date
    frequency: str = "1d"
    interval: int | None = None
    adjust: str = "qfq"
    save_raw: bool = True
    incremental: bool = False
    workers: int = 1
    flush_size: int = 250

    @property
    def dataset(self) -> str:
        return "bars_1d" if self.frequency == "1d" else "bars_1m"


@dataclass
class CollectionResult:
    snapshot: SnapshotRecord | None
    quality: QualityReport
    failures: dict[str, str] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)
    truncated: list[str] = field(default_factory=list)
    elapsed: float = 0.0

    def to_dict(self) -> dict[str, object]:
        return {
            "snapshot": self.snapshot.to_dict() if self.snapshot else None,
            "quality": self.quality.to_dict(),
            "failures": self.failures,
            "skipped": self.skipped,
            "history_truncated": self.truncated,
            "elapsed_seconds": round(self.elapsed, 2),
        }


class Collector:
    def __init__(
        self,
        source: MarketDataSource,
        store: DatasetStore,
        *,
        names: dict[str, str] | None = None,
        progress: Callable[[str], None] | None = None,
        fail_fast: bool = False,
    ) -> None:
        self.source = source
        self.store = store
        self.names = names or {}
        self.progress = progress or _default_progress
        self.fail_fast = fail_fast

    def run(self, request: CollectionRequest) -> CollectionResult:
        if request.workers > 1 and len(request.symbols) > 1:
            return self._run_concurrent(request)
        return self._run_serial(request)

    # -- serial ----------------------------------------------------------
    def _run_serial(self, request: CollectionRequest) -> CollectionResult:
        started = time.monotonic()
        coverage = (
            self.store.coverage(request.dataset, request.interval) if request.incremental else {}
        )
        total = len(request.symbols)
        aggregate = QualityReport()
        failures: dict[str, str] = {}
        skipped: list[str] = []
        truncated: list[str] = []
        all_bars = []

        calendar = self._calendar(request)
        today = date.today()

        for index, symbol in enumerate(request.symbols, 1):
            prefix = f"[{index}/{total}] {symbol.key}"
            window_start = _window_start(request, symbol, coverage, today)
            if window_start is None:
                skipped.append(symbol.key)
                self.progress(f"{prefix} already up to date")
                continue

            try:
                response = self._fetch(request, symbol, window_start)
            except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the run
                failures[symbol.key] = str(exc)
                self.progress(f"{prefix} FAILED: {exc}")
                if self.fail_fast:
                    raise
                continue

            accepted, report = self._absorb(request, symbol, response, aggregate)
            all_bars.extend(accepted)
            if response.meta.get("history_truncated"):
                truncated.append(symbol.key)
            self.progress(
                f"{prefix} {len(accepted)} bars "
                f"{window_start.isoformat()}..{request.end.isoformat()}"
                + (f" ({report.dropped} dropped)" if report.dropped else "")
            )

        elapsed = time.monotonic() - started
        snapshot = None
        if all_bars:
            snapshot = self.store.append(
                request.dataset,
                all_bars,
                source=self.source.name,
                frequency=request.frequency,
                interval=request.interval,
                adjust=request.adjust,
                quality=aggregate.to_dict(),
                extra=self._extra(request, failures, skipped, truncated, total),
            )
        elif failures:
            raise SourceError(
                f"no bars collected; {len(failures)} symbol(s) failed, "
                f"first error: {next(iter(failures.values()))}"
            )

        return CollectionResult(
            snapshot=snapshot,
            quality=aggregate,
            failures=failures,
            skipped=skipped,
            truncated=truncated,
            elapsed=elapsed,
        )

    # -- concurrent ------------------------------------------------------
    def _run_concurrent(self, request: CollectionRequest) -> CollectionResult:
        started = time.monotonic()
        coverage = (
            self.store.coverage(request.dataset, request.interval) if request.incremental else {}
        )
        today = date.today()
        aggregate = QualityReport()
        failures: dict[str, str] = {}
        skipped: list[str] = []
        truncated: list[str] = []
        buffer: list = []
        buffered_symbols = 0
        rows_total = 0
        first_ts: date | None = None
        last_ts: date | None = None
        run_id = new_snapshot_id()
        parts: list[dict[str, object]] = []
        last_record: SnapshotRecord | None = None

        jobs: list[tuple[Symbol, date]] = []
        for symbol in request.symbols:
            window_start = _window_start(request, symbol, coverage, today)
            if window_start is None:
                skipped.append(symbol.key)
            else:
                jobs.append((symbol, window_start))

        def flush() -> None:
            nonlocal buffer, buffered_symbols, rows_total, first_ts, last_ts, last_record
            if not buffer:
                return
            last_record = self.store.append(
                request.dataset,
                buffer,
                source=self.source.name,
                frequency=request.frequency,
                interval=request.interval,
                adjust=request.adjust,
                snapshot_id=run_id,
                write_manifest=False,
                manifest_parts=parts,
            )
            rows_total += last_record.rows
            buffer = []
            buffered_symbols = 0

        total = len(jobs)
        if total:
            with ThreadPoolExecutor(max_workers=min(request.workers, total)) as pool:
                futures = {
                    pool.submit(self._fetch, request, symbol, window_start): (symbol, window_start)
                    for symbol, window_start in jobs
                }
                for done in as_completed(futures):
                    symbol, window_start = futures[done]
                    try:
                        response = done.result()
                    except Exception as exc:  # noqa: BLE001
                        failures[symbol.key] = str(exc)
                        self.progress(f"{symbol.key} FAILED: {exc}")
                        if self.fail_fast:
                            raise
                        continue

                    accepted, report = self._absorb(request, symbol, response, aggregate)
                    if response.meta.get("history_truncated"):
                        truncated.append(symbol.key)
                    if accepted:
                        buffer.extend(accepted)
                        buffered_symbols += 1
                        day_min = accepted[0].ts.date()
                        day_max = accepted[-1].ts.date()
                        first_ts = day_min if first_ts is None or day_min < first_ts else first_ts
                        last_ts = day_max if last_ts is None or day_max > last_ts else last_ts
                    self.progress(f"{symbol.key} {len(accepted)} bars ({report.dropped} dropped)")
                    if buffered_symbols >= request.flush_size:
                        flush()

        flush()
        elapsed = time.monotonic() - started

        if rows_total and last_record is not None:
            payload = {
                **last_record.to_dict(),
                "rows": rows_total,
                "symbols": len({symbol.key for symbol, _ in jobs if symbol.key not in failures}),
                "start": first_ts.isoformat() if first_ts else None,
                "end": last_ts.isoformat() if last_ts else None,
                "source": self.source.name,
                "frequency": request.frequency,
                "adjust": request.adjust,
                "partitions": parts,
                "quality": aggregate.to_dict(),
                "extra": self._extra(request, failures, skipped, truncated, len(jobs)),
            }
            self.store.write_manifest(run_id, payload)
            snapshot = SnapshotRecord(
                snapshot_id=run_id,
                dataset=request.dataset,
                interval=request.interval,
                path=last_record.path,
                rows=rows_total,
                symbols=payload["symbols"],
                start=first_ts,
                end=last_ts,
                storage=self.store.storage,
            )
        else:
            snapshot = None
            if failures:
                raise SourceError(
                    f"no bars collected; {len(failures)} symbol(s) failed, "
                    f"first error: {next(iter(failures.values()))}"
                )

        return CollectionResult(
            snapshot=snapshot,
            quality=aggregate,
            failures=failures,
            skipped=skipped,
            truncated=truncated,
            elapsed=elapsed,
        )

    # -- shared ----------------------------------------------------------
    def _fetch(self, request: CollectionRequest, symbol: Symbol, start: date) -> SourceResponse:
        if request.frequency == "1d":
            return self.source.fetch_daily(symbol, start, request.end, request.adjust)
        if request.interval is None:
            raise SourceError("interval is required for minute collection")
        return self.source.fetch_minute(symbol, request.interval, start, request.end, request.adjust)

    def _absorb(
        self,
        request: CollectionRequest,
        symbol: Symbol,
        response: SourceResponse,
        aggregate: QualityReport,
    ) -> tuple[list, QualityReport]:
        if request.save_raw and response.raw:
            self.store.write_raw(
                self.source.name,
                request.dataset,
                symbol.key,
                response.raw,
                suffix=".json" if self.source.name != "baostock" else ".csv",
                interval=request.interval,
            )
        accepted, report = check_bars(
            response.bars,
            request.frequency,
            calendar=self._calendar(request),
            names=self.names,
        )
        _merge_report(aggregate, report)
        return accepted, report

    def _calendar(self, request: CollectionRequest) -> list[date] | None:
        if request.frequency != "1d":
            return None
        if not hasattr(self, "_calendar_cache"):
            try:
                self._calendar_cache = self.source.trading_days(request.start, request.end)
            except Exception:  # noqa: BLE001 - calendar is advisory, not fatal
                self._calendar_cache = None
        return self._calendar_cache

    def _extra(
        self,
        request: CollectionRequest,
        failures: dict[str, str],
        skipped: list[str],
        truncated: list[str],
        total: int,
    ) -> dict[str, object]:
        return {
            "requested": [request.start.isoformat(), request.end.isoformat()],
            "symbols_requested": total,
            "failures": failures,
            "skipped": skipped,
            "history_truncated": truncated,
            "incremental": request.incremental,
            "workers": request.workers,
        }


def _window_start(
    request: CollectionRequest,
    symbol: Symbol,
    coverage: dict[str, dict[str, object]],
    today: date,
) -> date | None:
    if not request.incremental:
        return request.start

    entry = coverage.get(symbol.key) or {}
    last = entry.get("end")
    if not last:
        return request.start
    last_day = date.fromisoformat(str(last))

    if request.frequency == "1d":
        start = last_day + timedelta(days=1)
        return start if start <= request.end else None

    if last_day >= request.end:
        return request.end if request.end >= today else None
    return max(request.start, last_day)


def _merge_report(total: QualityReport, part: QualityReport) -> None:
    total.checked += part.checked
    total.accepted += part.accepted
    total.dropped += part.dropped
    total.duplicates += part.duplicates
    total.issues.extend(part.issues)


def _default_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)