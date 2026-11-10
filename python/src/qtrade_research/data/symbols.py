"""Symbol normalisation shared by every market data adapter.

Internal codes use the ``600000.SH`` form so that a symbol is unambiguous
across sources. Each adapter converts to the vendor notation it needs.
"""

from __future__ import annotations

from dataclasses import dataclass

EXCHANGES = ("SH", "SZ", "BJ")

_SUFFIX_ALIASES = {
    "SH": "SH",
    "SS": "SH",
    "XSHG": "SH",
    "SZ": "SZ",
    "XSHE": "SZ",
    "BJ": "BJ",
    "BSE": "BJ",
}

BOARD_MAIN_SH = "MAIN_SH"
BOARD_STAR = "STAR"
BOARD_MAIN_SZ = "MAIN_SZ"
BOARD_CHINEXT = "CHINEXT"
BOARD_BSE = "BSE"

# Daily price limit bands by board. ST names use 5% on the main boards only;
# STAR/ChiNext ST names still trade with a 20% band.
_LIMIT_RATIO = {
    BOARD_MAIN_SH: 0.10,
    BOARD_MAIN_SZ: 0.10,
    BOARD_STAR: 0.20,
    BOARD_CHINEXT: 0.20,
    BOARD_BSE: 0.30,
}
_ST_LIMIT_RATIO = 0.05


@dataclass(frozen=True, order=True)
class Symbol:
    code: str
    exchange: str

    def __post_init__(self) -> None:
        if len(self.code) != 6 or not self.code.isdigit():
            raise ValueError(f"invalid A-share code: {self.code!r}")
        if self.exchange not in EXCHANGES:
            raise ValueError(f"unsupported exchange: {self.exchange!r}")

    @property
    def key(self) -> str:
        return f"{self.code}.{self.exchange}"

    @property
    def eastmoney_secid(self) -> str:
        """Eastmoney uses 1 for Shanghai and 0 for Shenzhen/Beijing."""
        return f"{1 if self.exchange == 'SH' else 0}.{self.code}"

    @property
    def baostock_code(self) -> str:
        return f"{self.exchange.lower()}.{self.code}"

    @property
    def sina_code(self) -> str:
        return f"{self.exchange.lower()}{self.code}"

    @property
    def board(self) -> str:
        return board_of(self)

    def __str__(self) -> str:
        return self.key


def board_of(symbol: Symbol) -> str:
    code = symbol.code
    if symbol.exchange == "BJ":
        return BOARD_BSE
    if symbol.exchange == "SH":
        if code.startswith(("688", "689")):
            return BOARD_STAR
        return BOARD_MAIN_SH
    if code.startswith(("300", "301")):
        return BOARD_CHINEXT
    return BOARD_MAIN_SZ


def limit_ratio(symbol: Symbol, name: str = "") -> float:
    """Heuristic daily price-limit band used by the quality gate."""
    board = board_of(symbol)
    if "ST" in name.upper() and board in (BOARD_MAIN_SH, BOARD_MAIN_SZ):
        return _ST_LIMIT_RATIO
    return _LIMIT_RATIO[board]


def guess_exchange(code: str) -> str:
    if code.startswith(("600", "601", "603", "605", "688", "689", "900")):
        return "SH"
    if code.startswith(("000", "001", "002", "003", "300", "301", "200")):
        return "SZ"
    if code.startswith(("4", "8", "92")):
        return "BJ"
    if code.startswith(("5", "9")):
        return "SH"
    if code.startswith(("1", "2", "3", "0")):
        return "SZ"
    raise ValueError(f"cannot infer exchange for code {code!r}")


def parse_symbol(raw: str) -> Symbol:
    """Parse ``600000``, ``600000.SH``, ``SH600000`` or ``SH.600000``."""
    text = raw.strip().upper().replace("-", ".").replace("_", ".")
    if not text:
        raise ValueError("empty symbol")

    if "." in text:
        left, right = text.split(".", 1)
        if left in _SUFFIX_ALIASES:
            code, suffix = right, left
        else:
            code, suffix = left, right
        exchange = _SUFFIX_ALIASES.get(suffix)
        if exchange is None:
            raise ValueError(f"unknown exchange suffix in {raw!r}")
        return Symbol(code=code, exchange=exchange)

    if len(text) > 6 and text[:2] in _SUFFIX_ALIASES:
        return Symbol(code=text[2:], exchange=_SUFFIX_ALIASES[text[:2]])

    return Symbol(code=text, exchange=guess_exchange(text))


def parse_symbols(raw: str | list[str]) -> list[Symbol]:
    """Parse a comma/space separated symbol list, preserving order and uniqueness."""
    items = raw if isinstance(raw, list) else raw.replace(" ", ",").split(",")
    seen: set[str] = set()
    parsed: list[Symbol] = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        symbol = parse_symbol(item)
        if symbol.key in seen:
            continue
        seen.add(symbol.key)
        parsed.append(symbol)
    return parsed