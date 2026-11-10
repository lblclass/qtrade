"""Sina adapter, used as a fallback when Eastmoney is unavailable.

Sina caps every request at 1023 bars, so it only provides roughly a month of
5/15/30/60-minute bars and about four years of daily bars.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from ...domain import Bar
from ..http import HttpClient, HttpError
from ..symbols import Symbol
from .base import Capability, Instrument, SourceError, SourceResponse

KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData"
SCALE_BY_INTERVAL = {5: 5, 15: 15, 30: 30, 60: 60}
MAX_BARS = 1023
_JSONP = re.compile(r"=\s*\((\[.*\])\)", re.S)


def parse_payload(text: str) -> list[dict[str, str]]:
    match = _JSONP.search(text)
    if not match:
        raise SourceError("unexpected sina JSONP payload")
    return json.loads(match.group(1))


def parse_rows(rows: list[dict[str, str]], symbol: Symbol) -> list[Bar]:
    """Sina returns ``YYYY-MM-DD HH:MM:SS`` for intraday and ``YYYY-MM-DD`` for daily."""
    bars: list[Bar] = []
    for row in rows:
        try:
            raw = str(row["day"]).strip()
            if " " in raw:
                ts = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
            else:
                ts = datetime.strptime(raw, "%Y-%m-%d").replace(hour=15)
            bars.append(
                Bar(
                    symbol=symbol.key,
                    ts=ts,
                    open=Decimal(str(row["open"])),
                    high=Decimal(str(row["high"])),
                    low=Decimal(str(row["low"])),
                    close=Decimal(str(row["close"])),
                    volume=int(float(row["volume"])),
                    amount=Decimal(str(row.get("amount", "0"))),
                )
            )
        except (KeyError, ValueError, InvalidOperation):
            continue
    return bars


class SinaSource:
    name = "sina"
    capability = Capability(
        daily=True,
        minute_intervals=(5, 15, 30, 60),
        instruments=False,
        calendar=False,
        adjustments=("none",),
        notes="fallback only; 1023 bars per request",
    )

    def __init__(self, client: HttpClient | None = None, *, min_interval: float = 0.4) -> None:
        self.client = client or HttpClient(
            min_interval=min_interval, headers={"Referer": "https://finance.sina.com.cn/"}
        )

    def instruments(self) -> list[Instrument]:
        raise SourceError("sina adapter does not provide an instrument list")

    def fetch_daily(
        self, symbol: Symbol, start: date, end: date, adjust: str = "none"
    ) -> SourceResponse:
        return self._fetch(symbol, 240, start, end, interval=None)

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "none"
    ) -> SourceResponse:
        if interval not in SCALE_BY_INTERVAL:
            raise SourceError(f"sina does not serve {interval} minute bars")
        return self._fetch(symbol, SCALE_BY_INTERVAL[interval], start, end, interval=interval)

    def trading_days(self, start: date, end: date) -> list[date]:
        raise SourceError("sina adapter does not provide a trading calendar")

    def _fetch(
        self, symbol: Symbol, scale: int, start: date, end: date, interval: int | None
    ) -> SourceResponse:
        try:
            text = self.client.get_text(
                KLINE_URL,
                {
                    "symbol": symbol.sina_code,
                    "scale": scale,
                    "ma": "no",
                    "datalen": MAX_BARS,
                },
            )
            rows = parse_payload(text)
        except (HttpError, ValueError) as exc:
            raise SourceError(str(exc)) from exc

        bars = [bar for bar in parse_rows(rows, symbol) if start <= bar.ts.date() <= end]
        return SourceResponse(
            bars=bars,
            raw=text.encode("utf-8", errors="replace"),
            meta={
                "source": self.name,
                "interval": interval or "1d",
                "requested": [start.isoformat(), end.isoformat()],
                "returned": len(bars),
                "history_cap": MAX_BARS,
                "history_truncated": bool(bars) and bars[0].ts.date() > start + timedelta(days=10),
            },
        )