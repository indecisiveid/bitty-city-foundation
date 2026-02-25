import os
import json
import uuid
import random
import string
import asyncpg
from models import GroupResponse, CurrentBuild, PendingEvent

pool: asyncpg.Pool | None = None

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS groups (
    group_id     TEXT PRIMARY KEY,
    group_code   TEXT UNIQUE NOT NULL,
    group_name   TEXT NOT NULL,
    group_members TEXT[] NOT NULL DEFAULT '{}',
    daily_goal   TEXT NOT NULL,
    goal_reset_time TEXT NOT NULL DEFAULT '00:00',
    completions_today TEXT[] NOT NULL DEFAULT '{}',
    streak       INTEGER NOT NULL DEFAULT 0,
    current_build JSONB,
    city_map     JSONB NOT NULL,
    last_processed_date TEXT,
    pending_event JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

EMPTY_CITY = [[None]*5 for _ in range(4)]


async def init_pool():
    global pool
    pool = await asyncpg.create_pool(
        os.environ["DATABASE_URL"],
        min_size=1,
        max_size=5,
    )
    async with pool.acquire() as conn:
        await conn.execute(CREATE_TABLE)


async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None


def _generate_group_code() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def row_to_response(row: asyncpg.Record) -> GroupResponse:
    current_build = None
    if row["current_build"]:
        cb = json.loads(row["current_build"]) if isinstance(row["current_build"], str) else row["current_build"]
        current_build = CurrentBuild(**cb)

    pending_event = None
    if row["pending_event"]:
        pe = json.loads(row["pending_event"]) if isinstance(row["pending_event"], str) else row["pending_event"]
        pending_event = PendingEvent(**pe)

    city_map = json.loads(row["city_map"]) if isinstance(row["city_map"], str) else row["city_map"]

    return GroupResponse(
        group_id=row["group_id"],
        group_code=row["group_code"],
        group_name=row["group_name"],
        group_members=list(row["group_members"]),
        daily_goal=row["daily_goal"],
        goal_reset_time=row["goal_reset_time"],
        completions_today=list(row["completions_today"]),
        streak=row["streak"],
        current_build=current_build,
        city_map=city_map,
        last_processed_date=row["last_processed_date"],
        pending_event=pending_event,
        created_at=row["created_at"].isoformat(),
    )


async def create_group(group_name: str, member: str, daily_goal: str, goal_reset_time: str) -> GroupResponse:
    group_id = str(uuid.uuid4())
    group_code = _generate_group_code()
    city_map = json.dumps(EMPTY_CITY)

    async with pool.acquire() as conn:
        # Retry if code collision (unlikely with 6-char alphanumeric)
        for _ in range(5):
            try:
                row = await conn.fetchrow(
                    """INSERT INTO groups (group_id, group_code, group_name, group_members,
                       daily_goal, goal_reset_time, city_map)
                       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                       RETURNING *""",
                    group_id, group_code, group_name, [member],
                    daily_goal, goal_reset_time, city_map,
                )
                return row_to_response(row)
            except asyncpg.UniqueViolationError:
                group_code = _generate_group_code()
        raise RuntimeError("Failed to generate unique group code")


async def get_group_by_id(group_id: str) -> asyncpg.Record | None:
    async with pool.acquire() as conn:
        return await conn.fetchrow("SELECT * FROM groups WHERE group_id = $1", group_id)


async def get_group_by_code(group_code: str) -> asyncpg.Record | None:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM groups WHERE group_code = $1",
            group_code.upper(),
        )


async def update_group(group_id: str, **fields) -> asyncpg.Record:
    sets = []
    vals = []
    i = 1
    for key, val in fields.items():
        if key in ("city_map", "current_build", "pending_event"):
            sets.append(f"{key} = ${i}::jsonb")
            vals.append(json.dumps(val) if val is not None else None)
        else:
            sets.append(f"{key} = ${i}")
            vals.append(val)
        i += 1
    vals.append(group_id)
    sql = f"UPDATE groups SET {', '.join(sets)} WHERE group_id = ${i} RETURNING *"
    async with pool.acquire() as conn:
        return await conn.fetchrow(sql, *vals)


async def delete_group(group_id: str) -> bool:
    async with pool.acquire() as conn:
        result = await conn.execute("DELETE FROM groups WHERE group_id = $1", group_id)
        return result == "DELETE 1"
