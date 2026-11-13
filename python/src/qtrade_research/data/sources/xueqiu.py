"""Xueqiu (雪球) adapter: free, cookie-only, full daily history in one call.

``stock.xueqiu.com/v5/stock/chart/kline.json`` returns up to ~10000 daily bars
per request, which covers every A-share listing (the oldest, 000001.SZ, has
~8500 bars since 1991). It exposes three adjustments:

* ``normal`` — 不复权, prices exactly as quoted on the exchange
* ``before`` — 前复权, may go negative for very old high-dividend names
* ``after``  — 后复权, always positive and consistent across dividends

The endpoint requires a browser cookie, obtained once from ``https://xueqiu.com``.
Only daily bars are supported; the instrument master and intraday history still
come from Eastmoney / BaoStock.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from ...domain import Bar
from ..http import HttpClient, HttpError
from ..symbols import Symbol
from .base import Capability, Instrument, SourceError, SourceResponse

KLINE_URL = "https://stock.xueqiu.com/v5/stock/chart/kline.json"
HOME_URL = "https://xueqiu.com"

ADJUST_TYPES = {"none": "normal", "qfq": "before", "hfq": "after"}
MAX_BARS = 10000
SHANGHAI = timezone(timedelta(hours=8))
_COOKIE_NAMES = ("xq_a_token", "xqat", "u", "device_id", "s")


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"bad decimal {value!r}") from exc


def _cookie_header() -> str:
    """Fetch an anonymous session cookie; try a few entry pages before giving up."""
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
    )
    cached = os.environ.get("QTRADE_XUEQIU_COOKIE", "").strip()
    if cached:
        return cached

    last_error: Exception | None = None
    for url in (HOME_URL, f"{HOME_URL}/hq", f"{HOME_URL}/S/SH600000"):
        request = urllib.request.Request(url, headers={"User-Agent": ua})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                cookies = response.headers.get_all("Set-Cookie") or []
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            continue

        pairs: list[str] = []
        for item in cookies:
            pair = item.split(";", 1)[0].strip()
            name = pair.split("=", 1)[0]
            if name in _COOKIE_NAMES and pair not in pairs:
                pairs.append(pair)
        if pairs:
            return "; ".join(pairs)

    raise SourceError(f"xueqiu did not return an auth cookie: {last_error}")

def parse_daily_items(items: list[list[Any]], symbol: Symbol) -> list[Bar]:
    """Convert ``data.item`` rows into domain bars.

    Column order: timestamp(ms), volume(shares), open, high, low, close, chg,
    percent, turnoverrate, amount, ...
    """
    bars: list[Bar] = []
    for row in items:
        if len(row) < 6:
            continue
        try:
            moment = datetime.fromtimestamp(int(row[0]) / 1000, tz=SHANGHAI)
            open_price = _decimal(row[2])
            high = _decimal(row[3])
            low = _decimal(row[4])
            close = _decimal(row[5])
            volume = int(row[1] or 0)
            amount = _decimal(row[9]) if len(row) > 9 and row[9] is not None else Decimal("0")
        except (ValueError, TypeError, OverflowError):
            continue
        trade_date = moment.date()
        try:
            bars.append(
                Bar(
                    symbol=symbol.key,
                    ts=datetime.combine(trade_date, datetime.min.time()).replace(hour=15),
                    open=open_price,
                    high=high,
                    low=low,
                    close=close,
                    volume=volume,
                    amount=amount,
                )
            )
        except ValueError:
            # Vendor rows occasionally have a close outside [low, high]; skip the row
            # instead of failing the whole symbol (checked again by the quality gate).
            continue
    return bars


class XueqiuSource:
    name = "xueqiu"
    capability = Capability(
        daily=True,
        minute_intervals=(),
        instruments=False,
        calendar=False,
        adjustments=("none", "qfq", "hfq"),
        notes="free; full daily history in one call; cookie required; no intraday",
    )

    def __init__(self, min_interval: float = 0.2) -> None:
        self._cookie = _cookie_header()
        self.client = HttpClient(
            min_interval=min_interval,
            headers={"Cookie": self._cookie, "Referer": "https://xueqiu.com/"},
        )

    def instruments(self) -> list[Instrument]:
        raise SourceError("xueqiu has no A-share instrument master; use --source eastmoney")

    def trading_days(self, start: date, end: date) -> list[date]:
        raise SourceError("xueqiu adapter does not provide a trading calendar")

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        raise SourceError("xueqiu adapter serves daily bars only")

    def fetch_daily(
        self, symbol: Symbol, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        if adjust not in ADJUST_TYPES:
            raise SourceError(f"unsupported adjust flag: {adjust}")

        bars = self._collect(symbol, start, end, ADJUST_TYPES[adjust])
        return SourceResponse(
            bars=bars,
            raw=json.dumps({"symbol": symbol.key, "rows": len(bars)}, ensure_ascii=False).encode("utf-8"),
            meta={
                "source": self.name,
                "adjust": adjust,
                "requested": [start.isoformat(), end.isoformat()],
                "returned": len(bars),
            },
        )

    def close(self) -> None:
        return None

    # -- internals -------------------------------------------------------
    def _collect(self, symbol: Symbol, start: date, end: date, adjust_type: str) -> list[Bar]:
        collected: list[Bar] = []
        cursor = int(datetime.now(tz=SHANGHAI).timestamp() * 1000)
        for _ in range(8):
            payload = self._request(symbol, cursor, adjust_type)
            data = payload.get("data") or {}
            items = data.get("item") or []
            if not items:
                break
            batch = parse_daily_items(items, symbol)
            if not batch:
                break
            collected.extend(batch)
            earliest = min(bar.ts.date() for bar in batch)
            if earliest <= start or len(items) < MAX_BARS:
                break
            cursor = int(datetime.combine(earliest, datetime.min.time(), tzinfo=SHANGHAI).timestamp() * 1000) - 1

        unique = {bar.ts: bar for bar in collected}
        return [bar for ts, bar in sorted(unique.items()) if start <= ts.date() <= end]

    def _request(self, symbol: Symbol, cursor: int, adjust_type: str) -> dict:
        params = {
            "symbol": f"{symbol.exchange}{symbol.code}",
            "begin": cursor,
            "period": "day",
            "type": adjust_type,
            "count": -MAX_BARS,
            "indicator": "kline",
        }
        try:
            payload = self.client.get_json(KLINE_URL, params)
        except HttpError as exc:
            # The anonymous cookie expires after a while; refresh it once.
            self._cookie = _cookie_header()
            self.client._base_headers["Cookie"] = self._cookie
            try:
                payload = self.client.get_json(KLINE_URL, params)
            except HttpError as retry_exc:
                raise SourceError(str(retry_exc)) from exc
        if payload.get("error_code") not in (None, 0):
            raise SourceError(
                f"xueqiu error {payload.get('error_code')}: {payload.get('error_description')}"
            )
        return payload