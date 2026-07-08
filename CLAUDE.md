# CLAUDE.md - bitty-city-foundation (backend)

## What This Is

Firebase backend for **Bitty City** (multiplayer city-building
accountability game). TypeScript **Cloud Functions v2 callables** +
**Firestore**. Firebase project id: `bitty-city` (owner: Chris,
ccrimi75@gmail.com). The mobile app lives in `../bitty-city/mobile/`.

*(The FastAPI/Render/Postgres stack described in old docs is dead and
deleted — this repo is Firebase-only.)*

## Layout

```
functions/src/
  gameLogic.ts       PURE game rules — streaks (+freezes/repair), end-of-day
                     processing, asteroids, 7-day inactivity meteor,
                     first-day grace. Jest-tested; keep it pure.
  groupHandlers.ts   Callables: createGroup, joinGroup, getGroup,
                     completeGoal, selectBuild, deleteGroup, leaveGroup,
                     repairStreak, upsertProfile
  demoHandlers.ts    Dev-only callables (demoAsteroid/FillCity/SetBuildings/
                     ResetCity) — deployed but email-allowlisted
  auth.ts            requireAuth / requireDemoAccess (+ DEMO_ALLOWLIST param)
  utils.ts           validation, group code gen, shared response shape
  __tests__/         jest suite for gameLogic
firestore.rules      groups readable by members only; users/{uid} owner-only;
                     ALL writes server-only
scripts/emulator-smoke.mjs   end-to-end emulator test (see below)
```

## Data model

`groups/{id}`: `group_code, group_name, group_members: string[]` (display
names, ≤4), `owner_uid`, `member_uids: string[]` (index-aligned with
group_members), `daily_goal`, `goal_reset_time "HH:MM"`,
`goal_reset_timezone` (IANA), `completions_today: string[]` (names),
`streak`, `streak_freezes` (start 1, cap 3, +1 per landing),
`frozen_dates: string[]`, `broken_streak: {value, broken_on,
last_active_date} | null`, `last_activity_date`,
`last_inactivity_meteor_date`, `current_build`, `city_map` (**row-keyed
JSON, never nested arrays** — Firestore rejects them),
`last_processed_date`, `pending_event` (has `cause: missed_day|inactivity`
on asteroids), `building_completions: string[]` (every all-complete day),
`created_at`.

`group_codes/{CODE}` → `{group_id}`. `users/{uid}` → `{display_name,
group_ids[]}` (cross-device restore + 100-groups cap).

## Game rules (the parts that bite)

- **Streak** = consecutive all-complete days ending today/yesterday, derived
  from `building_completions` (+ frozen bridge days). Recomputed every
  day-process — never incremented imperatively.
- **Day processing is lazy**: `maybeProcessDay` runs when a callable touches
  the group (the app nudges `getGroup` on open). One pass settles the whole
  gap since `last_processed_date`.
- **Freezes** protect the streak counter only. The **7-day inactivity
  meteor** (no completions for ≥7 days → destroy ceil(20%), max 10,
  throttled to one per 7 days) fires regardless of freezes and regardless
  of `current_build`.
- **First-day grace**: no punishment while the day's reset boundary is
  < 24h after `created_at`.
- Callables: `onCall({ enforceAppCheck: true }, …)`, throw
  `HttpsError(code, msg)`; caller identity from `request.auth.uid` — never
  trust a client-sent member name. Timezone math: luxon `setZone` with the
  group's `goal_reset_timezone`.
- Mobile mirrors `computeStreakWithFreezes` in
  `../bitty-city/mobile/src/utils/streak.ts` — change both together.

## Commands

```bash
cd functions && npm run build     # tsc — keep clean
cd functions && npm test          # jest (gameLogic suite)

# Emulators (Java via brew: PATH="/opt/homebrew/opt/openjdk/bin:$PATH")
firebase emulators:start --only auth,functions,firestore --project bitty-city
node scripts/emulator-smoke.mjs   # 44-check end-to-end smoke

npm --prefix functions run deploy # prod deploy (needs Chris/Christian creds)
```

`DEMO_ALLOWLIST` (comma-separated emails allowed to call demo functions)
comes from `functions/.env` locally (see `functions/.env.example`) / a
functions param in prod.
