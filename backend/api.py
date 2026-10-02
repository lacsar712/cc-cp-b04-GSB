import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import jwt
from aiohttp import web
from passlib.context import CryptContext

from db import create_pool, ensure_schema_async, seed_if_empty
from rules import judge_temp

SECRET = os.environ.get("JWT_SECRET", "coldchain-probe-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "logger": {"role": "writer", "password_hash": pwd.hash("log123456")},
    "watcher": {"role": "reader", "password_hash": pwd.hash("watch123456")},
}


def _auth_header(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_user(request: web.Request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        raise web.HTTPUnauthorized(text=json.dumps({"detail": "未登录"}, ensure_ascii=False), content_type="application/json")
    return user


def require_writer(request: web.Request) -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "仅记录员可执行此操作"}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "coldchain-probe-desk"})


async def login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        raise web.HTTPUnauthorized(
            text=json.dumps({"detail": "用户名或密码错误"}, ensure_ascii=False),
            content_type="application/json",
        )
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return web.json_response(
        {"access_token": token, "username": username, "role": user["role"]}
    )


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        ORDER BY id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(out)


async def create_reading(request: web.Request) -> web.Response:
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头编号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        temp_c = float(body.get("temp_c"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "温度必须是数字"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc

    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        """
        INSERT INTO probe_readings (probe_id, temp_c, status, created_by, created_at)
        VALUES ($1, $2, 'pending', $3, now())
        RETURNING id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        """,
        probe_id,
        temp_c,
        user["username"],
    )
    return web.json_response(
        {
            "id": row["id"],
            "probe_id": row["probe_id"],
            "temp_c": row["temp_c"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


# ---------------------------------------------------------------------------
# 异常超温订阅铃
# ---------------------------------------------------------------------------


async def get_subscription(request: web.Request) -> web.Response:
    """规则开关状态：记录员与值班员登录后均可读。"""
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        "SELECT enabled, updated_by, updated_at FROM subscription_settings WHERE id = 1"
    )
    return web.json_response(
        {
            "enabled": bool(row["enabled"]),
            "updated_by": row["updated_by"],
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    )


async def set_subscription(request: web.Request) -> web.Response:
    """切换规则开关：仅记录员(writer)可改，值班员(reader)只读。"""
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "enabled 必须是布尔值"}, ensure_ascii=False),
            content_type="application/json",
        )
    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        """
        UPDATE subscription_settings
        SET enabled = $1, updated_by = $2, updated_at = now()
        WHERE id = 1
        RETURNING enabled, updated_by, updated_at
        """,
        enabled,
        user["username"],
    )
    return web.json_response(
        {
            "enabled": bool(row["enabled"]),
            "updated_by": row["updated_by"],
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    )


async def list_alert_hits(request: web.Request) -> web.Response:
    """命中列表：直接返回服务端 alert_hits 表，前端不做任何私下筛选。"""
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT h.id, h.reading_id, h.probe_id, h.temp_c, h.verdict, h.hit_at,
               p.id AS push_id, p.channel, p.result, p.pushed_at
        FROM alert_hits h
        LEFT JOIN push_logs p ON p.hit_id = h.id
        ORDER BY h.id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "reading_id": r["reading_id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "hit_at": r["hit_at"].isoformat() if r["hit_at"] else None,
                "push": (
                    {
                        "id": r["push_id"],
                        "channel": r["channel"],
                        "result": r["result"],
                        "pushed_at": r["pushed_at"].isoformat() if r["pushed_at"] else None,
                    }
                    if r["push_id"] is not None
                    else None
                ),
            }
        )
    return web.json_response(out)


async def list_push_logs(request: web.Request) -> web.Response:
    """推送流水：与命中一一对应，独立接口供落地页展示。"""
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT p.id, p.hit_id, p.reading_id, p.channel, p.result, p.pushed_at,
               h.probe_id, h.temp_c
        FROM push_logs p
        JOIN alert_hits h ON h.id = p.hit_id
        ORDER BY p.id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "hit_id": r["hit_id"],
                "reading_id": r["reading_id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "channel": r["channel"],
                "result": r["result"],
                "pushed_at": r["pushed_at"].isoformat() if r["pushed_at"] else None,
            }
        )
    return web.json_response(out)


async def subscription_reconcile(request: web.Request) -> web.Response:
    """对账：以“办结超温集合”为基准，核对命中与流水是否一致。

    规则开启期间办结的超温单应逐条在命中表且各带一条流水；命中表是服务端
    写入的，前端只能读取此结果，不允许自行从读数列表筛选。
    """
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    stats = await pool.fetchrow(
        """
        SELECT
            (SELECT COUNT(*) FROM probe_readings
             WHERE status = 'done' AND verdict = '超温') AS done_overtemp,
            (SELECT COUNT(*) FROM alert_hits) AS hits,
            (SELECT COUNT(*) FROM push_logs) AS pushes,
            (SELECT COUNT(*) FROM alert_hits h
             WHERE NOT EXISTS (SELECT 1 FROM push_logs p WHERE p.hit_id = h.id))
                AS hits_without_push
        """
    )
    # 命中却没有流水的明细（正常情况下恒为空，原子写入保证）
    orphan_rows = await pool.fetch(
        """
        SELECT h.id, h.reading_id, h.probe_id
        FROM alert_hits h
        WHERE NOT EXISTS (SELECT 1 FROM push_logs p WHERE p.hit_id = h.id)
        ORDER BY h.id
        """
    )
    orphans = [
        {"id": r["id"], "reading_id": r["reading_id"], "probe_id": r["probe_id"]}
        for r in orphan_rows
    ]
    consistent = stats["hits"] == stats["pushes"] and stats["hits_without_push"] == 0
    return web.json_response(
        {
            "done_overtemp_count": stats["done_overtemp"],
            "hit_count": stats["hits"],
            "push_count": stats["pushes"],
            "hits_without_push_count": stats["hits_without_push"],
            "hits_without_push": orphans,
            "consistent": consistent,
        }
    )


async def on_startup(app: web.Application) -> None:
    pool = await create_pool()
    app["pool"] = pool
    await ensure_schema_async(pool)
    await seed_if_empty(pool)


async def on_cleanup(app: web.Application) -> None:
    pool: asyncpg.Pool = app.get("pool")
    if pool:
        await pool.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/auth/login", login)
    app.router.add_get("/api/readings", list_readings)
    app.router.add_post("/api/readings", create_reading)
    # 异常超温订阅铃
    app.router.add_get("/api/subscription", get_subscription)
    app.router.add_put("/api/subscription", set_subscription)
    app.router.add_get("/api/alert-hits", list_alert_hits)
    app.router.add_get("/api/push-logs", list_push_logs)
    app.router.add_get("/api/subscription/reconcile", subscription_reconcile)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
