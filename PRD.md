# PRD: Group City Builder — Backend

## Overview

A group accountability app where completing a shared daily goal builds a virtual city. Consecutive completions upgrade buildings; missed days trigger asteroid destruction events. Backend serves 1–4 person friend groups.


This will be using Render, so please deploy this with render.

Use Render Websevice, render postgres, and fastapi python please!

---

## Data Model

Single table. One row per group. That's it.

### `groups`

| Field | Type | Description |
|---|---|---|
| `group_id` | `string (UUID)` | Primary key |
| `group_code` | `string (6 char)` | Shareable invite code, auto-generated on creation |
| `group_name` | `string` | Display name |
| `group_members` | `string[]` | List of member identifiers (user IDs or display names) |
| `daily_goal` | `string` | Shared goal, set at creation, immutable |
| `goal_reset_time` | `string (HH:MM)` | When the day resets (UTC) |
| `completions_today` | `string[]` | Members who completed today's goal |
| `streak` | `integer` | Consecutive days completed toward current build |
| `current_build` | `object \| null` | Current building attempt. See **Building Selection** below. `null` = waiting for someone to pick. |
| `city_map` | `object[5][4]` | 5×4 grid representing the city. See **City Map** section below. |
| `last_processed_date` | `string (YYYY-MM-DD)` | Last date the end-of-day logic ran (prevents double-processing) |
| `pending_event` | `object \| null` | Last build/asteroid event. See **Pending Event** below. |
| `created_at` | `timestamp` | — |

### City Map

The `city_map` is a 5×4 (5 columns, 4 rows = 20 tiles) 2D array. Each cell is a string or `null`:

```
"house" | "apartment" | "skyscraper" | "rubble" | null
```

**Initialized as all empty on group creation:**

```json
"city_map": [
  [null, null, null, null, null],
  [null, null, null, null, null],
  [null, null, null, null, null],
  [null, null, null, null, null]
]
```

**Tile types:**

| Type | Description |
|---|---|
| `null` | Empty lot, available for building |
| `house` | Built after 1 consecutive day |
| `apartment` | Built after 3 consecutive days |
| `skyscraper` | Built after 7 consecutive days |
| `rubble` | Destroyed building. Can be rebuilt on |

### Building Selection

The group chooses what to build before each streak. The `current_build` object tracks the attempt:

```json
{
  "type": "house" | "apartment" | "skyscraper",
  "days_required": 1 | 3 | 7,
  "days_completed": 0
}
```

**Flow:**

1. Group has no active build (`current_build: null`) → any member picks a building type
2. Each day the entire group completes the goal → `days_completed` increments
3. `days_completed` reaches `days_required` → building placed on a random empty/rubble tile, `current_build` resets to `null`
4. Group fails a day mid-attempt → asteroid fires, `current_build` resets to `null`, all progress lost
5. Any member picks the next building → loop back to step 2

**Building options:**

| Type | Days Required |
|---|---|
| `house` | 1 |
| `apartment` | 3 |
| `skyscraper` | 7 |

### Asteroid Mechanics (on missed day)

- Streak resets to 0, `current_build` resets to `null`
- Random destruction event: pick `N` occupied tiles (1–3, weighted by city size)
- Selection is weighted so houses are most likely to be hit, skyscrapers least likely
- Destroyed tiles become `"rubble"`
- City is never fully wiped — at least 1 building always survives

### Pending Event

When end-of-day processing runs, the result is stored in `pending_event` so every client can play the animation. The backend does not track who has seen it — the frontend stores the last seen `event_id` locally and ignores events it has already played.

```json
{
  "event_id": "evt_abc123",
  "type": "asteroid",
  "tiles_destroyed": [[1,2], [3,0]],
  "timestamp": "2026-02-25T08:00:00Z"
}
```

```json
{
  "event_id": "evt_def456",
  "type": "build_complete",
  "building": "apartment",
  "tile": [2,3],
  "timestamp": "2026-02-25T08:00:00Z"
}
```

- `event_id` is a unique string generated per event
- `pending_event` is overwritten each time end-of-day runs (only the latest event matters)
- Frontend checks: if `event_id` matches last seen → skip animation, just show current city state
- No ack endpoint needed

---

## Endpoints

### 1. `POST /groups` — Create Group

**Request:**
```json
{
  "group_name": "Morning Runners",
  "member": "alice",
  "daily_goal": "Run 1 mile",
  "goal_reset_time": "00:00"
}
```

**Response:** `201` with full group object including `group_code`.

**Notes:** Creator is added as the first member. A unique 6-character `group_code` is auto-generated for sharing.

---

### 2. `POST /groups/join` — Join Group

**Request:**
```json
{
  "group_code": "ABC123",
  "member": "bob"
}
```

**Response:** `200` with full group object.

**Logic:**
- Look up group by `group_code`
- Add member to `group_members` (max 4, reject if full)
- Idempotent — joining again with same name is a no-op

---

### 3. `POST /groups/:group_id/complete` — Complete Goal

**Request:**
```json
{
  "member": "alice"
}
```

**Response:** `200` with updated group object (shows who's completed).

**Logic:**
- Add member to `completions_today` (idempotent — no double counting)
- If all members have completed, that counts as a group completion for the day
- Return current completion state so the client can show progress

---

### 4. `POST /groups/:group_id/select_build` — Pick Next Building

**Request:**
```json
{
  "member": "alice",
  "type": "apartment"
}
```

**Response:** `200` with updated group object.

**Logic:**
- Only valid when `current_build` is `null` (no active attempt)
- If city is full (no empty/rubble tiles), return `400` error
- Any member can pick. No voting in MVP.
- Sets `current_build` with `days_required` and `days_completed: 0`

---

### 5. `GET /groups/:group_id/feed` — Group Feed (WebSocket)

**Upgrade to WebSocket on connect.**

Pushes events to all connected clients:
- `member_completed` — someone checked off the goal
- `member_joined` — someone joined the group via code
- `build_selected` — someone picked the next building to attempt
- `build_complete` — building placed on the map
- `asteroid` — group failed, destruction event fired

**Fallback:** If WebSocket is too heavy for MVP, polling `GET /groups/:group_id` every 30s is fine. Don't over-engineer day one.

---

### 6. `DELETE /groups/:group_id` — Delete Group

**Response:** `204` No Content.

Hard delete. No soft delete in MVP.

---

### 7. `GET /groups/:group_id` — Get Group State

**Response:** `200` with full group object.

This is the "load the app" endpoint. Returns everything the client needs: `city_map`, today's goal, who's completed, streak, `current_build`, and `pending_event`. Frontend checks `pending_event.event_id` against locally stored last seen ID to decide whether to play the animation.

---

## End-of-Day Processing

Triggered on first request after `goal_reset_time` passes (lazy evaluation), or via a cron job — whichever is simpler to implement first.

**Logic:**
1. Check `last_processed_date`. If already today, skip.
2. If `current_build` is `null` (no active attempt), just clear completions and update `last_processed_date`. No build, no asteroid.
3. Did all members complete? (i.e. `len(completions_today) == len(group_members)`) → **Yes:** increment `current_build.days_completed`.
   - If `days_completed == days_required` → place building on random empty/rubble tile, set `current_build` to `null`, reset `streak` to 0.
   - Otherwise, increment `streak`.
4. Did all members complete? → **No:** reset `streak` to 0, run **one** asteroid event, set `current_build` to `null`.
5. Clear `completions_today`.
6. Set `last_processed_date` to today.
7. Push `day_processed` event via WebSocket/feed.

**Edge cases:**
- **Multiple missed days:** If the app hasn't been opened in days, only one asteroid fires on the next request — not one per missed day.
- **Mid-streak joins:** New member must complete the goal like everyone else. If they haven't, the group fails. This is intentional for MVP.
- **City is full (20/20):** `select_build` returns an error. No building, no asteroid. City is complete.

---

## Open Decisions (Punt to Post-MVP)

- Auth / user accounts (members are just string identifiers for now)
- Photo proof verification (checkbox only for MVP)
- "City complete" celebration / what happens when all 20 tiles are filled
- Progression beyond skyscraper
- What happens after city is full (prestige / new city / expand grid)
