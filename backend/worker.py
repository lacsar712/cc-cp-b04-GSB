"""后台工人：用 SKIP LOCKED 认领 pending 读数并写入合格/超温结论。

办结时若订阅铃规则处于开启状态且结论为超温，则在**同一事务**内写入
命中列表（alert_hits）与推送流水（alert_push_logs），三者要么全部提交、
要么全部回滚，杜绝只落一边。
"""

import os
import time

from db import connect_sync, ensure_schema_sync, seed_if_empty_sync
from rules import judge_temp

POLL_SECONDS = float(os.environ.get("WORKER_POLL_SECONDS", "1.0"))


def claim_one(conn):
    with conn.transaction():
        row = conn.execute(
            """
            SELECT id, probe_id, temp_c
            FROM probe_readings
            WHERE status = 'pending'
            ORDER BY id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE probe_readings SET status = 'processing' WHERE id = %s",
            (row["id"],),
        )
        return row


def finish(conn, reading_id: int, temp_c: float) -> None:
    verdict, reason = judge_temp(temp_c)
    # 办结、命中、流水共用一个事务：原子提交，失败整体回滚。
    with conn.transaction():
        conn.execute(
            """
            UPDATE probe_readings
            SET status = 'done', verdict = %s, reason = %s, processed_at = now()
            WHERE id = %s
            """,
            (verdict, reason, reading_id),
        )
        # 每次办结都读取规则当前状态，不做缓存：关规则后立即停止新命中。
        enabled = conn.execute(
            "SELECT enabled FROM alert_rule WHERE id = 1"
        ).fetchone()["enabled"]
        if enabled and verdict == "超温":
            hit = conn.execute(
                """
                INSERT INTO alert_hits (reading_id, probe_id, temp_c)
                SELECT id, probe_id, temp_c FROM probe_readings WHERE id = %s
                RETURNING id
                """,
                (reading_id,),
            ).fetchone()
            conn.execute(
                """
                INSERT INTO alert_push_logs (hit_id, reading_id, channel, status)
                VALUES (%s, %s, '订阅铃', 'pushed')
                """,
                (hit["id"], reading_id),
            )
            print(
                f"订阅铃命中：reading {reading_id} 超温 {temp_c}℃，"
                f"hit {hit['id']} 已推送",
                flush=True,
            )


def run_once(conn) -> bool:
    row = claim_one(conn)
    if not row:
        return False
    try:
        finish(conn, row["id"], float(row["temp_c"]))
    except Exception:
        conn.execute(
            "UPDATE probe_readings SET status = 'pending' WHERE id = %s",
            (row["id"],),
        )
        conn.commit()
        raise
    return True


def main() -> None:
    with connect_sync() as conn:
        ensure_schema_sync(conn)
        seed_if_empty_sync(conn)
        conn.commit()

    while True:
        try:
            with connect_sync() as conn:
                processed = run_once(conn)
        except Exception as exc:
            print(f"worker error: {exc}", flush=True)
            processed = False
        if not processed:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
