import json
import random
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import database as db
from models import CreateGroup, JoinGroup, CompleteGoal, SelectBuild, FillCity, GroupResponse
from game_logic import (
    needs_day_processing, get_processing_date, process_end_of_day, BUILDING_DAYS,
    _find_occupied_tiles, _find_empty_tiles,
)

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    yield
    await db.close_pool()


app = FastAPI(title="BittyCIty API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Helpers ---

async def maybe_process_day(row) -> GroupResponse:
    """Run lazy end-of-day processing if needed, then return response."""
    if needs_day_processing(row["goal_reset_time"], row["last_processed_date"]):
        current_build = row["current_build"]
        if isinstance(current_build, str):
            current_build = json.loads(current_build)

        city_map = row["city_map"]
        if isinstance(city_map, str):
            city_map = json.loads(city_map)

        updates = process_end_of_day(
            group_members=list(row["group_members"]),
            completions_today=list(row["completions_today"]),
            current_build=current_build,
            city_map=city_map,
            streak=row["streak"],
        )
        updates["last_processed_date"] = get_processing_date(row["goal_reset_time"])

        row = await db.update_group(row["group_id"], **updates)

    return db.row_to_response(row)


# --- Endpoints ---

@app.post("/groups", response_model=GroupResponse, status_code=201)
async def create_group(body: CreateGroup):
    return await db.create_group(
        group_name=body.group_name,
        member=body.member,
        daily_goal=body.daily_goal,
        goal_reset_time=body.goal_reset_time,
    )


@app.get("/groups/{group_id}", response_model=GroupResponse)
async def get_group(group_id: str):
    row = await db.get_group_by_id(group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Group not found")
    return await maybe_process_day(row)


@app.post("/groups/join", response_model=GroupResponse)
async def join_group(body: JoinGroup):
    row = await db.get_group_by_code(body.group_code)
    if not row:
        raise HTTPException(status_code=404, detail="Invalid group code")

    members = list(row["group_members"])

    # Idempotent — already a member
    if body.member in members:
        return await maybe_process_day(row)

    if len(members) >= 4:
        raise HTTPException(status_code=400, detail="Group is full (max 4 members)")

    members.append(body.member)
    row = await db.update_group(row["group_id"], group_members=members)
    return await maybe_process_day(row)


@app.post("/groups/{group_id}/complete", response_model=GroupResponse)
async def complete_goal(group_id: str, body: CompleteGoal):
    row = await db.get_group_by_id(group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Group not found")

    members = list(row["group_members"])
    if body.member not in members:
        raise HTTPException(status_code=400, detail="Not a member of this group")

    # Run day processing first
    if needs_day_processing(row["goal_reset_time"], row["last_processed_date"]):
        resp = await maybe_process_day(row)
        # Re-fetch after processing
        row = await db.get_group_by_id(group_id)

    completions = list(row["completions_today"])

    # Idempotent
    if body.member in completions:
        return db.row_to_response(row)

    completions.append(body.member)
    row = await db.update_group(group_id, completions_today=completions)
    return db.row_to_response(row)


@app.post("/groups/{group_id}/select_build", response_model=GroupResponse)
async def select_build(group_id: str, body: SelectBuild):
    if body.type not in BUILDING_DAYS:
        raise HTTPException(status_code=400, detail=f"Invalid building type. Must be one of: {list(BUILDING_DAYS.keys())}")

    row = await db.get_group_by_id(group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Group not found")

    # Run day processing first
    if needs_day_processing(row["goal_reset_time"], row["last_processed_date"]):
        await maybe_process_day(row)
        row = await db.get_group_by_id(group_id)

    current_build = row["current_build"]
    if isinstance(current_build, str):
        current_build = json.loads(current_build)

    if current_build is not None:
        raise HTTPException(status_code=400, detail="A build is already in progress")

    city_map = row["city_map"]
    if isinstance(city_map, str):
        city_map = json.loads(city_map)

    # Check if city is full
    has_empty = any(
        cell is None or cell == "rubble"
        for r in city_map
        for cell in r
    )
    if not has_empty:
        raise HTTPException(status_code=400, detail="City is full — no empty tiles")

    members = list(row["group_members"])
    if body.member not in members:
        raise HTTPException(status_code=400, detail="Not a member of this group")

    new_build = {
        "type": body.type,
        "days_required": BUILDING_DAYS[body.type],
        "days_completed": 0,
    }
    row = await db.update_group(group_id, current_build=new_build)
    return db.row_to_response(row)


# --- Demo Endpoints ---

@app.post("/demo/{group_id}/asteroid", response_model=GroupResponse)
async def demo_asteroid(group_id: str):
    row = await db.get_group_by_id(group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Group not found")

    city_map = row["city_map"]
    if isinstance(city_map, str):
        city_map = json.loads(city_map)

    # Check if there are any buildings to destroy
    occupied = _find_occupied_tiles(city_map)
    if not occupied:
        raise HTTPException(status_code=400, detail="No buildings on the map to destroy")

    current_build = row["current_build"]
    if isinstance(current_build, str):
        current_build = json.loads(current_build)

    # If no active build, inject a dummy so the asteroid branch fires
    if current_build is None:
        current_build = {"type": "house", "days_required": 1, "days_completed": 0}

    updates = process_end_of_day(
        group_members=list(row["group_members"]),
        completions_today=[],  # empty = failed day = asteroid
        current_build=current_build,
        city_map=city_map,
        streak=row["streak"],
    )

    row = await db.update_group(group_id, **updates)
    return db.row_to_response(row)


@app.post("/demo/{group_id}/fill_city", response_model=GroupResponse)
async def demo_fill_city(group_id: str, body: FillCity = FillCity()):
    row = await db.get_group_by_id(group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Group not found")

    city_map = row["city_map"]
    if isinstance(city_map, str):
        city_map = json.loads(city_map)

    empty = _find_empty_tiles(city_map)

    if not empty:
        raise HTTPException(status_code=400, detail="City is full — no empty tiles")

    if body.count is not None:
        tiles_to_fill = random.sample(empty, k=min(body.count, len(empty)))
    else:
        tiles_to_fill = empty

    building_types = ["house", "apartment", "skyscraper"]
    new_map = [cells[:] for cells in city_map]
    for r, c in tiles_to_fill:
        new_map[r][c] = random.choice(building_types)

    row = await db.update_group(group_id, city_map=new_map)
    return db.row_to_response(row)


@app.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: str):
    deleted = await db.delete_group(group_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Group not found")


@app.websocket("/groups/{group_id}/feed")
async def group_feed(websocket: WebSocket, group_id: str):
    await websocket.accept()

    import asyncio
    try:
        while True:
            # Check for client message (non-blocking) or wait 30s
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                pass

            row = await db.get_group_by_id(group_id)
            if not row:
                await websocket.close(code=4004, reason="Group not found")
                return

            resp = await maybe_process_day(row)
            await websocket.send_text(resp.model_dump_json())
    except WebSocketDisconnect:
        pass
