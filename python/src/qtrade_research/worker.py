"""Backtest worker: pops queued runs from the control plane and executes them
against the real daily snapshot exported by ``qtrade-data export-ui``.

The worker is deliberately dependency-free (stdlib only): it reads
``_series.json``, runs the same ``BacktestEngine`` the research CLI uses, and
posts metrics plus an equity curve back to the API. That closes the loop that
used to stop at "queued".
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from .backtest import BacktestConfig, BacktestEngine
from .domain import Bar
from .strategies.momentum import MomentumStrategy

CENT = Decimal("0.01")


def _request(url: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def _money(cents: int) -> Decimal:
    return (Decimal(int(cents)) / 100).quantize(CENT)


def _in_window(value: str, start: str, end: str) -> bool:
    return start <= value <= end


def _load_series(root: Path) -> dict[str, Any]:
    path = root / "_series.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _build_bars(series: dict[str, Any], start: str, end: str, universe_size: int) -> tuple[list[Bar], list[str]]:
    symbols = series.get("symbols", {})
    chosen = list(symbols)[: max(1, universe_size)]
    bars: list[Bar] = []
    for symbol in chosen:
        payload = symbols[symbol]
        dates = payload.get("dates", [])
        previous_close = Decimal("0")
        for index, day in enumerate(dates):
            close_cents = payload["close"][index]
            if close_cents <= 0:
                continue
            open_cents = payload["open"][index] or close_cents
            high_cents = payload["high"][index] or max(open_cents, close_cents)
            low_cents = payload["low"][index] or min(open_cents, close_cents)
            high_cents = max(high_cents, open_cents, close_cents)
            low_cents = min(low_cents, open_cents, close_cents)
            limit_up_cents = payload["limit_up"][index]
            limit_down_cents = payload["limit_down"][index]
            if limit_up_cents <= 0 and previous_close > 0:
                limit_up_cents = int((previous_close * Decimal("1.1") * 100).to_integral_value())
            if limit_down_cents <= 0 and previous_close > 0:
                limit_down_cents = int((previous_close * Decimal("0.9") * 100).to_integral_value())
            previous_close = _money(close_cents)
            if not _in_window(day, start, end):
                continue
            bars.append(
                Bar(
                    symbol=symbol,
                    ts=datetime.fromisoformat(day).replace(hour=15),
                    open=_money(open_cents),
                    high=_money(high_cents),
                    low=_money(low_cents),
                    close=_money(close_cents),
                    volume=int(payload["volume"][index] or 0),
                    amount=_money(close_cents) * int(payload["volume"][index] or 0),
                    limit_up=_money(limit_up_cents) if limit_up_cents > 0 else None,
                    limit_down=_money(limit_down_cents) if limit_down_cents > 0 else None,
                )
            )
    bars.sort(key=lambda item: (item.ts, item.symbol))
    return bars, chosen


def _sortino(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    downside = [value for value in returns if value < 0]
    if len(downside) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    deviation = (sum(value * value for value in downside) / len(downside)) ** 0.5
    if deviation == 0:
        return 0.0
    return mean / deviation * (252 ** 0.5)


def _benchmark_curve(series: dict[str, Any], start: str, end: str, initial_cash: Decimal) -> list[dict[str, Any]]:
    benchmark = series.get("benchmark") or {}
    dates = benchmark.get("dates", [])
    values = benchmark.get("values", [])
    window = [(day, value) for day, value in zip(dates, values) if _in_window(day, start, end)]
    if not window:
        return []
    base = window[0][1] or 1.0
    return [
        {"date": day, "benchmark_cents": int((initial_cash * Decimal(str(value / base))) * 100)}
        for day, value in window
    ]


def run_backtest(root: Path, run: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    logs: list[dict[str, str]] = []
    series = _load_series(root)
    logs.append({"level": "info", "message": f"加载行情窗口 _series.json（{series.get('end')}，{len(series.get('symbols', {}))} 只标的）"})
    params = run.get("params") or {}
    universe_size = int(params.get("universe_size") or 60)
    start = run.get("start_date") or series.get("end")
    end = run.get("end_date") or series.get("end")
    bars, chosen = _build_bars(series, start, end, universe_size)
    if not bars:
        raise RuntimeError(f"no bars between {start} and {end}")
    logs.append({"level": "info", "message": f"构建 {len(bars)} 根日线，覆盖 {len(chosen)} 只标的（{start} → {end}）"})
    strategy = MomentumStrategy(
        lookback=int(params.get("lookback") or 20),
        top_n=int(params.get("top_n") or 5),
        rebalance_every=int(params.get("rebalance_days") or 10),
    )
    initial_cash = Decimal(int(run.get("initial_cash_cents") or 100_000_000)) / 100
    engine = BacktestEngine(
        BacktestConfig(
            initial_cash=initial_cash,
            commission_bps=2.5,
            min_commission=5,
            stamp_tax_bps=5,
            transfer_fee_bps=0.1,
            slippage_bps=5,
            lot_size=100,
            max_volume_participation=Decimal("0.05"),
        )
    )
    logs.append({"level": "info", "message": f"运行策略：lookback={strategy.lookback} top_n={strategy.top_n} rebalance={strategy.rebalance_every}d"})
    result = engine.run(strategy, bars)
    metrics = result.metrics
    equity_curve = [
        {"date": point.ts.date().isoformat(), "equity_cents": int((point.equity * 100).to_integral_value())}
        for point in result.equity_curve
    ]
    benchmark = _benchmark_curve(series, start, end, initial_cash)
    benchmark_return = 0.0
    if len(benchmark) > 1 and benchmark[0]["benchmark_cents"]:
        benchmark_return = benchmark[-1]["benchmark_cents"] / benchmark[0]["benchmark_cents"] - 1
    returns: list[float] = []
    for previous, current in zip(result.equity_curve, result.equity_curve[1:]):
        if previous.equity > 0:
            returns.append(float(current.equity / previous.equity - 1))
    max_drawdown = float(metrics.get("max_drawdown", 0.0))
    annualized = float(metrics.get("annualized_return", 0.0))
    payload = {
        "total_return_bps": round(float(metrics.get("total_return", 0.0)) * 10_000),
        "annualized_return_bps": round(annualized * 10_000),
        "benchmark_return_bps": round(benchmark_return * 10_000),
        "alpha_bps": round((float(metrics.get("total_return", 0.0)) - benchmark_return) * 10_000),
        "max_drawdown_bps": round(abs(max_drawdown) * 10_000),
        "sharpe": round(float(metrics.get("sharpe", 0.0)), 4),
        "sortino": round(_sortino(returns), 4),
        "calmar": round(annualized / abs(max_drawdown), 4) if max_drawdown else 0.0,
        "turnover_bps": round(float(metrics.get("turnover", 0.0)) * 10_000),
        "win_rate_bps": round(sum(1 for value in returns if value > 0) / len(returns) * 10_000) if returns else 0,
        "volatility_bps": round((sum((value - sum(returns) / len(returns)) ** 2 for value in returns) / len(returns)) ** 0.5 * (252 ** 0.5) * 10_000) if len(returns) > 1 else 0,
        "trade_count": int(metrics.get("trade_count", 0)),
        "final_equity_cents": int((result.final_equity * 100).to_integral_value()),
        "bars": len(bars),
        "symbols": len(chosen),
        "benchmark_label": (series.get("benchmark") or {}).get("label", "等权基准"),
        "equity_curve": equity_curve,
        "benchmark_curve": benchmark,
    }
    logs.append({"level": "info", "message": f"回测完成：{payload['trade_count']} 笔成交，总收益 {payload['total_return_bps'] / 100:.2f}%，最大回撤 {payload['max_drawdown_bps'] / 100:.2f}%"})
    return payload, logs


def _log(api: str, message: str, level: str = "info") -> None:
    print(f"[worker] {level}: {message}", flush=True)


def process_once(api: str, root: Path) -> bool:
    response = _request(f"{api}/api/v1/backtests")
    items = response.get("items", []) if isinstance(response, dict) else []
    queued = [item for item in items if item.get("status") == "queued"]
    if not queued:
        return False
    run = queued[-1]
    run_id = run["id"]
    try:
        _request(f"{api}/api/v1/backtests/{run_id}/claim", method="POST")
    except urllib.error.HTTPError as error:
        if error.code == 409:
            return False
        raise
    _log(api, f"claimed {run_id} ({run.get('strategy_id')}@{run.get('strategy_version')})")
    try:
        metrics, logs = run_backtest(root, run)
        _request(
            f"{api}/api/v1/backtests/{run_id}/result",
            method="POST",
            payload={"status": "succeeded", "metrics": metrics, "logs": logs},
        )
        _log(api, f"succeeded {run_id}")
    except Exception as exc:  # noqa: BLE001 - the run must always be finalized
        message = f"{type(exc).__name__}: {exc}"
        _log(api, f"failed {run_id}: {message}", "error")
        try:
            _request(
                f"{api}/api/v1/backtests/{run_id}/result",
                method="POST",
                payload={
                    "status": "failed",
                    "metrics": {"error": message},
                    "logs": [{"level": "error", "message": message}],
                },
            )
        except Exception as post_exc:  # noqa: BLE001
            _log(api, f"could not report failure: {post_exc}", "error")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="qtrade-worker", description="run queued qtrade backtests")
    parser.add_argument("--api", default="http://localhost:8080")
    parser.add_argument("--data", default="/data")
    parser.add_argument("--interval", type=float, default=3.0)
    parser.add_argument("--once", action="store_true", help="process at most one run then exit")
    args = parser.parse_args(argv)
    api = args.api.rstrip("/")
    root = Path(args.data)
    print(f"[worker] polling {api} every {args.interval}s, data root {root}", flush=True)
    while True:
        try:
            worked = process_once(api, root)
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            print(f"[worker] loop error: {exc}", file=sys.stderr, flush=True)
            worked = False
        if args.once:
            return 0
        if not worked:
            time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())