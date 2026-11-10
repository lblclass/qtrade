"""Eastmoney adapter: free, no token, richest daily history.

Measured limits (2026-11, from ``qtrade-data sources --probe`` style checks):

* daily (``klt=101``): full history back to listing, ~6400 bars for 600000.SH
* 1 minute (``klt=1``): 240 bars, i.e. the current trading day only
* 5/15/30/60 minute: 1536 / 512 / 256 / 128 bars (about one month)

Because Eastmoney caps intraday history, the collector appends 1-minute bars
after every session: a daily cron run builds minute history incrementally.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from ...domain import Bar
from ..http import HttpClient, HttpError
from ..symbols import Symbol, board_of
from .base import Capability, Instrument, SourceError, SourceResponse

KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"

MARKET_FILTER = "m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80,m:0+t:81+s:2048"
DAILY_FIELDS = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
MINUTE_FIELDS = "f51,f52,f53,f54,f55,f56,f57"

ADJUST_FLAGS = {"none": 0, "qfq": 1, "hfq": 2}
MINUTE_CAPS = {1: 240, 5: 1536, 15: 512, 30: 256, 60: 128}


def _decimal(value: str) -> Decimal:
    try:
        return Decimal(value)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"bad decimal {value!r}") from exc


def parse_daily_klines(lines: list[str], symbol: Symbol) -> list[Bar]:
    """Parse Eastmoney daily rows (date,open,close,high,low,volume,amount,...)."""
    bars: list[Bar] = []
    for line in lines:
        parts = line.split(",")
        if len(parts) < 7:
            continue
        try:
            trade_date = datetime.strptime(parts[0], "%Y-%m-%d").date()
            open_price, close_price, high, low = (_decimal(p) for p in parts[1:5])
            # Eastmoney reports volume in lots (手); the domain uses shares.
            volume = int(float(parts[5])) * 100
            amount = _decimal(parts[6])
            bars.append(
                Bar(
                    symbol=symbol.key,
                    ts=datetime.combine(trade_date, datetime.min.time()).replace(hour=15),
                    open=open_price,
                    high=high,
                    low=low,
                    close=close_price,
                    volume=volume,
                    amount=amount,
                )
            )
        except (ValueError, KeyError):
            continue
    return bars


def parse_minute_klines(lines: list[str], symbol: Symbol) -> list[Bar]:
    """Parse Eastmoney minute rows (datetime,open,close,high,low,volume,amount)."""
    bars: list[Bar] = []
    for line in lines:
        parts = line.split(",")
        if len(parts) < 7:
            continue
        try:
            ts = datetime.strptime(parts[0], "%Y-%m-%d %H:%M")
            open_price, close_price, high, low = (_decimal(p) for p in parts[1:5])
            volume = int(float(parts[5])) * 100
            amount = _decimal(parts[6])
            bars.append(
                Bar(
                    symbol=symbol.key,
                    ts=ts,
                    open=open_price,
                    high=high,
                    low=low,
                    close=close_price,
                    volume=volume,
                    amount=amount,
                )
            )
        except (ValueError, KeyError):
            continue
    return bars


class EastMoneySource:
    name = "eastmoney"
    capability = Capability(
        daily=True,
        minute_intervals=(1, 5, 15, 30, 60),
        instruments=True,
        calendar=True,
        adjustments=("none", "qfq", "hfq"),
        notes="free, no token; 1m=current day, 5m~1 month",
    )

    def __init__(self, client: HttpClient | None = None, *, min_interval: float = 0.25) -> None:
        self.client = client or HttpClient(
            min_interval=min_interval,
            headers={"Referer": "https://quote.eastmoney.com/"},
        )
        self._calendar: list[date] | None = None

    # -- instruments -----------------------------------------------------
    def instruments(self) -> list[Instrument]:
        results: list[Instrument] = []
        page = 1
        while True:
            payload = self.client.get_json(
                LIST_URL,
                {
                    "pn": page,
                    "pz": 100,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f12",
                    "fs": MARKET_FILTER,
                    "fields": "f12,f13,f14,f26",
                },
            )
            data = payload.get("data") or {}
            diff = data.get("diff") or []
            if isinstance(diff, dict):
                diff = list(diff.values())
            if not diff:
                break

            for item in diff:
                code = str(item.get("f12", "")).strip()
                if len(code) != 6 or not code.isdigit():
                    continue
                exchange = "SH" if item.get("f13") == 1 else ("BJ" if code.startswith(("4", "8", "92")) else "SZ")
                try:
                    symbol = Symbol(code=code, exchange=exchange)
                except ValueError:
                    continue
                results.append(
                    Instrument(
                        symbol=symbol.key,
                        name=str(item.get("f14", "")).strip(),
                        exchange=exchange,
                        board=board_of(symbol),
                        is_active=True,
                        list_date=_parse_compact_date(item.get("f26")),
                    )
                )

            total = int(data.get("total") or 0)
            if page * 100 >= total:
                break
            page += 1

        if not results:
            raise SourceError("eastmoney returned an empty instrument list")
        return results

    # -- bars ------------------------------------------------------------
    def fetch_daily(
        self, symbol: Symbol, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        if adjust not in ADJUST_FLAGS:
            raise SourceError(f"unsupported adjust flag: {adjust}")
        payload = self._kline(symbol, 101, start, end, adjust, DAILY_FIELDS, limit=100000)
        lines = _klines(payload)
        bars = parse_daily_klines(lines, symbol)
        return SourceResponse(
            bars=bars,
            raw=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            meta={
                "source": self.name,
                "adjust": adjust,
                "requested": [start.isoformat(), end.isoformat()],
                "returned": len(bars),
                "dktotal": _dktotal(payload),
            },
        )

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        if interval not in MINUTE_CAPS:
            raise SourceError(f"eastmoney does not serve {interval} minute bars")
        if adjust not in ADJUST_FLAGS:
            raise SourceError(f"unsupported adjust flag: {adjust}")
        cap = MINUTE_CAPS[interval]
        payload = self._kline(symbol, interval, start, end, adjust, MINUTE_FIELDS, limit=cap)
        lines = _klines(payload)
        bars = parse_minute_klines(lines, symbol)
        bars = [bar for bar in bars if start <= bar.ts.date() <= end]
        return SourceResponse(
            bars=bars,
            raw=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            meta={
                "source": self.name,
                "adjust": adjust,
                "interval": interval,
                "requested": [start.isoformat(), end.isoformat()],
                "returned": len(bars),
                "history_cap": cap,
                "history_truncated": bool(bars) and bars[0].ts.date() > start + timedelta(days=10),
            },
        )

    def trading_days(self, start: date, end: date) -> list[date]:
        if self._calendar is None:
            payload = self._kline(
                Symbol(code="000001", exchange="SH"),
                101,
                date(1990, 1, 1),
                date(2100, 1, 1),
                "none",
                DAILY_FIELDS,
                limit=100000,
            )
            self._calendar = [
                datetime.strptime(line.split(",")[0], "%Y-%m-%d").date()
                for line in _klines(payload)
                if line.split(",")[0]
            ]
        return [day for day in self._calendar if start <= day <= end]

    # -- internals -------------------------------------------------------
    def _kline(
        self,
        symbol: Symbol,
        klt: int,
        start: date,
        end: date,
        adjust: str,
        fields2: str,
        *,
        limit: int,
    ) -> dict:
        try:
            payload = self.client.get_json(
                KLINE_URL,
                {
                    "secid": symbol.eastmoney_secid,
                    "fields1": "f1,f2,f3,f4,f5,f6",
                    "fields2": fields2,
                    "klt": klt,
                    "fqt": ADJUST_FLAGS[adjust],
                    "beg": start.strftime("%Y%m%d"),
                    "end": end.strftime("%Y%m%d"),
                    "lmt": limit,
                },
            )
        except HttpError as exc:
            raise SourceError(str(exc)) from exc
        if payload.get("rc") != 0:
            raise SourceError(f"eastmoney rc={payload.get('rc')} for {symbol.key}")
        return payload


def _klines(payload: dict) -> list[str]:
    data = payload.get("data") or {}
    return list(data.get("klines") or [])


def _dktotal(payload: dict) -> int:
    return int((payload.get("data") or {}).get("dktotal") or 0)


def _parse_compact_date(value: object) -> date | None:
    text = str(value or "").strip()
    if len(text) != 8 or not text.isdigit():
        return None
    try:
        return datetime.strptime(text, "%Y%m%d").date()
    except ValueError:
        return None