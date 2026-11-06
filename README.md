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
npm install
npm run dev
```

默认访问 `http://localhost:5173`，Vite 会把 `/api` 和 `/healthz` 代理到 `http://localhost:8080`。

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
- 数据面已定义 PostgreSQL 表结构和 `InMemoryDataPortal`，真实采集器与 Parquet 快照尚未实现。
- Proto 文件已定义订单、成交、持仓、策略和回测契约；若本地未配置 `protoc`/`buf`，可先使用 REST API。
- QMT/miniQMT sidecar 尚未实现，属于下一阶段实盘接入工作。
- Web 控制台是首版脚手架，尚未在 CI 中执行 `npm install` 和前端构建。

## 下一步

1. 用 PostgreSQL 实现 `store.Store`，替换内存存储。
2. 增加数据快照与 bar 查询 API，打通 Python 回测数据源。
3. 增加回测 Worker：Go 投递任务，Python 消费并回写指标。
4. 实现 QMT sidecar 与订单/成交/持仓对账。
5. 增加前端控制台和 WebSocket 事件流。
