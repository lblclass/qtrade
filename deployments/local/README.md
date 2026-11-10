# 本地 Docker 部署

启动整套服务（PostgreSQL、Redis、NATS、Go API、Web 控制台）：

```bash
docker compose -f deployments/local/docker-compose.yml up -d --build
```

访问地址：

- Web 控制台：http://localhost:8090
- Go API：http://localhost:8080 （`/healthz`、`/api/v1/...`）
- PostgreSQL：localhost:15432，用户/密码/库均为 `qtrade`
- Redis：localhost:16379
- NATS：localhost:14222，监控 18222

停止并保留数据：

```bash
docker compose -f deployments/local/docker-compose.yml down
```

停止并删除数据卷：

```bash
docker compose -f deployments/local/docker-compose.yml down -v
```