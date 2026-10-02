"""后台工人：用 SKIP LOCKED 认领 pending 读数并写入合格/超温结论。

超温读数办结时，若订阅铃规则处于开启状态，必须在**同一事务**内写入
命中列表（alert_hits）与推送流水（push_logs），三者要么全部落库要么全部
回滚，杜绝只落一边。规则关闭时办结的超温单不产生新命中，历史命中保留。
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


def finish(conn, reading_id: int, probe_id: str, temp_c: float) -> None:
    verdict, reason = judge_temp(temp_c)
    with conn.transaction():
        # 1) 办结读数
        conn.execute(
            """
            UPDATE probe_readings
            SET status = 'done', verdict = %s, reason = %s, processed_at = now()
            WHERE id = %s
            """,
            (verdict, reason, reading_id),
        )

        if verdict == "超温":
            # 2) 同事务读规则开关（READ COMMITTED 下读到最新已提交值，
            #    规则一旦关闭提交，后续办结立刻看不到命中）
            enabled = conn.execute(
                "SELECT enabled FROM subscription_settings WHERE id = 1"
            ).fetchone()["enabled"]
            if enabled:
                # 3) 写命中；reading_id 唯一约束兜底，异常会整体回滚
                hit_id = conn.execute(
                    """
                    INSERT INTO alert_hits
                        (reading_id, probe_id, temp_c, verdict, hit_at)
                    VALUES (%s, %s, %s, %s, now())
                    RETURNING id
                    """,
                    (reading_id, probe_id, temp_c, verdict),
                ).fetchone()["id"]
                # 4) 同一事务写推送流水；任一步失败，办结/命中一并回滚
                conn.execute(
                    """
                    INSERT INTO push_logs
                        (hit_id, reading_id, channel, result, pushed_at)
                    VALUES (%s, %s, '铃', '已推送', now())
                    """,
                    (hit_id, reading_id),
                )


def run_once(conn) -> bool:
    row = claim_one(conn)
    if not row:
        return False
    try:
        finish(conn, row["id"], row["probe_id"], float(row["temp_c"]))
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
