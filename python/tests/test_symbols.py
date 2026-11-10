from __future__ import annotations

import unittest

from qtrade_research.data.symbols import (
    Symbol,
    board_of,
    limit_ratio,
    parse_symbol,
    parse_symbols,
)


class TestSymbolParsing(unittest.TestCase):
    def test_accepts_common_notations(self) -> None:
        for raw in ("600000", "600000.SH", "SH600000", "sh.600000", "600000.sh"):
            self.assertEqual(parse_symbol(raw), Symbol(code="600000", exchange="SH"), raw)

    def test_infers_exchange(self) -> None:
        self.assertEqual(parse_symbol("000001").exchange, "SZ")
        self.assertEqual(parse_symbol("300750").exchange, "SZ")
        self.assertEqual(parse_symbol("688981").exchange, "SH")
        self.assertEqual(parse_symbol("830799").exchange, "BJ")

    def test_vendor_notations(self) -> None:
        symbol = parse_symbol("600000.SH")
        self.assertEqual(symbol.eastmoney_secid, "1.600000")
        self.assertEqual(parse_symbol("000001.SZ").eastmoney_secid, "0.000001")
        self.assertEqual(symbol.baostock_code, "sh.600000")
        self.assertEqual(symbol.sina_code, "sh600000")

    def test_boards_and_limits(self) -> None:
        self.assertEqual(board_of(parse_symbol("688981")), "STAR")
        self.assertEqual(board_of(parse_symbol("300750")), "CHINEXT")
        self.assertAlmostEqual(limit_ratio(parse_symbol("600000"), "ST浦发"), 0.05)
        self.assertAlmostEqual(limit_ratio(parse_symbol("688981"), "ST科创"), 0.20)

    def test_rejects_bad_input(self) -> None:
        with self.assertRaises(ValueError):
            parse_symbol("60000")
        with self.assertRaises(ValueError):
            parse_symbol("600000.XX")

    def test_parse_symbols_dedupes(self) -> None:
        result = parse_symbols("600000.SH, 600000, 000001.SZ")
        self.assertEqual([item.key for item in result], ["600000.SH", "000001.SZ"])


if __name__ == "__main__":
    unittest.main()