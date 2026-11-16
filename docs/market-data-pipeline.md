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
## 8. 全历史回补与双数据集（2026-11-13）

### 8.1 数据到底从哪来

日线**没有**经过 AKShare / Tushare / Baostock 的封装，而是直接调用公开行情接口：

| 用途 | 来源 | 说明 |
| --- | --- | --- |
| 日线（日常增量） | 东方财富 `push2his` | 全历史，单次最多 10 万根；高频请求会触发连接重置 |
| 日线（全历史回补） | 雪球 `stock.xueqiu.com/v5/stock/chart/kline.json` | 一次返回最多 1 万根，覆盖全部 A 股上市以来；需要匿名 Cookie |
| 5/15/30/60 分钟历史 | BaoStock | 免费、单连接，2020 年起；每标的 10~40 秒，只适合回补 |
| 1 分钟当日快照 | 东方财富 | 仅当日 240 根，逐日累积 |
| 证券主数据 | 东方财富 `clist` | 5,900+ 只在市标的 |

AKShare 本身就是这些接口的封装，直接调用少一层依赖、也方便控制限流；Tushare 需要积分/Token，
本仓库尚未接入。

### 8.2 为什么原来只有近 5 年

`qtrade-data daily --start` 的默认值是 `2020-01-01`，而且增量模式只用 catalog 里的
`end` 向后追加，**从不向左补**。数据源本身有全历史，是采集窗口把数据截断了。

现在：

* `--start` 默认改为 `1990-01-01`；
* 新增 `--backfill`：当 catalog 里的覆盖起点晚于请求起点时，从请求起点重新拉一遍，
  按 `(symbol, year)` 分区合并，已有年份覆盖、缺失年份补齐，可反复执行；
* 新增 `--dataset`：把同一份采集写到不同的湖内数据集。

### 8.3 两个日线数据集

| 数据集 | 复权 | 用途 |
| --- | --- | --- |
| `bars_1d` | 不复权（`none`） | 控制台报价、涨跌停、PostgreSQL `bar_1d` |
| `bars_1d_hfq` | 后复权（`hfq`） | 回测、因子、跨除权日收益 |

**为什么不用前复权**：前复权对高分红老股会算出负价。实测 `600000.SH` 的 6,427 根前复权日线里
有 1,914 根（1999-11 ~ 2012-12）价格 ≤ 0，质量门禁会直接丢弃，等于又丢回十年历史。
后复权价格恒为正、跨除权连续，是做长周期回测的正确口径；不复权则用于展示真实成交价。

回测时显式指定数据集：

```bash
PYTHONPATH=python/src python -m qtrade_research.cli backtest \
  --snapshot data --dataset bars_1d_hfq --symbols 600000.SH,000001.SZ \
  --start 2005-01-01
```

### 8.4 全历史回补命令

```bash
# 不复权全历史（展示 + 落库）
PYTHONPATH=python/src python -m qtrade_research.data.cli daily \
  --source xueqiu --dataset bars_1d --adjust none \
  --universe-file logs/universe.txt --start 1990-01-01 --backfill \
  --workers 6 --rate 0.05 --out data

# 后复权全历史（回测）
PYTHONPATH=python/src python -m qtrade_research.data.cli daily \
  --source xueqiu --dataset bars_1d_hfq --adjust hfq \
  --universe-file logs/universe.txt --start 1990-01-01 --backfill \
  --workers 6 --rate 0.05 --out data
```

`--backfill` 可以重复执行：已经覆盖到的年份不会重复下载（命中起点后直接跳过）。

### 8.5 本次回补结果

* 日线：18,189,321 根，5,928 只标的，覆盖 **1990-12-19 ~ 2026-11-13**；
* PostgreSQL `bar_1d`：18,189,346 行（不复权，按主键覆盖旧数据）；
* 失败标的：0（首轮 798 只因单根脏数据整只失败，已改为跳过脏行并重跑）。

### 8.6 已知限制

1. 证券主数据只有**在市**标的（5,928 只），退市股不在其中；做长周期回测仍有生存者偏差，
   需要补退市清单后单独回补。
2. 复权因子尚未落到 `adj_factor` / `corporate_action`，跨除权日的涨跌停判断仍有噪音。
3. 雪球是公开接口，没有商用授权；正式生产建议换成持牌数据源（Tushare Pro / Wind / 券商行情）。
4. 夜间任务现在会同时维护 `bars_1d`（不复权）和 `bars_1d_hfq`（后复权）两份增量。
### 8.7 控制台行情视图

`export-ui` 除了 `_series.json`（回测/基准用的 277 只活跃标的），还会写
`ui/series/<symbol>.json`：每只标的一份最近 250 个交易日的 OHLCV，5,852 个文件、单份约 13 KB。
这样控制台可以按需读取任意一只票，而不必把整个 universe 塞进一个 JSON。

对应接口：

```
GET /api/v1/market/series/600519.SH?days=250
```

返回 `{symbol,name,days,dates[],open[],high[],low[],close[],volume[],limit_up[],limit_down[]}`，
价格单位是分。交易台顶部据此渲染日 K、MA5/MA20 和成交量，支持 60/120/250 日切换；
持仓的现价、市值、浮动盈亏也改用实时 `_quotes.json` 报价，不再显示演示数据里的静态价格。