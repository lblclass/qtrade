# qtrade

面向 A 股中低频策略的量化交易系统骨架。

当前阶段的目标不是一次性做完整平台，而是先建立一个可运行、可测试、可扩展的垂直切片：

- **Go 控制面**：策略、版本、回测任务、模拟/实盘部署、订单风控、审计、网关健康检查。
- **Python 研究侧**：统一策略 API、事件驱动回测内核、A 股 T+1/涨跌停/整手/费用规则、示例策略。
- **基础设施**：PostgreSQL schema、Redis、NATS、Docker Compose、Proto 契约。

详细方案见 [产品技术实现方案](docs/quant-trading-platform-design.md)。

## 架构

```text
Go API / 控制面 / OMS / 风控 / 对账 / BrokerGateway
        │  gRPC / Protobuf / NATS
Python 研究、因子、回测 Worker、策略运行时
        │
PostgreSQL + Parquet/S3 + Redis + NATS
```

原则：**Go 负责交易正确性，Python 负责策略与研究表达**。所有订单必须经过 Go 侧风险网关；Python 策略不能直接对接券商。

## 目录

```text
cmd/qtrade-api/          Go API 入口
internal/api/            HTTP 路由、中间件、处理器
internal/domain/         领域模型与部署状态机
internal/store/          存储接口与内存实现
internal/risk/           事前风控与费用估算
internal/broker/         BrokerGateway 抽象与 mock
internal/config/         环境变量配置
migrations/              PostgreSQL 交易与市场数据 schema
api/proto/               Proto 契约
buf.yaml / buf.gen.yaml  代码生成配置
python/src/qtrade_research/
  domain.py              行情、订单、成交、持仓模型
  strategy.py            统一策略接口
  backtest.py            事件驱动回测内核
  data/                  point-in-time 数据访问抽象
  strategies/            示例策略
  cli.py                 可运行的示例回测
python/tests/            Python 回测测试
deployments/python/      Python Worker 镜像
web/                     React + TypeScript + Vite 控制台脚手架
```

## 快速开始

### 运行测试

```bash
make test
```

当前包含 Go API/风控测试和 Python 回测测试，全部不依赖外部服务。

### 启动 Go API

```bash
make api
# 另开终端
curl -sS http://localhost:8080/healthz
curl -sS http://localhost:8080/api/v1/meta
```

### 运行 Python 示例回测

```bash
make demo
```

输出包含总收益、年化、最大回撤、夏普、换手、成交笔数和期末权益。

### 启动基础设施

```bash
docker compose up --build
```

启动 PostgreSQL、Redis、NATS 和 Go API。数据库首次启动会执行 `migrations/0001_init.sql`。

### 启动 Web 控制台

```bash
cd web
npm.cmd install
npm.cmd run dev        # 开发模式，http://localhost:5173
npm.cmd run build      # 产出 web/dist，由 nginx 镜像托管
```

开发模式会把 `/api` 和 `/healthz` 代理到 `http://localhost:8080`；容器内直接访问 `http://localhost:8090`。

控制台按量化交易全生命周期组织，共 8 个页面：

| 路由 | 页面 | 覆盖的生命周期环节 |
| --- | --- | --- |
| `#/overview` | 概览 | 全链路看板：数据新鲜度 → 策略 → 回测 → 部署 → 风控 → 审计 |
| `#/data` | 数据中心 | 行情快照、实时报价板、数据质量门禁、证券主数据检索 |
| `#/strategies` | 策略库 | 策略 CRUD、版本发布、状态机流转（draft→backtesting→review→paper→canary→live→retired） |
| `#/backtests` | 回测 | 提交回测任务、净值/基准曲线、回撤、绩效指标、取消任务 |
| `#/deployments` | 部署 | 模拟盘/实盘部署，start/pause/resume/stop/kill 状态机 |
| `#/trading` | 交易台 | 下单（限价/市价）、风控校验反馈、订单撤单、持仓盈亏 |
| `#/risk` | 风控 | 风控规则链、拒单记录、审计提示 |
| `#/monitoring` | 监控 | 健康检查、网关状态、数据管道、审计事件查询 |

控制台读取 `QTRADE_DATA_ROOT`（默认 `data`）下的 `_ui_summary.json`、`_quotes.json` 和
`instruments/<date>/instruments.json`；`QTRADE_SEED_DEMO=true` 时会灌入一套完整演示生命周期数据
（6 个策略 / 5 个回测 / 5 个部署 / 账户与持仓）。演示数据在内存中，重启即重置。

### 回测 Worker 与控制台操作

`deployments/python/Dockerfile` 会被 Compose 复用为常驻 Worker（`qtrade-worker`）：每 5 秒轮询
`GET /api/v1/backtests`，认领 queued 任务后读取 `_series.json` 的真实日线，运行
`BacktestEngine`，再通过 `POST /api/v1/backtests/{id}/result` 回写净值曲线、绩效指标和运行日志。

控制台支持的操作链路：

- 策略详情 → **编辑**（名称/描述）、**模拟运行**（默认最近 12 个月、流动性前 60 只）、**上线模拟盘**（一步创建并启动部署）
- 回测详情 → 任务在 queued/running 时每 3 秒自动刷新，完成后展示真实净值与基准曲线、回撤和 Worker 日志
- 驾驶舱 → **账户每日盈亏**（按当前持仓与真实收盘价回溯）
- 监控与审计 → 全局审计事件与数据管道状态
- 右上角可切换 **浅色/深色** 主题，选择保存在 localStorage

新增接口：

```text
PATCH /api/v1/strategies/{id}
POST  /api/v1/strategies/{id}/simulate
POST  /api/v1/strategies/{id}/deploy
POST  /api/v1/backtests/{id}/claim
POST  /api/v1/backtests/{id}/result
GET   /api/v1/logs?resource_type=&resource_id=&limit=
GET   /api/v1/accounts/{id}/equity?days=60
```

## API 垂直切片

以下流程演示“创建策略 → 发布版本 → 提交回测 → 创建模拟盘 → 启动 → 提交订单”：

```bash
# 1. 创建策略
curl -sS -X POST http://localhost:8080/api/v1/strategies \
  -H 'Content-Type: application/json' \
  -d '{"name":"dual momentum","description":"demo"}'

# 2. 发布版本（把 stg_xxx 替换为上一步返回的 id）
curl -sS -X POST http://localhost:8080/api/v1/strategies/stg_xxx/versions \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0.0","artifact_digest":"sha256:abc","python_version":"3.13"}'

# 3. 创建模拟盘（替换 strategy_id）
curl -sS -X POST http://localhost:8080/api/v1/live-deployments \
  -H 'Content-Type: application/json' \
  -d '{"strategy_id":"stg_xxx","strategy_version":"1.0.0","mode":"paper","account_id":"acc_demo"}'

# 4. 启动（替换 dep_xxx）
curl -sS -X POST http://localhost:8080/api/v1/live-deployments/dep_xxx/start

# 5. 提交订单（替换 dep_xxx）
curl -sS -X POST http://localhost:8080/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{"client_order_id":"coid-1","deployment_id":"dep_xxx","account_id":"acc_demo","symbol":"600000.SH","side":"buy","order_type":"market","quantity":100,"price_cents":1000,"last_price_cents":1000}'
```

金额统一使用整数分（cents），避免浮点误差。账户 `acc_demo` 默认有 100 万元虚拟资金。

## 当前边界

- Go API 当前使用内存存储，重启后数据丢失；PostgreSQL schema 已就绪，下一步实现 repository。
- Go 侧订单目前只做风控受理，不连接真实券商；`BrokerGateway` 和 mock 已预留。
- Python 回测是确定性 bar 级内核，已覆盖 T+1、涨跌停、整手、佣金/印花税/过户费和滑点；尚未接入真实数据快照。
- 数据面已实现东方财富/新浪/BaoStock 采集、Parquet 分区快照与 PostgreSQL 落库；tick 级行情、财务与公司行为仍待接入。
- Proto 文件已定义订单、成交、持仓、策略和回测契约；若本地未配置 `protoc`/`buf`，可先使用 REST API。
- QMT/miniQMT sidecar 尚未实现，属于下一阶段实盘接入工作。
- Web 控制台已覆盖全生命周期页面，但仍是 MVP：没有登录/RBAC、审批流，前端构建尚未纳入 CI。

## 下一步

1. 用 PostgreSQL 实现 `store.Store`，替换内存存储。
2. 增加数据快照与 bar 查询 API，打通 Python 回测数据源。
3. 增加回测 Worker：Go 投递任务，Python 消费并回写指标。
4. 实现 QMT sidecar 与订单/成交/持仓对账。
5. 控制台补 WebSocket 实时事件流、登录/RBAC 与发布审批流。

## 行情数据采集

`python/src/qtrade_research/data/` 提供可运行的采集链路：**采集 → 原始落地 → 标准化 → 质量校验 → 分区快照**。
详见 [行情数据采集与快照](docs/market-data-pipeline.md)。

数据源实测结论（2026-11）：东方财富免 Token，日线全历史、1 分钟仅当日、5 分钟约 1 个月；
BaoStock 可回补 2020 年以来的 5/15/30/60 分钟线；新浪作为备用源。

```bash
cd python
pip install -e ".[data,baostock,postgres]"

# 证券主数据 + 日线（默认增量）
python -m qtrade_research.data.cli instruments --out data
python -m qtrade_research.data.cli daily --universe all --start 2020-01-01 --out data

# 分钟线：历史用 BaoStock，当日 1 分钟用东方财富
python -m qtrade_research.data.cli minute --symbols 600000.SH --interval 5 --start 2020-01-01
python -m qtrade_research.data.cli minute --symbols 600000.SH --interval 1 --today

# 落库到 PostgreSQL（live_* 快照，增量覆盖）
python -m qtrade_research.data.cli load-postgres --dataset all --intervals 1,5

# 导出控制台看板数据（_ui_summary.json / _quotes.json）
python -m qtrade_research.data.cli export-ui

# 覆盖情况与质量复检
python -m qtrade_research.data.cli catalog
python -m qtrade_research.data.cli verify --dataset bars_1d

# 用真实快照跑回测（data/ 为快照根目录）
python -m qtrade_research.cli backtest --snapshot ../data \
  --symbols 600000.SH,600519.SH,000001.SZ --start 2022-01-01
```

快照默认写入 `data/`（已加入 `.gitignore`），按 `symbol/year` 分区、`(symbol, ts)` 去重，
Parquet 使用 `decimal128` 保存价格；没有 pyarrow 时自动降级为 CSV。

`scripts/daily_update.ps1` 已注册为 Windows 计划任务 **qtrade daily update**（每天 17:30）：
刷新证券主数据 → 全市场日线增量 → 当日 1 分钟快照 → 增量写入 PostgreSQL → 导出控制台数据（`export-ui`），日志在 `logs/`。
