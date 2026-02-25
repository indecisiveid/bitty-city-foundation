import random
import uuid
from datetime import datetime, timezone, timedelta


BUILDING_DAYS = {"house": 1, "apartment": 3, "skyscraper": 7}

# Weights for asteroid targeting (higher = more likely to be hit)
DESTROY_WEIGHTS = {"house": 3, "apartment": 2, "skyscraper": 1}


def needs_day_processing(goal_reset_time: str, last_processed_date: str | None) -> bool:
    """Check if end-of-day processing should run."""
    now = datetime.now(timezone.utc)
    hour, minute = map(int, goal_reset_time.split(":"))

    # Build today's reset datetime in UTC
    reset_today = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    # If we haven't passed today's reset yet, no processing needed
    if now < reset_today:
        # Check against yesterday's date
        check_date = (reset_today - timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        check_date = reset_today.strftime("%Y-%m-%d")

    # If already processed for this period, skip
    if last_processed_date == check_date:
        return False

    return True


def get_processing_date(goal_reset_time: str) -> str:
    """Get the date string for the current processing period."""
    now = datetime.now(timezone.utc)
    hour, minute = map(int, goal_reset_time.split(":"))
    reset_today = now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if now < reset_today:
        return (reset_today - timedelta(days=1)).strftime("%Y-%m-%d")
    return reset_today.strftime("%Y-%m-%d")


def _find_empty_tiles(city_map: list[list]) -> list[list[int]]:
    """Find all empty or rubble tiles."""
    tiles = []
    for r, row in enumerate(city_map):
        for c, cell in enumerate(row):
            if cell is None or cell == "rubble":
                tiles.append([r, c])
    return tiles


def _find_occupied_tiles(city_map: list[list]) -> list[tuple[int, int, str]]:
    """Find all tiles with buildings. Returns (row, col, building_type)."""
    tiles = []
    for r, row in enumerate(city_map):
        for c, cell in enumerate(row):
            if cell in ("house", "apartment", "skyscraper"):
                tiles.append((r, c, cell))
    return tiles


def process_end_of_day(
    group_members: list[str],
    completions_today: list[str],
    current_build: dict | None,
    city_map: list[list],
    streak: int,
) -> dict:
    """
    Pure function: returns a dict of fields to update on the group row.
    Does NOT modify inputs.
    """
    updates: dict = {
        "completions_today": [],
    }
    now_iso = datetime.now(timezone.utc).isoformat()

    # No active build — just clear completions
    if current_build is None:
        return updates

    all_completed = set(group_members).issubset(set(completions_today))

    if all_completed:
        new_days = current_build["days_completed"] + 1

        if new_days >= current_build["days_required"]:
            # Building complete — place on random empty/rubble tile
            empty = _find_empty_tiles(city_map)
            new_map = [row[:] for row in city_map]  # deep copy

            if empty:
                tile = random.choice(empty)
                new_map[tile[0]][tile[1]] = current_build["type"]
                updates["city_map"] = new_map
                updates["pending_event"] = {
                    "event_id": f"evt_{uuid.uuid4().hex[:12]}",
                    "type": "build_complete",
                    "building": current_build["type"],
                    "tile": tile,
                    "timestamp": now_iso,
                }

            updates["current_build"] = None
            updates["streak"] = 0
        else:
            # Streak continues
            updates["current_build"] = {
                **current_build,
                "days_completed": new_days,
            }
            updates["streak"] = streak + 1
    else:
        # Failed — asteroid
        updates["streak"] = 0
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

                    new_map = [row[:] for row in city_map]
                    tiles_destroyed = []
                    for idx in destroyed_indices:
                        r, c, _ = occupied[idx]
                        new_map[r][c] = "rubble"
                        tiles_destroyed.append([r, c])

                    updates["city_map"] = new_map
                    updates["pending_event"] = {
                        "event_id": f"evt_{uuid.uuid4().hex[:12]}",
                        "type": "asteroid",
                        "tiles_destroyed": tiles_destroyed,
                        "timestamp": now_iso,
                    }

    return updates
