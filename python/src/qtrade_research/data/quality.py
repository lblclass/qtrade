"""Validation rules applied between normalisation and snapshot write.

Every rule is deliberately cheap and deterministic: the goal is to keep bad
vendor rows out of the research dataset and to leave an auditable reason, not
to model every exchange corner case.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal

from ..domain import Bar
from .symbols import Symbol, limit_ratio, parse_symbol

BLOCKER = "blocker"
WARNING = "warning"
INFO = "info"

MORNING = (time(9, 30), time(11, 30))
AFTERNOON = (time(13, 0), time(15, 0))


@dataclass(frozen=True)
class QualityIssue:
    level: str
    code: str
    message: str
    symbol: str = ""
    ts: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "level": self.level,
            "code": self.code,
            "message": self.message,
            "symbol": self.symbol,
            "ts": self.ts,
        }


@dataclass
class QualityReport:
    checked: int = 0
    accepted: int = 0
    dropped: int = 0
    duplicates: int = 0
    issues: list[QualityIssue] = field(default_factory=list)

    def add(self, level: str, code: str, message: str, symbol: str = "", ts: str = "") -> None:
        self.issues.append(QualityIssue(level, code, message, symbol, ts))

    @property
    def blockers(self) -> list[QualityIssue]:
        return [issue for issue in self.issues if issue.level == BLOCKER]

    @property
    def warnings(self) -> list[QualityIssue]:
        return [issue for issue in self.issues if issue.level == WARNING]

    def to_dict(self) -> dict[str, object]:
        return {
            "checked": self.checked,
            "accepted": self.accepted,
            "dropped": self.dropped,
            "duplicates": self.duplicates,
            "blockers": len(self.blockers),
            "warnings": len(self.warnings),
            "issues": [issue.to_dict() for issue in self.issues[:200]],
        }


def check_bars(
    bars: list[Bar],
    frequency: str,
    *,
    calendar: list[date] | None = None,
    names: dict[str, str] | None = None,
) -> tuple[list[Bar], QualityReport]:
    """Return accepted bars and a report describing everything rejected."""
    report = QualityReport(checked=len(bars))
    accepted: list[Bar] = []
    seen: dict[tuple[str, datetime], int] = {}

    for bar in bars:
        if not _valid_prices(bar):
            report.dropped += 1
            report.add(BLOCKER, "invalid_ohlc", "price/OHLC invariant violated", bar.symbol, bar.ts.isoformat())
            continue
        if bar.volume < 0:
            report.dropped += 1
            report.add(BLOCKER, "negative_volume", f"volume={bar.volume}", bar.symbol, bar.ts.isoformat())
            continue
        if bar.amount < 0:
            report.dropped += 1
            report.add(BLOCKER, "negative_amount", f"amount={bar.amount}", bar.symbol, bar.ts.isoformat())
            continue

        key = (bar.symbol, bar.ts)
        if key in seen:
            report.duplicates += 1
            report.dropped += 1
            accepted[seen[key]] = bar  # last writer wins
            report.add(INFO, "duplicate_bar", "duplicate timestamp replaced", bar.symbol, bar.ts.isoformat())
            continue
        seen[key] = len(accepted)
        accepted.append(bar)

        if bar.volume > 0 and bar.amount == 0:
            report.add(WARNING, "zero_amount", "volume>0 but amount=0", bar.symbol, bar.ts.isoformat())
        if frequency != "1d" and not _in_session(bar.ts.time()):
            report.add(WARNING, "off_session", f"timestamp {bar.ts.isoformat()} outside trading hours", bar.symbol, bar.ts.isoformat())

    accepted.sort(key=lambda bar: (bar.symbol, bar.ts))
    report.accepted = len(accepted)

    if frequency == "1d":
        _check_daily(accepted, report, calendar, names or {})
    return accepted, report


def _valid_prices(bar: Bar) -> bool:
    prices = (bar.open, bar.high, bar.low, bar.close)
    if any(price <= 0 for price in prices):
        return False
    if bar.high < bar.low:
        return False
    return bar.low <= bar.open <= bar.high and bar.low <= bar.close <= bar.high


def _in_session(moment: time) -> bool:
    if MORNING[0] <= moment <= MORNING[1]:
        return True
    return AFTERNOON[0] <= moment <= AFTERNOON[1]


def _check_daily(
    bars: list[Bar],
    report: QualityReport,
    calendar: list[date] | None,
    names: dict[str, str],
) -> None:
    by_symbol: dict[str, list[Bar]] = defaultdict(list)
    for bar in bars:
        by_symbol[bar.symbol].append(bar)

    open_days = set(calendar or [])
    for symbol_key, series in by_symbol.items():
        series.sort(key=lambda bar: bar.ts)

        if open_days:
            first, last = series[0].ts.date(), series[-1].ts.date()
            expected = sorted(day for day in open_days if first <= day <= last)
            present = {bar.ts.date() for bar in series}
            missing = [day for day in expected if day not in present]
            if missing:
                preview = ", ".join(day.isoformat() for day in missing[:5])
                report.add(
                    WARNING,
                    "calendar_gap",
                    f"{len(missing)} trading days missing ({preview}...)",
                    symbol_key,
                )

        try:
            symbol = parse_symbol(symbol_key)
        except ValueError:
            continue
        band = Decimal(str(limit_ratio(symbol, names.get(symbol_key, ""))))
        outlier_count = 0
        for previous, current in zip(series, series[1:]):
            if previous.close <= 0:
                continue
            change = abs(current.close / previous.close - 1)
            if change > band * Decimal("1.5"):
                outlier_count += 1
        if outlier_count:
            report.add(
                WARNING,
                "return_outlier",
                f"{outlier_count} daily moves exceed {band * 100:.0f}% limit heuristic",
                symbol_key,
            )