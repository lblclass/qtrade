# 行情数据采集与快照

本文记录 qtrade 行情数据链路的调研结论、实现方式与运维方法。目标是最小闭环：
**采集 → 原始落地 → 标准化 → 质量校验 → 分区快照 → 研究/回测读取**。

## 1. 数据源调研（2026-11 实测）

| 数据源 | 日线 | 分钟线 | 证券主数据 | 交易日历 | 复权 | 需要 Token | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 东方财富 `push2his` | 全历史（600000.SH 6422 根，1999 起） | 1 分钟 240 根（仅当日）；5/15/30/60 分钟 1536/512/256/128 根（约 1 个月） | 是（5563 只 A 股） | 用上证指数日线推导 | 不复权/前复权/后复权 | 否 | **主数据源**，日线与当日 1 分钟首选 |
| BaoStock | 全历史 | 5/15/30/60 分钟自 2020-01-01 起（实测 600000.SH 79,584 根） | 是 | 是 | 不复权/前复权/后复权 | 否（匿名登录） | **分钟历史回补**首选，接口慢 |
| 新浪 `quotes.sina.cn` | 1023 根（约 4 年） | 5/15/30/60 分钟各 1023 根（约 21 个交易日） | 否 | 否 | 不复权 | 否 | 备用源，主源故障时降级 |
| 腾讯 `web.ifzq.gtimg.cn` | — | — | — | — | — | — | 本机 DNS 不可解析，未采用 |
| Tushare / Wind / Choice | 有 | 有 | 有 | 有 | 有 | 需要 | 未接入，需账号与授权 |
| QMT/miniQMT (xtquant) | 有 | 有 | 有 | 有 | 有 | 需券商终端 | 实盘阶段再接，属于下一阶段 |

关键结论：**免费源里没有“任意历史区间的 1 分钟线”**。1 分钟只能靠每个交易日收盘后采集一次并累积，
历史 5 分钟用 BaoStock 一次回补（2020 年起）。这也是 `--incremental` 的默认行为。

## 2. 代码结构

```text
python/src/qtrade_research/data/
  symbols.py            代码规范化（600000 / 600000.SH / SH600000 → 600000.SH）
  http.py               标准库 HTTP 客户端：重试、指数退避、限流
  sources/
    base.py             MarketDataSource 契约、Instrument、Capability
    eastmoney.py        东方财富适配器
    baostock.py         BaoStock 适配器（可选依赖）
    sina.py             新浪适配器（备用）
  quality.py            质量门禁：重复、OHLC 不变量、跳空、涨跌幅异常
  store.py              分区数据集、原始落地、manifest、catalog
  collector.py          采集编排：增量窗口、失败隔离、快照写入
  cli.py               `qtrade-data` 命令行
```

设计约束：

- 核心链路只依赖标准库；`pyarrow` 只影响快照格式（缺失时自动降级 CSV）。
- 适配器只负责“取数 + 转成 `Bar`”，不写磁盘、不判断业务规则。
- 采集器按标的分批写入，单只失败不会中断整批；失败原因写进 manifest。
- 成交量为**股**（东方财富接口返回“手”，适配器已 ×100 归一）。

## 3. 数据布局

```text
data/
  raw/<source>/<dataset>/<yyyymmdd>/<symbol>.json.gz   # 原始响应，便于复算
  dataset/bars_1d/symbol=600000.SH/year=2025/data.parquet
  dataset/bars_1m/5/symbol=600000.SH/year=2026/data.parquet
  instruments/<yyyymmdd>/instruments.csv               # 证券主数据
  _manifests/snap_20261106T124714_ab12cd.json          # 每次采集的 manifest
  _catalog.json                                        # 每个标的的行数与覆盖区间
```

- 分区键为 `(symbol, year)`，追加时按 `(symbol, ts)` 去重合并，重复执行幂等。
- 价格使用 `decimal128(18,4)`，金额 `decimal128(20,2)`，避免浮点误差。
- manifest 记录 snapshot_id、覆盖范围、分区校验和、质量报告与失败明细，可直接对应
  `dataset_snapshots` / `dataset_snapshot_items` / `data_quality_issues` 表。

## 4. 质量门禁

| 级别 | 规则 | 处理 |
| --- | --- | --- |
| blocker | `high < low`、`open/close` 越界、非正价格、负成交量/成交额 | 丢弃该 bar |
| info | 同一 `(symbol, ts)` 重复 | 保留最后一条 |
| warning | 日线交易日历缺口 | 记录缺口天数（不阻断） |
| warning | 日涨跌幅超过板块涨跌停的 1.5 倍 | 记录（复权/ST 场景可能误报） |
| warning | 分钟线时间戳不在 09:30-11:30 / 13:00-15:00 | 记录 |
| warning | 有成交量但成交额为 0 | 记录 |

板块涨跌停启发式：主板 10%、科创板/创业板 20%、北交所 30%、主板 ST 5%。

## 5. 常用命令

```bash
cd python && pip install -e ".[data]"          # Parquet 快照
pip install -e ".[data,baostock,postgres]"              # 追加 BaoStock 分钟历史

# 证券主数据
python -m qtrade_research.data.cli instruments --out data

# 日线：全市场或指定标的，默认增量
python -m qtrade_research.data.cli daily --universe all --start 2020-01-01 --out data
python -m qtrade_research.data.cli daily --symbols 600000.SH,000001.SZ --start 2020-01-01

# 5 分钟历史回补（BaoStock，2020 起）
python -m qtrade_research.data.cli minute --symbols 600000.SH --interval 5 --start 2020-01-01

# 1 分钟当日快照（东方财富），收盘后执行
python -m qtrade_research.data.cli minute --symbols 600000.SH --interval 1 --today

# 落库：把快照写入 PostgreSQL（live_* 快照，按主键增量覆盖）
python -m qtrade_research.data.cli load-postgres --dataset all --intervals 1,5 \
  --dsn postgresql://qtrade:qtrade@localhost:15432/qtrade

# 只加载最近窗口（夜间任务用，避免全量重放）
python -m qtrade_research.data.cli load-postgres --dataset all --since 2026-11-02

# 查看覆盖情况 / 复检质量
python -m qtrade_research.data.cli catalog
python -m qtrade_research.data.cli verify --dataset bars_1d

# 用真实快照跑回测：SnapshotDataPortal 读取分区数据集
python -m qtrade_research.cli backtest --snapshot ../data \
  --symbols 600000.SH,600519.SH,000001.SZ --start 2022-01-01
```

`--json` 输出机器可读结果，便于接入调度与监控。`--format csv` 可在没有 pyarrow 的环境使用。
`--full-refresh` 关闭增量、按请求区间重新拉取（写入仍会去重）。

## 6. 调度

仓库内的 `scripts/daily_update.ps1` 已注册为 Windows 计划任务 **qtrade daily update**，
每天 17:30 执行：刷新证券主数据 → 全市场日线增量 → 当日 1 分钟快照 → 增量落库。
日志写入 `logs/daily_update_YYYYMMDD.log`，失败时退出码为 1。

| 任务 | 时点 | 命令 |
| --- | --- | --- |
| 证券主数据 | 每周一 08:30 | `qtrade-data instruments` |
| 日线增量 | 交易日 17:30 | `qtrade-data daily --universe all --incremental` |
| 1 分钟当日快照 | 交易日 15:10 / 16:00 | `qtrade-data minute --symbols ... --interval 1 --today` |
| 5 分钟补数 | 每周六 | `qtrade-data minute --symbols ... --interval 5 --start ...` |

Windows：

```powershell
schtasks /Create /SC DAILY /ST 17:30 /TN qtrade-daily ^
  /TR "cmd /c cd /d D:\code\ai\qtrade\python && .venv\Scripts\python.exe -m qtrade_research.data.cli daily --universe all --out data"
```

Linux：

```cron
30 17 * * 1-5 cd /opt/qtrade/python && .venv/bin/python -m qtrade_research.data.cli daily --universe all --out data >> /var/log/qtrade-daily.log 2>&1
```

## 7. 已知限制与下一步

1. **1 分钟历史**只能逐日累积；首次部署前无历史，需要至少一个交易日的运行。
2. 复权来自数据源（`qfq/hfq`），尚未落地 `corporate_action` 与 `adj_factor`；日线跨除权日
   的涨跌停判断会有误报，属已知噪音。
3. PostgreSQL 写入使用固定 `live_*` 快照（`live_bars_1d`、`live_bars_1m_1`、`live_bars_1m_5`），
   历史不可变版本留在 Parquet 快照里；Go 侧 repository 仍读内存，尚未切到这些表。
4. 计划任务以当前 Windows 用户身份运行，需要该用户登录且 Docker Desktop 已启动；
   服务器部署时可以改用 `schtasks /RU SYSTEM` 或 Linux `cron`。
5. 北交所标的在 BaoStock 支持有限，分钟数据以东方财富当日快照为主。
6. 未接入财务数据、指数成分、停牌/ST 标记；`0002_market_data.sql` 中对应表保持空置。
7. 采集是进程式的，没有常驻调度器；用系统计划任务驱动即可，失败会体现在 manifest、日志与退出码。