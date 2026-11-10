"""Data access, collection and snapshots for research and backtests."""

from .collector import CollectionRequest, CollectionResult, Collector
from .portal import DataPortal, InMemoryDataPortal, SnapshotDataPortal
from .quality import QualityIssue, QualityReport, check_bars
from .sources import SOURCES, BaoStockSource, EastMoneySource, SinaSource, SourceError
from .store import DatasetStore, SnapshotRecord
from .symbols import Symbol, parse_symbol, parse_symbols

__all__ = [
    "SOURCES",
    "BaoStockSource",
    "CollectionRequest",
    "CollectionResult",
    "Collector",
    "DataPortal",
    "DatasetStore",
    "EastMoneySource",
    "InMemoryDataPortal",
    "QualityIssue",
    "QualityReport",
    "SinaSource",
    "SnapshotDataPortal",
    "SnapshotRecord",
    "SourceError",
    "Symbol",
    "check_bars",
    "parse_symbol",
    "parse_symbols",
]