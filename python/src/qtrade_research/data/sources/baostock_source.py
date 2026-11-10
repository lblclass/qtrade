"""BaoStock adapter: free deep minute history (5-minute bars since 2020).

BaoStock needs the optional ``baostock`` + ``pandas`` packages and logs into a
remote service over a raw socket, so it is slower than the HTTP adapters and
should be used for backfills rather than intraday polling.
"""

from __future__ import annotations

import threading
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from ...domain import Bar
from ..symbols import Symbol, board_of
from .base import Capability, Instrument, SourceError, SourceResponse

_ADJUST = {"none": "3", "qfq": "2", "hfq": "1"}
_DAILY_FIELDS = "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST"
_MINUTE_FIELDS = "date,time,code,open,high,low,close,volume,amount"
_MINUTE_FREQ = {5: "5", 15: "15", 30: "30", 60: "60"}
_LOCK = threading.Lock()


def _require_baostock():
    try:
        import baostock as bs  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise SourceError(
            "baostock is not installed; run `pip install baostock pandas` "
            "or `pip install -e python[baostock]`"
        ) from exc
    return bs


class BaoStockSource:
    name = "baostock"
    capability = Capability(
        daily=True,
        minute_intervals=(5, 15, 30, 60),
        instruments=True,
        calendar=True,
        adjustments=("none", "qfq", "hfq"),
        notes="free; 5m history from 2020; slower socket API",
    )

    def __init__(self) -> None:
        self._bs = _require_baostock()
        self._logged_in = False

    # -- session ---------------------------------------------------------
    def _ensure_login(self) -> None:
        with _LOCK:
            if self._logged_in:
                return
            result = self._bs.login()
            if result.error_code != "0":
                raise SourceError(f"baostock login failed: {result.error_msg}")
            self._logged_in = True

    def close(self) -> None:
        with _LOCK:
            if self._logged_in:
                self._bs.logout()
                self._logged_in = False

    def __enter__(self) -> "BaoStockSource":
        self._ensure_login()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- instruments -----------------------------------------------------
    def instruments(self) -> list[Instrument]:
        self._ensure_login()
        result = self._bs.query_stock_basic()
        instruments: list[Instrument] = []
        while result.error_code == "0" and result.next():
            code, name, ipo, out_date, kind, status = result.get_row_data()[:6]
            if kind != "1":
                continue
            symbol = _symbol_from_baostock(code)
            if symbol is None:
                continue
            instruments.append(
                Instrument(
                    symbol=symbol.key,
                    name=name,
                    exchange=symbol.exchange,
                    board=board_of(symbol),
                    is_active=status == "1",
                    list_date=_date(ipo),
                )
            )
        if not instruments:
            raise SourceError("baostock returned an empty instrument list")
        return instruments

    # -- bars ------------------------------------------------------------
    def fetch_daily(
        self, symbol: Symbol, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        self._ensure_login()
        rows, raw = self._query(
            symbol, _DAILY_FIELDS, start, end, "d", _ADJUST.get(adjust)
        )
        bars: list[Bar] = []
        for row in rows:
            try:
                trade_date = datetime.strptime(row[0], "%Y-%m-%d").date()
                bars.append(
                    Bar(
                        symbol=symbol.key,
                        ts=datetime.combine(trade_date, datetime.min.time()).replace(hour=15),
                        open=Decimal(row[2]),
                        high=Decimal(row[3]),
                        low=Decimal(row[4]),
                        close=Decimal(row[5]),
                        volume=int(float(row[7])),
                        amount=Decimal(row[8]),
                    )
                )
            except (ValueError, IndexError, InvalidOperation):
                continue
        return SourceResponse(bars=bars, raw=raw, meta=_meta(self.name, symbol, start, end, len(bars)))

    def fetch_minute(
        self, symbol: Symbol, interval: int, start: date, end: date, adjust: str = "qfq"
    ) -> SourceResponse:
        self._ensure_login()
        if interval not in _MINUTE_FREQ:
            raise SourceError(f"baostock does not serve {interval} minute bars")
        if interval == 1:
            raise SourceError("baostock has no 1-minute history; use eastmoney for today's session")
        rows, raw = self._query(
            symbol, _MINUTE_FIELDS, start, end, _MINUTE_FREQ[interval], _ADJUST.get(adjust)
        )
        bars: list[Bar] = []
        for row in rows:
            try:
                bars.append(
                    Bar(
                        symbol=symbol.key,
                        ts=datetime.strptime(row[1][:14], "%Y%m%d%H%M%S"),
                        open=Decimal(row[3]),
                        high=Decimal(row[4]),
                        low=Decimal(row[5]),
                        close=Decimal(row[6]),
                        volume=int(float(row[7])),
                        amount=Decimal(row[8]),
                    )
                )
            except (ValueError, IndexError, InvalidOperation):
                continue
        meta = _meta(self.name, symbol, start, end, len(bars))
        meta["interval"] = interval
        meta["history_truncated"] = bool(bars) and bars[0].ts.date() > start + timedelta(days=10)
        return SourceResponse(bars=bars, raw=raw, meta=meta)

    def trading_days(self, start: date, end: date) -> list[date]:
        self._ensure_login()
        result = self._bs.query_trade_dates(
            start_date=start.isoformat(), end_date=end.isoformat()
        )
        if result.error_code != "0":
            raise SourceError(f"baostock trade calendar failed: {result.error_msg}")
        days: list[date] = []
        while result.next():
            calendar_date, is_open = result.get_row_data()[:2]
            if is_open == "1":
                parsed = _date(calendar_date)
                if parsed is not None:
                    days.append(parsed)
        return days

    # -- internals -------------------------------------------------------
    def _query(
        self,
        symbol: Symbol,
        fields: str,
        start: date,
        end: date,
        frequency: str,
        adjust: str | None,
    ) -> tuple[list[list[str]], bytes]:
        if adjust is None:
            raise SourceError(f"unsupported adjust flag: {adjust}")
        result = self._bs.query_history_k_data_plus(
            symbol.baostock_code,
            fields,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            frequency=frequency,
            adjustflag=adjust,
        )
        if result.error_code != "0":
            raise SourceError(
                f"baostock query failed for {symbol.key}: "
                f"{result.error_code} {result.error_msg}"
            )
        rows: list[list[str]] = []
        while result.next():
            rows.append(result.get_row_data())
        raw = b"\n".join(",".join(row).encode("utf-8") for row in rows)
        return rows, raw


def _meta(source: str, symbol: Symbol, start: date, end: date, returned: int) -> dict[str, object]:
    return {
        "source": source,
        "requested": [start.isoformat(), end.isoformat()],
        "returned": returned,
        "symbol": symbol.key,
    }


def _date(value: str) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def _symbol_from_baostock(code: str) -> Symbol | None:
    prefix, _, digits = code.partition(".")
    exchange = {"sh": "SH", "sz": "SZ", "bj": "BJ"}.get(prefix.lower())
    if exchange is None or len(digits) != 6:
        return None
    try:
        return Symbol(code=digits, exchange=exchange)
    except ValueError:
        return None