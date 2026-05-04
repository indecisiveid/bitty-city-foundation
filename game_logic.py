import random
import uuid
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


BUILDING_DAYS = {"house": 1, "apartment": 3, "skyscraper": 7}

# Weights for asteroid targeting (higher = more likely to be hit)
DESTROY_WEIGHTS = {"house": 3, "apartment": 2, "skyscraper": 1}


def _resolve_tz(tz_name: str) -> ZoneInfo:
    """Look up an IANA timezone by name; fall back to UTC if invalid.

    A bad string in `goal_reset_timezone` shouldn't crash end-of-day
    processing — log-and-fallback is safer than 500ing every request for
    that group.
    """
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def needs_day_processing(
    goal_reset_time: str,
    last_processed_date: str | None,
    goal_reset_timezone: str = "UTC",
) -> bool:
    """Check if end-of-day processing should run.

    Reset is "HH:MM in `goal_reset_timezone`". This means a city created
    by a user in Los Angeles with reset 07:00 ticks at 7am Pacific —
    independent of where the server runs OR where joining members live.
    """
    tz = _resolve_tz(goal_reset_timezone)
    now = datetime.now(tz)
    hour, minute = map(int, goal_reset_time.split(":"))

    reset_today = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if now < reset_today:
        check_date = (reset_today - timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        check_date = reset_today.strftime("%Y-%m-%d")

    if last_processed_date == check_date:
        return False

    return True


def get_processing_date(
    goal_reset_time: str,
    goal_reset_timezone: str = "UTC",
) -> str:
    """Get the date string for the current processing period."""
    tz = _resolve_tz(goal_reset_timezone)
    now = datetime.now(tz)
    hour, minute = map(int, goal_reset_time.split(":"))
    reset_today = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if now < reset_today:
        return (reset_today - timedelta(days=1)).strftime("%Y-%m-%d")
    return reset_today.strftime("%Y-%m-%d")


GRID_ROWS = 10
GRID_COLS = 10


def _find_empty_tiles(city_map: dict[str, list]) -> list[list[int]]:
    """Find all empty or rubble tiles. Iterates the city_map's actual rows
    so legacy 4×5 maps and the new 10×10 maps are both handled correctly."""
    tiles = []
    for r_str, row in city_map.items():
        r = int(r_str)
        for c, cell in enumerate(row):
            if cell is None or cell == "rubble":
                tiles.append([r, c])
    return tiles


def _find_occupied_tiles(city_map: dict[str, list]) -> list[tuple[int, int, str]]:
    """Find all tiles with buildings. Returns (row, col, building_type).
    Dimension-agnostic — works for any city_map shape."""
    tiles = []
    for r_str, row in city_map.items():
        r = int(r_str)
        for c, cell in enumerate(row):
            if cell in ("house", "apartment", "skyscraper"):
                tiles.append((r, c, cell))
    return tiles


def compute_streak(completion_dates: list[str], today_str: str) -> int:
    """Streak = consecutive recent days, ending at today or yesterday,
    on which a building was placed in the city. Anything older is OK to
    keep in the log, it just doesn't count toward the current run.

    Examples (today = 2026-05-04):
      [2026-05-04]                              → 1     (today)
      [2026-05-03, 2026-05-04]                  → 2     (yesterday + today)
      [2026-05-03]                              → 1     (yesterday only)
      [2026-05-02, 2026-05-04]                  → 1     (gap day; today only)
      [2026-05-02]                              → 0     (most recent is 2 days ago)
      []                                        → 0
    """
    if not completion_dates:
        return 0
    today = datetime.strptime(today_str, "%Y-%m-%d").date()
    yesterday = today - timedelta(days=1)
    parsed = sorted(
        {datetime.strptime(d, "%Y-%m-%d").date() for d in completion_dates},
        reverse=True,
    )
    if parsed[0] != today and parsed[0] != yesterday:
        return 0
    streak = 1
    expected = parsed[0] - timedelta(days=1)
    for d in parsed[1:]:
        if d == expected:
            streak += 1
            expected -= timedelta(days=1)
        else:
            break
    return streak


def process_end_of_day(
    group_members: list[str],
    completions_today: list[str],
    current_build: dict | None,
    city_map: dict[str, list],
    streak: int,                            # legacy param — recomputed below
    building_completions: list[str],
    processing_date: str,
) -> dict:
    """
    Pure function: returns a dict of fields to update on the group row.
    Does NOT modify inputs.

    `processing_date` is the date string ("YYYY-MM-DD") that this
    end-of-day pass is processing — i.e. the day that just ended in the
    group's local timezone. We pass it in (rather than recomputing here)
    so the caller's `last_processed_date` and our `building_completions`
    entries are guaranteed to use the same day boundary.
    """
    updates: dict = {
        "completions_today": [],
    }
    now_iso = datetime.now(timezone.utc).isoformat()

    # Streak depends on the current building_completions log, regardless
    # of whether a build was active. Compute it once at the bottom.
    new_completions = list(building_completions)

    # No active build — just clear completions, but also recompute streak
    # in case time passed and the run expired.
    if current_build is None:
        updates["streak"] = compute_streak(new_completions, processing_date)
        return updates

    all_completed = set(group_members).issubset(set(completions_today))

    if all_completed:
        new_days = current_build["days_completed"] + 1

        if new_days >= current_build["days_required"]:
            # Building complete — place on random empty/rubble tile
            empty = _find_empty_tiles(city_map)
            new_map = {k: row[:] for k, row in city_map.items()}  # deep copy

            if empty:
                tile = random.choice(empty)
                new_map[str(tile[0])][tile[1]] = current_build["type"]
                updates["city_map"] = new_map
                updates["pending_event"] = {
                    "event_id": f"evt_{uuid.uuid4().hex[:12]}",
                    "type": "build_complete",
                    "building": current_build["type"],
                    "tile": tile,
                    "timestamp": now_iso,
                }
                # Log the landing date so the streak math has data to
                # work with. De-dupe in case a day somehow gets processed
                # twice (idempotency safety).
                if processing_date not in new_completions:
                    new_completions.append(processing_date)

            updates["current_build"] = None
        else:
            # Build advances; no building landed today, so the
            # building_completions log is unchanged. Streak will reflect
            # whatever the most recent landing date was.
            updates["current_build"] = {
                **current_build,
                "days_completed": new_days,
            }
    else:
        # Failed — asteroid
        updates["current_build"] = None

        occupied = _find_occupied_tiles(city_map)
        if len(occupied) > 0:
            # Determine how many to destroy (1-3, but leave at least 1)
            max_destroy = min(3, len(occupied) - 1)
            if max_destroy < 1:
                max_destroy = 1 if len(occupied) > 1 else 0

            if max_destroy > 0:
                n_destroy = random.randint(1, max_destroy)

                # Weighted selection
                weights = [DESTROY_WEIGHTS.get(t[2], 1) for t in occupied]

                # If destroying all would wipe the city, ensure at least 1 survives
                if n_destroy >= len(occupied):
                    n_destroy = len(occupied) - 1

                if n_destroy > 0:
                    destroyed = random.sample(
                        list(range(len(occupied))),
                        k=min(n_destroy, len(occupied)),
                    )
                    # Use weighted selection instead of uniform
                    destroyed_indices = []
                    remaining = list(range(len(occupied)))
                    remaining_weights = weights[:]
                    for _ in range(n_destroy):
                        if not remaining:
                            break
                        idx = random.choices(remaining, weights=remaining_weights, k=1)[0]
                        destroyed_indices.append(idx)
                        pos = remaining.index(idx)
                        remaining.pop(pos)
                        remaining_weights.pop(pos)

                    new_map = {k: row[:] for k, row in city_map.items()}
                    tiles_destroyed = []
                    for idx in destroyed_indices:
                        r, c, _ = occupied[idx]
                        new_map[str(r)][c] = "rubble"
                        tiles_destroyed.append([r, c])

                    updates["city_map"] = new_map
                    updates["pending_event"] = {
                        "event_id": f"evt_{uuid.uuid4().hex[:12]}",
                        "type": "asteroid",
                        "tiles_destroyed": tiles_destroyed,
                        "timestamp": now_iso,
                    }

    # Single source of truth for streak: derive it from the (possibly
    # appended-to) completions log relative to the day we just processed.
    # This guarantees the displayed number always matches the dates in
    # the database — no drift from increment/decrement bugs.
    updates["building_completions"] = new_completions
    updates["streak"] = compute_streak(new_completions, processing_date)
    # `streak` arg above is now ignored — kept on the signature for backwards
    # compatibility with any caller that hasn't migrated yet.
    _ = streak
    return updates
