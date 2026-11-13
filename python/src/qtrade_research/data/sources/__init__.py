"""Market data adapters."""

from .base import Capability, Instrument, MarketDataSource, SourceError, SourceResponse
from .baostock_source import BaoStockSource
from .eastmoney import EastMoneySource
from .sina import SinaSource
from .xueqiu import XueqiuSource

SOURCES = {
    "eastmoney": EastMoneySource,
    "baostock": BaoStockSource,
    "sina": SinaSource,
    "xueqiu": XueqiuSource,
}

__all__ = [
    "SOURCES",
    "BaoStockSource",
    "Capability",
    "EastMoneySource",
    "Instrument",
    "MarketDataSource",
    "SinaSource",
    "XueqiuSource",
    "SourceError",
    "SourceResponse",
]