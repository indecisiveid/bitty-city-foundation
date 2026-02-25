from pydantic import BaseModel
from typing import Optional
from datetime import datetime


# --- Request Models ---

class CreateGroup(BaseModel):
    group_name: str
    member: str
    daily_goal: str
    goal_reset_time: str = "00:00"  # HH:MM UTC


class JoinGroup(BaseModel):
    group_code: str
    member: str


class CompleteGoal(BaseModel):
    member: str


class SelectBuild(BaseModel):
    member: str
    type: str  # "house" | "apartment" | "skyscraper"


# --- Nested Models ---

class CurrentBuild(BaseModel):
    type: str
    days_required: int
    days_completed: int


class PendingEvent(BaseModel):
    event_id: str
    type: str  # "asteroid" | "build_complete"
    tiles_destroyed: Optional[list[list[int]]] = None
    building: Optional[str] = None
    tile: Optional[list[int]] = None
    timestamp: str


# --- Response Model ---

class GroupResponse(BaseModel):
    group_id: str
    group_code: str
    group_name: str
    group_members: list[str]
    daily_goal: str
    goal_reset_time: str
    completions_today: list[str]
    streak: int
    current_build: Optional[CurrentBuild] = None
    city_map: list[list[Optional[str]]]
    last_processed_date: Optional[str] = None
    pending_event: Optional[PendingEvent] = None
    created_at: str
