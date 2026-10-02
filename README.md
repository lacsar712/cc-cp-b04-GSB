# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

## 异常超温订阅铃

顶栏 **🔔 订阅铃** 进入订阅铃落地页，含规则开关、命中列表、推送流水与服务端对账：

- 记录员打开规则后，服务端（worker）把此后**新办结的每笔超温单**写入命中列表 `alert_hits`，并在**同一数据库事务**内记一条推送流水 `push_logs`；三者（办结/命中/流水）原子提交，任一步失败整体回滚重试，绝不只落一边。
- 关闭规则后立刻停止产生新命中，已有命中行与流水永久保留；规则关闭前办结的历史超温单不回溯。
- 命中列表是服务端表，落地页只读取 `/api/alert-hits` 与 `/api/push-logs` 的返回，**不允许前端从读数列表私下筛选**。
- `/api/subscription/reconcile` 以「办结超温集合」为基准对账：命中数须等于流水数、不得存在无流水的命中。
- 值班员对命中、流水、开关状态均为只读；修改开关返回 403。


## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python aiohttp + asyncpg |
| 工人 | `worker.py`（psycopg，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Preact + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3197 |
| 接口 | http://localhost:8197 |
| PostgreSQL | localhost:54397（库名 `coldchain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| logger | log123456 | 记录员，可提交读数 |
| watcher | watch123456 | 值班员，只读列表 |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
