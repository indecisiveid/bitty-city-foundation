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
  gameMode.ts        PURE — easy/hard mode: how much of a day a roster banks
                     (dayShare), fractional-progress snapping, the near-miss
                     ledger + "try easy mode" suggestion rule.
  modeHandlers.ts    Callables: setGameMode (any member), dismissModeSuggestion
  groupHandlers.ts   Callables: createGroup, joinGroup, getGroup,
                     completeGoal, selectBuild, deleteGroup, leaveGroup,
                     repairStreak, rescueBuild, repairTile, repairPark,
                     upsertProfile
  demoHandlers.ts    Dev-only callables (demoAsteroid/FillCity/SetBuildings/
                     ResetCity) — deployed but email-allowlisted
  auth.ts            requireAuth / requireDemoAccess (+ DEMO_ALLOWLIST param)
  proofs.ts          PURE goal-proof logic — key shape (proofs/{g}/{uid}/{id}.jpg),
                     date-stamped proofs_today bucket (mirrors kudos.ts)
  proofStorage.ts    Admin-SDK check that a claimed proof object really exists
                     (bucket from PROOFS_BUCKET param)
  utils.ts           validation, group code gen, shared response shape
  __tests__/         jest suite for gameLogic
firestore.rules      groups readable by members only; users/{uid} owner-only;
                     ALL writes server-only; groups/{id}/days/{date} readable by members
storage.rules        proof photos: proofs/{groupId}/{uid}/{id}.jpg — member-read,
                     own-uid create-only, jpeg ≤5 MiB (membership via firestore.get)
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
on asteroids), `building_completions: string[]` (every successful day),
`proofs_today: {date, entries: {[name]: {status: photo|skipped, key?}}} | null`
(today's goal proofs, cleared at rollover), `game_mode: "easy"|"hard"` (absent = hard), `near_miss_dates: string[]`
(hard mode: settlement labels where someone-but-not-everyone finished),
`mode_suggestion: {suggested_on, near_misses, dismissed_by[]} | null`,
`created_at`.

`groups/{id}/days/{YYYY-MM-DD}` → `{proofs: {[name]: {status, key?, at}}}` —
durable proof ledger, written by `completeGoal`, member-readable (the app's
"See proof" reads it directly + resolves photo URLs with the Storage SDK).
Photos live in Storage at `proofs/{groupId}/{uid}/{random}.jpg` behind
`storage.rules` (member-read, own-uid create-only, jpeg ≤5 MiB).

`group_codes/{CODE}` → `{group_id}`. `users/{uid}` → `{display_name, group_ids[], created_at, push_tokens[],
last_seen_at, reminders: {date, sent, farewell_sent_at}, completion_minutes[]}` (cross-device restore + 100-groups cap; `last_seen_at` is presence,
stamped by getGroup/registerPushToken/completeGoal — see `presence.ts`;
`reminders` is the per-person send ledger the scheduler keeps — see
`reminderTiers.ts`).

## Game rules (the parts that bite)

- **Game mode** (`gameMode.ts`) decides what a successful day IS. Hard
  (default, the v1.0 rules): every active member completes → the build
  advances 1 day. Easy: each completion adds `1/active` of a day, so
  `current_build.days_completed` may be **fractional**; a day with any
  completion is successful, a day with none is a miss in both modes. Easy
  can never outpace hard. Three hard-mode near misses in 7 days raise
  `mode_suggestion` (+ one push), cooldown 14 days.
- **Streak** = consecutive successful days ending today/yesterday, derived
  from `building_completions` (+ frozen bridge days). Recomputed every
  day-process — never incremented imperatively.
- **Builds land immediately** (2026-09-10): `completeGoal` lands the build in
  its own transaction the moment the last ACTIVE member finishes its final
  day (`landBuild` in gameLogic.ts — pure, shared with the day processor's
  fallback). `landed_on` blocks `selectBuild` until day processing clears it,
  so one day's check-ins never land two buildings. Tiles are stamped with the
  GAME DAY the crew completed on (= the proof ledger key), not the settlement
  label.
- **Reminders are per-city decisions, per-person deliveries.** `reminderLogic.ts`
  decides what a CITY owes at each of four local slots (solo cities: evening
  only, plus last call while a streak is live, plus the meteor any time).
  `reminderTiers.ts` then gates each PERSON by `users/{uid}.last_seen_at`
  (`presence.ts`): <7 days idle hears everything; 7–13 days hears one push a
  day and only the late slots; ≥14 days gets one farewell and then silence
  until they open the app. A missing stamp means unknown → active (never
  farewell on a guess); `scripts/backfill-last-seen.mjs` seeds it from Auth.
- **Day processing runs on the server clock**: the 30-minute scheduler
  (`scheduled.ts` → `runDayRollover`) settles every city whose boundary has
  passed, then decides nudges against the settled state. Callables still
  call `maybeProcessDay` as a fallback for the gap before the next tick (and
  for landing today's build immediately, per the bullet above). The pass is
  a transaction that re-checks `last_processed_date`, so the two paths can't
  double-settle or clobber each other. One pass settles the whole gap since
  `last_processed_date`.
- **Settlement labels run a day ahead of game days**, and the pass that
  settles a missed day only charges gap days *before* it — the label itself
  is charged on the next pass. Any in-day action that spends or grants
  forgiveness (`applyBuildRescue`, `applyStreakRepair`) must therefore
  freeze the just-settled label too, or the next pass bills the same miss
  twice.
- **Restoring meteor damage** (park design spec): `repairTile` restores a
  levelled building on its own lot in `RESTORE_BUILDING_DAYS` (1) whatever it
  cost; `repairPark` clears a damaged park in place in `parkRestoreDays`
  (1–4 by damaged cells). Both take the build slot and refuse after a landing
  today. `target_tile` / `target_park` must survive a stall + rescue, or a
  rescued park restoration lands as a brand-new park. Mirrored in the app's
  `src/utils/restore.ts`.
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

# Emulators (Java via brew: PATH="/opt/homebrew/opt/openjdk/bin:$PATH").
# The emulator PROMPTS for any param missing from functions/.env (even with a
# default) — add --non-interactive so a missing one fails instead of hanging.
# pubsub is required now too — the scheduled day-rollover function is a
# Pub/Sub trigger and is silently ignored by the emulator without it.
firebase emulators:start --only auth,functions,firestore,storage,pubsub --project bitty-city --non-interactive
node scripts/emulator-smoke.mjs   # 161-check end-to-end smoke (pubsub: the scheduler section)
# Ports busy (another session's emulator)? Start yours from a copy of
# firebase.json with other ports and run the smoke with
# SMOKE_{AUTH,FUNCTIONS,FIRESTORE,STORAGE}_PORT=… set.

npm --prefix functions run deploy # prod deploy (needs Chris/Christian creds)
```

`DEMO_ALLOWLIST` (comma-separated emails allowed to call demo functions)
and `PROOFS_BUCKET` come from `functions/.env` locally (see `functions/.env.example`) / a
functions param in prod.
