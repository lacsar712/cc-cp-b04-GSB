# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

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

## 异常超温订阅铃

顶栏「🔔 订阅铃」进入落地页，包含**规则开关**、**命中列表**、**推送流水**三部分。

- **规则开关**（`alert_rule` 单行表，默认关闭）：仅记录员可切换；值班员只读，不能改规则。
- 规则开启后，后台工人每办结一笔**超温**单，就在**同一数据库事务**内写入命中列表（`alert_hits`）与推送流水（`alert_push_logs`），一次提交，绝不只落一边；任一步失败整体回滚。
- 关闭规则后立即停止新命中（worker 每次办结实时读规则，不缓存），已有命中行与流水全部保留。
- 命中列表由服务端 `alert_hits JOIN probe_readings(status='done', verdict='超温')` 对账输出，前端只展示接口数据，不做私下筛选。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/alert/rule` | 已登录 | 查询规则开关 |
| PUT | `/api/alert/rule` | 记录员 | `{"enabled": true/false}` 切换规则 |
| GET | `/api/alert/hits` | 已登录 | 命中列表（服务端与办结超温集合对账） |
| GET | `/api/alert/push-logs` | 已登录 | 推送流水 |

验收路径：记录员开规则 → 故意交一笔超温（如 15℃）并等 worker 办结 → 命中列表多一行、流水多一条；关闭规则 → 再交超温办结 → 命中列表不再增加。

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
