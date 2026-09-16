import { v4 as uuidv4 } from "uuid";
import { Park, makeParkId, parkFootprint } from "./parks";
import { DateTime } from "luxon";
import {
  PauseRange,
  MemberPauses,
  Roster,
  activeMembersOn,
  isDayPaused,
  bridgeDates,
  pausedDaysThrough,
  addDays,
} from "./pauses";
import { daysFor, isKnownBuild } from "./buildCatalog";
import { GameMode, dayShare, isBuildFinished, snapProgress, pruneNearMisses } from "./gameMode";

export const BUILDING_DAYS: Record<string, number> = {
  house: 1,
  apartment: 3,
  skyscraper: 7,
};

// Weights for asteroid targeting (higher = more likely to be hit).
//
// Derived from the build's day cost rather than a name table: a table keyed on
// 'house' | 'apartment' | 'skyscraper' silently fell through to the default
// weight for every catalog id, which would have quietly flattened the bias to
// uniform the moment the new vocabulary shipped. Cheap builds are likelier to
// be hit, so losing one stings less than losing a week's work.
function destroyWeight(type: string): number {
  const days = daysFor(type) ?? 1;
  if (days >= 7) return 1;
  if (days >= 3) return 2;
  return 3;
}

// --- Streak forgiveness ---
// Groups hold a small stock of "streak freezes". A missed day that would
// break a positive streak consumes one freeze per gap day instead. Frozen
// days bridge the chain but do not increment the count.
export const FREEZE_CAP = 3;
export const STARTING_FREEZES = 1;
// A broken streak can be repaired (gap days retroactively frozen) within
// this many days of the break.
export const REPAIR_WINDOW_DAYS = 7;

// --- Build rescue ---
// Missing a day of a multi-day build does NOT damage the city (see the
// meteor note below — falling rocks are reserved for real abandonment).
// The build simply stops: it is lifted off the board into
// `abandoned_build`, and the crew gets one day to spend a streak freeze
// and pick it back up exactly where it stalled. Miss that window (or hold
// no freezes) and the build is gone for good — they choose a new one.
export const BUILD_RESCUE_WINDOW_DAYS = 1;

// --- Restoring what the meteor broke ---
// Per the park design (vault specs/2026-08-02-park-design.md, "Damage and
// repair"): rebuilding is meant to be cheaper than building — the lot, roads
// and footprint all survive, only the structure is gone. A levelled building
// comes back in ONE day whatever it originally cost. A park is never
// destroyed outright, only scorched in part, so its cost scales with the
// damage. Both occupy the single build slot and ride the ordinary multi-day
// machine (progress, stalls, rescue, pushes). Mirrored in the app's
// `src/utils/restore.ts` — change both together.
export const RESTORE_BUILDING_DAYS = 1;

/** Days to restore a park with `damagedCells` damaged cells: 1–4. */
export function parkRestoreDays(damagedCells: number): number {
  return Math.min(4, Math.max(1, Math.ceil(damagedCells / 4)));
}

/** How many cells of a park are damaged (any level). */
export function damagedCellCount(damage: Record<string, 1 | 2> | null | undefined): number {
  return Object.keys(damage ?? {}).length;
}

// --- 7-day inactivity meteor ---
// If a group logs no goal completions for this many consecutive days, a
// meteor damages the city on the next day-process — regardless of whether
// a build is active. Streak freezes do NOT prevent it (forgiveness is for
// short slips; the meteor punishes abandonment). This is the ONLY thing
// that destroys standing buildings.
export const INACTIVITY_METEOR_DAYS = 7;
export const INACTIVITY_DESTROY_FRACTION = 0.2;
export const INACTIVITY_DESTROY_MAX = 10;

export type CityMap = Record<string, (string | null)[]>;

export interface CurrentBuild {
  type: string;
  days_required: number;
  /**
   * Days banked. A whole number in hard mode; in easy mode each completion
   * adds its share of a day, so this may be fractional (see gameMode.ts).
   */
  days_completed: number;
  /**
   * Land this build on THIS lot instead of a random one.
   *
   * Set only by a repair: the whole promise of tapping a ruin is that the
   * building comes back where it stood. An ordinary build leaves this unset
   * and still lands wherever the city has room.
   */
  target_tile?: { row: number; col: number };
  /**
   * Restore THIS park's damage instead of founding a new park.
   *
   * Set only by `repairPark`. The build's `type` is still the park's catalog
   * id (so every label, icon and push reads naturally), which is exactly why
   * this marker must survive a stall and a rescue: without it, a rescued
   * restoration would land as a brand-new park.
   */
  target_park?: string;
}

/** True when this build puts something back rather than adding to the city. */
export function isRestoreBuild(build: { target_tile?: unknown; target_park?: unknown } | null | undefined): boolean {
  return !!build && (build.target_tile != null || build.target_park != null);
}

export interface PendingEvent {
  event_id: string;
  type: "build_complete" | "asteroid";
  // Distinguishes the standard missed-build asteroid from the 7-day
  // inactivity meteor so the client can frame the moment differently.
  cause?: "missed_day" | "inactivity";
  // Firestore rejects nested arrays in document writes. Each destroyed
  // tile is therefore stored as an object `{row, col}` rather than a
  // `[row, col]` tuple, even though the latter would be more compact.
  tiles_destroyed?: Array<{ row: number; col: number }>;
  building?: string;
  tile?: number[];
  /** A restoration landed (the build put something back). */
  restored?: boolean;
  timestamp: string;
}

// A multi-day build that stalled on a missed day. Held for exactly
// BUILD_RESCUE_WINDOW_DAYS so the crew can spend a freeze to resume it
// with its progress intact (`applyBuildRescue`).
export interface AbandonedBuild {
  type: string;
  days_required: number;
  days_completed: number;
  abandoned_on: string; // "YYYY-MM-DD" the missed day that stopped the build
  /** Carried from a stalled restoration so a rescue still restores. */
  target_tile?: { row: number; col: number };
  target_park?: string;
}

export interface BrokenStreak {
  value: number;
  broken_on: string; // "YYYY-MM-DD" processing day the break was recorded
  last_active_date: string; // "YYYY-MM-DD" last day the chain was alive
}

export interface GroupDoc {
  group_id: string;
  group_code: string;
  group_name: string;
  group_members: string[];
  owner_uid?: string;
  member_uids?: string[];
  daily_goal: string;
  goal_reset_time: string;
  goal_reset_timezone?: string;
  completions_today: string[];
  streak: number;
  streak_freezes?: number;
  frozen_dates?: string[];
  broken_streak?: BrokenStreak | null;
  last_activity_date?: string | null;
  last_inactivity_meteor_date?: string | null;
  current_build: CurrentBuild | null;
  abandoned_build?: AbandonedBuild | null;
  city_map: CityMap;
  /**
   * Every built cell as "row,col", in the order it landed. This — not the
   * cell's row-major position — is a building's slot in the client's block
   * plan. Landings go on a RANDOM empty tile, so ordering by grid position
   * let one landing insert itself ahead of the whole city and move every
   * building. Append-only; a levelled lot keeps its entry so a repair lands
   * back on its slot. Absent on docs written before it existed — the client
   * (and `rowMajorBuildOrder`) fall back to row-major, which is exactly how
   * those cities rendered, so backfilling moves nothing.
   */
  build_order?: string[];
  /** Parks, recorded outside `city_map` — absent on cities that predate them. */
  parks?: Park[] | null;
  /** Vacation mode (see pauses.ts). uid → range; absent = nobody paused. */
  member_pauses?: MemberPauses | null;
  /** The whole city on pause for a range of game days. */
  city_pause?: PauseRange | null;
  /** How a day counts — see gameMode.ts. Absent = hard (the v1.0 rules). */
  game_mode?: GameMode;
  /**
   * Hard mode only: settlement labels of days where SOMEONE finished but not
   * everyone. Trailing window, pruned each pass. Feeds the easy-mode
   * suggestion (gameMode.shouldSuggestEasyMode).
   */
  near_miss_dates?: string[];
  /**
   * Game days processed as city-paused (an explicit city pause, or every
   * member away). Append-only. Bridge days for the streak, exactly like
   * `frozen_dates`, but kept apart so a vacation never reads as spent
   * freezes in the stats.
   */
  paused_dates?: string[];
  last_processed_date: string | null;
  pending_event: PendingEvent | null;
  building_completions: string[];
  // Per-tile build date: key "row,col" → "YYYY-MM-DD" the building on that
  // tile last landed. Set when a building lands, cleared when destroyed, so
  // it stays correct through asteroids. Flat object (no nested arrays) to
  // satisfy Firestore.
  tile_build_dates?: Record<string, string>;
  created_at: FirebaseFirestore.Timestamp;
}

export interface EndOfDayUpdates {
  completions_today: string[];
  city_map?: CityMap;
  build_order?: string[];
  parks?: Park[];
  current_build?: CurrentBuild | null;
  abandoned_build?: AbandonedBuild | null;
  streak?: number;
  streak_freezes?: number;
  frozen_dates?: string[];
  paused_dates?: string[];
  broken_streak?: BrokenStreak | null;
  /** Written when the near-miss ledger changed (hard mode). */
  near_miss_dates?: string[];
  /** Written only when a pause parks the inactivity clock — see the
   *  meteor section of processEndOfDay. */
  last_activity_date?: string;
  last_inactivity_meteor_date?: string;
  pending_event?: PendingEvent;
  building_completions?: string[];
  tile_build_dates?: Record<string, string>;
  /**
   * "row,col" → the build id that stood there before it was levelled.
   *
   * Destruction overwrites the cell with `"rubble"`, so without this ledger
   * the original type is simply gone and "rebuild what was here" has nothing
   * to rebuild. Cleared for a cell once something stands on it again.
   */
  rubble_origins?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Timezone helper — mirrors Python's `_resolve_tz`
// ---------------------------------------------------------------------------

function resolveZone(tzName: string): string {
  // luxon validates zone by checking if the resulting DateTime is valid.
  // An invalid zone name produces an invalid DateTime.
  const dt = DateTime.now().setZone(tzName);
  return dt.isValid ? tzName : "UTC";
}

// ---------------------------------------------------------------------------
// Date-string arithmetic — "YYYY-MM-DD" ↔ days-since-epoch (integer math
// avoids timezone drift; all game dates are already tz-resolved strings)
// ---------------------------------------------------------------------------

function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function formatYmd(dayNum: number): string {
  return new Date(dayNum * 86400000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return parseYmd(b) - parseYmd(a);
}

// ---------------------------------------------------------------------------
// computeStreakWithFreezes
//
// Streak = number of *successful* days in the consecutive run of "active"
// days (successful or frozen) ending at today or yesterday. Frozen days
// bridge gaps without incrementing the count.
//
// `completionDates` = days on which the whole group completed its goal
// (see processEndOfDay — every all-complete day is logged, not just days a
// building landed, so multi-day builds keep the streak climbing).
// ---------------------------------------------------------------------------

export function computeStreakWithFreezes(
  completionDates: string[],
  frozenDates: string[],
  todayStr: string,
): number {
  if (completionDates.length === 0) return 0;

  const completionSet = new Set(completionDates.map(parseYmd));
  const active = new Set([
    ...completionSet,
    ...frozenDates.map(parseYmd),
  ]);

  const today = parseYmd(todayStr);
  const anchor = active.has(today)
    ? today
    : active.has(today - 1)
      ? today - 1
      : null;
  if (anchor === null) return 0;

  let streak = 0;
  let d = anchor;
  while (active.has(d)) {
    if (completionSet.has(d)) streak++;
    d -= 1;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// computeStreak — historical entry point (no freezes). Kept because the
// mobile app mirrors this exact function in `mobile/src/utils/streak.ts`.
//
// Examples (today = 2026-05-04):
//   ["2026-05-04"]                          → 1   (today)
//   ["2026-05-03", "2026-05-04"]            → 2   (yesterday + today)
//   ["2026-05-03"]                          → 1   (yesterday only)
//   ["2026-05-02", "2026-05-04"]            → 1   (gap; today only)
//   ["2026-05-02"]                          → 0   (most recent 2 days ago)
//   []                                      → 0
// ---------------------------------------------------------------------------

export function computeStreak(
  completionDates: string[],
  todayStr: string,
): number {
  return computeStreakWithFreezes(completionDates, [], todayStr);
}

// ---------------------------------------------------------------------------
// needsDayProcessing — mirrors Python `needs_day_processing`, now tz-aware
// ---------------------------------------------------------------------------

export function needsDayProcessing(
  goalResetTime: string,
  lastProcessedDate: string | null,
  goalResetTimezone: string = "UTC",
): boolean {
  const tz = resolveZone(goalResetTimezone);
  const now = DateTime.now().setZone(tz);
  const [hour, minute] = goalResetTime.split(":").map(Number);

  const resetToday = now.set({ hour, minute, second: 0, millisecond: 0 });

  let checkDate: string;
  if (now < resetToday) {
    checkDate = resetToday.minus({ days: 1 }).toISODate()!;
  } else {
    checkDate = resetToday.toISODate()!;
  }

  return lastProcessedDate !== checkDate;
}

// ---------------------------------------------------------------------------
// getProcessingDate — mirrors Python `get_processing_date`, now tz-aware
// ---------------------------------------------------------------------------

export function getProcessingDate(
  goalResetTime: string,
  goalResetTimezone: string = "UTC",
): string {
  const tz = resolveZone(goalResetTimezone);
  const now = DateTime.now().setZone(tz);
  const [hour, minute] = goalResetTime.split(":").map(Number);

  const resetToday = now.set({ hour, minute, second: 0, millisecond: 0 });

  if (now < resetToday) {
    return resetToday.minus({ days: 1 }).toISODate()!;
  }
  return resetToday.toISODate()!;
}

// ---------------------------------------------------------------------------
// isFirstDayGrace — first-day 24h streak grace (spec §4.8)
//
// A processed day is unpunishable (no build cancel, no asteroid, no freeze
// burn) when the reset boundary that ends it comes less than 24h after the
// group was created — day 1 always gets a full 24 hours regardless of what
// time of day the city was founded.
// ---------------------------------------------------------------------------

export function isFirstDayGrace(
  createdAtIso: string,
  processingDate: string,
  goalResetTime: string,
  goalResetTimezone: string = "UTC",
): boolean {
  const tz = resolveZone(goalResetTimezone);
  const [hour, minute] = goalResetTime.split(":").map(Number);
  // Day `D` ends at the reset time on D+1 in the group's timezone.
  const boundary = DateTime.fromISO(processingDate, { zone: tz })
    .plus({ days: 1 })
    .set({ hour, minute, second: 0, millisecond: 0 });
  const created = DateTime.fromISO(createdAtIso);
  if (!created.isValid || !boundary.isValid) return false;
  return boundary.diff(created, "hours").hours < 24;
}


// ---------------------------------------------------------------------------
// Park damage — a park is hit as ONE unit, but damaged in PART
// ---------------------------------------------------------------------------
//
// A park counts as one build however many cells it covers, so it enters the
// meteor's lottery once, weighted by its day cost like everything else. But
// flattening nine or fifteen cells for a single hit would make one unlucky
// roll cost more than a week of work, so a hit scorches a FRACTION of the
// park instead — the same 20% the meteor takes off the city as a whole.
//
// That is also why parks could not simply be added to the tile pool: a
// 15-cell park would then attract fifteen times a house's attention and be
// obliterated long before the neighbourhood around it.

/** Footprint for a park's cell count. Both are three deep. */
function parkShape(cells: number): { rows: number; cols: number } {
  return cells === 15 ? { rows: 3, cols: 5 } : { rows: 3, cols: 3 };
}

/** The catalog id behind a park's footprint, for day-cost weighting. */
function parkTypeForCells(cells: number): string {
  return cells === 15 ? "park_large" : "park_small";
}

export const PARK_DAMAGE_FRACTION = 0.2;

/**
 * Damage one park. Intact cells are scorched first (level 1); once the whole
 * park is scorched, further hits crater what is already burnt (level 2).
 *
 * Deterministic in COUNT but not in placement — the cells are chosen by the
 * same weighted draw the rest of destruction uses, so two crews never lose
 * the identical corner.
 */
export function damagePark(
  cells: number,
  damage: Record<string, 1 | 2>,
): Record<string, 1 | 2> {
  const { rows, cols } = parkShape(cells);
  const total = rows * cols;
  const nHit = Math.max(1, Math.ceil(total * PARK_DAMAGE_FRACTION));

  const intact: string[] = [];
  const scorched: string[] = [];
  for (let i = 0; i < total; i++) {
    const key = String(i);
    if (damage[key] === undefined) intact.push(key);
    else if (damage[key] === 1) scorched.push(key);
  }

  const next: Record<string, 1 | 2> = { ...damage };
  // Escalate only once nothing is left to scorch, so damage spreads across
  // the park before it deepens anywhere.
  const pool = intact.length > 0 ? intact : scorched;
  const level: 1 | 2 = intact.length > 0 ? 1 : 2;
  for (let i = 0; i < nHit && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    next[pool[idx]] = level;
    pool.splice(idx, 1);
  }
  return next;
}

// ---------------------------------------------------------------------------
// findEmptyTiles — dimension-agnostic, mirrors Python `_find_empty_tiles`
// ---------------------------------------------------------------------------

export function findEmptyTiles(cityMap: CityMap): number[][] {
  const tiles: number[][] = [];
  for (const [rStr, row] of Object.entries(cityMap)) {
    const r = parseInt(rStr, 10);
    for (let c = 0; c < row.length; c++) {
      if (row[c] === null || row[c] === "rubble") {
        tiles.push([r, c]);
      }
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// rowMajorBuildOrder — the slot order a city rendered in BEFORE `build_order`
// existed: every built cell (rubble included — a levelled lot is still a
// slot) in row-major order. This is what a missing `build_order` means, so
// stamping it onto an old doc changes nothing on screen.
// ---------------------------------------------------------------------------

export function rowMajorBuildOrder(cityMap: CityMap): string[] {
  const keys: string[] = [];
  const rows = Object.keys(cityMap)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const r of rows) {
    const row = cityMap[String(r)];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== null && row[c] !== undefined) keys.push(`${r},${c}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// findOccupiedTiles — dimension-agnostic, mirrors Python `_find_occupied_tiles`
// ---------------------------------------------------------------------------

export function findOccupiedTiles(
  cityMap: CityMap,
): { row: number; col: number; type: string }[] {
  const tiles: { row: number; col: number; type: string }[] = [];
  for (const [rStr, row] of Object.entries(cityMap)) {
    const r = parseInt(rStr, 10);
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      // Any known build, current vocabulary or legacy — NOT a hard-coded list
      // of the three v1.0 type names. That list silently excluded every
      // catalog id, which made cities built with the new vocabulary immune to
      // both the meteor and the missed-day asteroid: nothing counted as
      // occupied, so nothing could be destroyed. `null` and `"rubble"` are
      // correctly excluded because neither is a build.
      if (typeof cell === "string" && isKnownBuild(cell)) {
        tiles.push({ row: r, col: c, type: cell });
      }
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Weighted random selection — equivalent to Python's random.choices(k=1)
// ---------------------------------------------------------------------------

function weightedChoice<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// destroyBuildings — pick `count` occupied tiles (weighted: houses likelier
// than skyscrapers), turn them to rubble. Shared by the missed-day asteroid
// and the inactivity meteor.
// ---------------------------------------------------------------------------

function destroyBuildings(
  cityMap: CityMap,
  count: number,
): {
  map: CityMap;
  tiles: Array<{ row: number; col: number }>;
  /** "row,col" → the type that stood there, so a repair can restore it. */
  origins: Record<string, string>;
} {
  const occupied = findOccupiedTiles(cityMap);
  const remaining = [...occupied];
  const remainingWeights = remaining.map((t) => destroyWeight(t.type));
  const picked: Array<{ row: number; col: number }> = [];

  const n = Math.min(count, remaining.length);
  for (let i = 0; i < n; i++) {
    const pickedIdx = weightedChoice(
      remaining.map((_, j) => j),
      remainingWeights,
    );
    picked.push({ row: remaining[pickedIdx].row, col: remaining[pickedIdx].col });
    remaining.splice(pickedIdx, 1);
    remainingWeights.splice(pickedIdx, 1);
  }

  const newMap: CityMap = Object.fromEntries(
    Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
  );
  // Record the type BEFORE overwriting it — this is the only moment it still
  // exists. `newMap[row][col] = "rubble"` is otherwise a one-way door.
  const origins: Record<string, string> = {};
  for (const { row, col } of picked) {
    const was = newMap[row][col];
    if (typeof was === "string" && was !== "rubble") {
      origins[`${row},${col}`] = was;
    }
    newMap[row][col] = "rubble";
  }
  return { map: newMap, tiles: picked, origins };
}

function makeEventId(): string {
  return `evt_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// landBuild — the moment a build becomes a building
//
// Pure. Used by `completeGoal` the instant the last ACTIVE crew member
// finishes the final day of a build (landing is immediate, 2026-09-10), and
// by `processEndOfDay` as the fallback for a day that became all-complete
// without a completeGoal call (a roster change or a pause after the last
// completion). `landedOn` is the GAME-DAY label the crew completed on — the
// same label `completeGoal` writes to the proof ledger, so a building's
// stored date opens the right day's proof.
//
// Returns null when there is no empty tile to land on (the caller still
// clears `current_build`).
// ---------------------------------------------------------------------------

export interface LandBuildParams {
  currentBuild: CurrentBuild;
  cityMap: CityMap;
  parks: Park[];
  buildOrder: string[] | null;
  tileBuildDates: Record<string, string>;
  rubbleOrigins: Record<string, string>;
  streakFreezes: number;
  landedOn: string;
  nowIso: string;
}

export interface LandBuildResult {
  current_build: null;
  pending_event: PendingEvent;
  streak_freezes: number;
  city_map?: CityMap;
  build_order?: string[];
  parks?: Park[];
  tile_build_dates?: Record<string, string>;
  rubble_origins?: Record<string, string>;
}

export function landBuild(p: LandBuildParams): LandBuildResult | null {
  const { currentBuild, cityMap, parks, tileBuildDates, rubbleOrigins, landedOn, nowIso } = p;
  const freezes = Math.min(FREEZE_CAP, p.streakFreezes + 1);

  // A park restoration clears that park's damage in place. Checked before the
  // footprint branch, because a restoration carries the park's own catalog id
  // as its type and would otherwise found a second park.
  if (currentBuild.target_park != null) {
    const targetId = currentBuild.target_park;
    const found = parks.some((pk) => pk.park_id === targetId);
    return {
      current_build: null,
      // A park that vanished mid-restoration leaves nothing to fix; the build
      // still completes rather than wedging the slot.
      ...(found
        ? { parks: parks.map((pk) => (pk.park_id === targetId ? { ...pk, damage: {} } : pk)) }
        : {}),
      pending_event: {
        event_id: makeEventId(),
        type: "build_complete",
        building: currentBuild.type,
        tile: [0, 0],
        restored: true,
        timestamp: nowIso,
      },
      streak_freezes: freezes,
    };
  }

  const footprint = parkFootprint(currentBuild.type);

  if (footprint) {
    // A park takes no `city_map` cell at all — it's recorded beside the grid
    // so slot indices and the buildings count stay correct, and the CLIENT
    // places it, because only the client knows the block plan that turns
    // slots into positions (see parks.ts).
    const park: Park = {
      park_id: makeParkId(),
      cells: (footprint.rows * footprint.cols) as 9 | 15,
      // Anchors the park in the block sequence — see parks.ts. Counted from
      // the grid the same way the client counts slots.
      built_at_buildings: findOccupiedTiles(cityMap).length,
      damage: {},
      built_on: landedOn,
    };
    return {
      current_build: null,
      parks: [...parks, park],
      pending_event: {
        event_id: makeEventId(),
        type: "build_complete",
        building: currentBuild.type,
        tile: [0, 0],
        timestamp: nowIso,
      },
      streak_freezes: freezes,
    };
  }

  // Building — on the repair's own lot if it has one, otherwise a random
  // empty/rubble tile. A repair that landed anywhere else would break the
  // only promise tapping a ruin makes.
  const empty = findEmptyTiles(cityMap);
  if (empty.length === 0) return null;
  const target = currentBuild.target_tile;
  const targetFree =
    target != null && empty.some(([r, c]) => r === target.row && c === target.col);
  // If the target got built on while the repair was in flight, fall back to
  // a normal landing rather than dropping the build.
  const tile = targetFree ? [target!.row, target!.col] : empty[Math.floor(Math.random() * empty.length)];
  const key = `${tile[0]},${tile[1]}`;

  const newMap: CityMap = Object.fromEntries(
    Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
  );
  newMap[tile[0]][tile[1]] = currentBuild.type;

  const result: LandBuildResult = {
    current_build: null,
    city_map: newMap,
    tile_build_dates: { ...tileBuildDates, [key]: landedOn },
    pending_event: {
      event_id: makeEventId(),
      type: "build_complete",
      building: currentBuild.type,
      tile,
      ...(targetFree ? { restored: true } : {}),
      timestamp: nowIso,
    },
    streak_freezes: freezes,
  };
  // The landing's SLOT is its place in `build_order`, never its grid cell. A
  // repair lands on a lot that is already listed (rubble keeps its entry), so
  // it stays put; anything else is appended — the growth frontier.
  const order = p.buildOrder ?? rowMajorBuildOrder(cityMap);
  if (!order.includes(key)) result.build_order = [...order, key];
  // Something stands here again, so the lot is no longer a ruin awaiting
  // repair — drop it from the ledger.
  if (rubbleOrigins[key] !== undefined) {
    const next = { ...rubbleOrigins };
    delete next[key];
    result.rubble_origins = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// processEndOfDay
//
// Pure function: returns a dict of fields to update on the group document.
// Does NOT modify inputs.
//
// `processingDate` is the "YYYY-MM-DD" that this pass is processing — i.e.
// the day that just ended in the group's local timezone. Passed in from the
// caller so that `last_processed_date` and `building_completions` entries
// are guaranteed to use the same day boundary.
//
// Semantics (2026-07-08, game modes 2026-09-10):
// - A day is "successful" per the city's game mode (gameMode.dayShare): in
//   hard mode when ALL active members completed, in easy mode when ANY did —
//   and in easy mode the build advances by the completed fraction of the
//   roster rather than a whole day. Everything below keys off that one flag.
// - Every successful day is logged in
//   `building_completions`, whether the active build landed or merely
//   advanced — so the streak keeps climbing through multi-day builds.
//   (Before this change only landing days were logged, which dropped the
//   visible streak to 0 mid-apartment/skyscraper and would have made streak
//   freezes auto-burn during every multi-day build.)
// - Missed gap days that would break a positive streak consume freezes
//   (one per day) and are recorded in `frozen_dates`. When freezes run out
//   the break is recorded in `broken_streak` for the repair callable.
// - Missing a day of an active build stops the build but does NOT damage
//   the city (2026-07-28): it moves to `abandoned_build` and can be resumed
//   with a streak freeze on the following day via `applyBuildRescue`.
// - `lastActivityDate` ≥ INACTIVITY_METEOR_DAYS ago fires the inactivity
//   meteor regardless of `current_build`, at most once per
//   INACTIVITY_METEOR_DAYS (lazy processing may batch many absent days
//   into a single pass). This is the only path that destroys buildings.
// - `isGraceDay` (first-day 24h grace) suppresses every punishment; positive
//   progress still counts.
// ---------------------------------------------------------------------------

export function processEndOfDay(params: {
  groupMembers: string[];
  completionsToday: string[];
  currentBuild: CurrentBuild | null;
  abandonedBuild?: AbandonedBuild | null;
  cityMap: CityMap;
  parks?: Park[] | null;
  streak: number; // legacy param — recomputed below; kept for caller compat
  buildingCompletions: string[];
  processingDate: string;
  lastActivityDate?: string | null;
  streakFreezes?: number;
  frozenDates?: string[];
  brokenStreak?: BrokenStreak | null;
  lastInactivityMeteorDate?: string | null;
  isGraceDay?: boolean;
  tileBuildDates?: Record<string, string>;
  /** "row,col" → the type levelled there, for repairs. */
  rubbleOrigins?: Record<string, string>;
  /** See GroupDoc.build_order. Undefined → derived row-major from the map. */
  buildOrder?: string[] | null;
  /** Vacation mode. All optional: absent = nobody paused, so every caller
   *  and test written before the feature behaves exactly as it did. */
  memberUids?: string[];
  memberPauses?: MemberPauses | null;
  cityPause?: PauseRange | null;
  pausedDates?: string[];
  /** How the day counts. Absent = hard, so every caller and test written
   *  before the feature behaves exactly as it did. */
  gameMode?: GameMode;
  nearMissDates?: string[];
}): EndOfDayUpdates {
  const {
    groupMembers,
    completionsToday,
    currentBuild,
    abandonedBuild = null,
    cityMap,
    parks: parksIn = [],
    buildingCompletions,
    processingDate,
    lastActivityDate = null,
    streakFreezes = 0,
    frozenDates = [],
    brokenStreak = null,
    lastInactivityMeteorDate = null,
    isGraceDay = false,
    tileBuildDates = {},
    rubbleOrigins = {},
    buildOrder,
    memberUids = [],
    memberPauses = null,
    cityPause = null,
    pausedDates = [],
    gameMode = "hard",
    nearMissDates = [],
  } = params;

  const updates: EndOfDayUpdates = {
    completions_today: [],
  };
  const parks: Park[] = parksIn ?? [];

  const nowIso = new Date().toISOString();

  const newCompletions = [...buildingCompletions];
  const newFrozen = [...frozenDates];
  // Per-tile build dates — mutated as buildings land / get destroyed, and
  // flushed to `updates` at the end only if it changed.
  const newBuildDates: Record<string, string> = { ...tileBuildDates };
  let buildDatesChanged = false;
  let freezes = streakFreezes;
  let broken: BrokenStreak | null = brokenStreak;

  // --- Vacation mode: who counts today, and which days were paused ---
  // The roster for the day is the ACTIVE members: someone on vacation is not
  // asked to complete, and their absence is the only one that is free. A day
  // with nobody active (an explicit city pause, or everyone away) is a paused
  // day: neither won nor lost, nothing advances, nothing falls.
  //
  // LABELS. A pass with processing date P settles the game day that just
  // ended — the one labelled P−1 by `getProcessingDate` while it was running
  // (with a midnight reset, the first touch on the 9th settles the 8th's
  // completions). Pauses are stored in those GAME-DAY labels, because that is
  // the "today" completeGoal and the callables see. Everything this pass
  // writes (`building_completions`, `frozen_dates`, `paused_dates`) is in
  // SETTLEMENT labels, one day later — so a paused game day G lands in
  // `paused_dates` as G+1, the same label space the streak bridges over.
  const roster: Roster = { members: groupMembers, memberUids, memberPauses, cityPause };
  const settledGameDay = addDays(processingDate, -1);
  const activeMembers = activeMembersOn(roster, settledGameDay);
  const dayPaused = isDayPaused(roster, settledGameDay);
  // Lazy processing settles the whole gap since the last pass, so every paused
  // day up to the one being settled is recorded now. Append-only, deduped.
  const newPaused = [...pausedDates];
  for (const g of pausedDaysThrough(roster, settledGameDay)) {
    const label = addDays(g, 1);
    if (!newPaused.includes(label)) newPaused.push(label);
  }

  const completionsSet = new Set(completionsToday);
  const completedActive = activeMembers.filter((m) => completionsSet.has(m)).length;
  // --- Game mode: how much of the day the roster banked ---
  // Hard: 1 when everyone completed, else 0. Easy: each completion is a share
  // of the day (gameMode.dayShare). Either way, a share of 0 is a missed day
  // and everything below that punishes a miss keys off `daySuccessful`.
  const share = dayPaused ? 0 : dayShare(gameMode, completedActive, activeMembers.length);
  const daySuccessful = share > 0;
  // Hard mode's near miss: someone finished, not everyone. The one day easy
  // mode would have banked — counted so the app can suggest the switch.
  const nearMiss =
    gameMode === "hard" && !dayPaused && !isGraceDay && !daySuccessful && completedActive > 0;
  const newNearMisses = pruneNearMisses(
    nearMiss ? [...nearMissDates, processingDate] : nearMissDates,
    processingDate,
  );
  if (
    newNearMisses.length !== nearMissDates.length ||
    newNearMisses.some((d, i) => d !== nearMissDates[i])
  ) {
    updates.near_miss_dates = newNearMisses;
  }

  // Inactivity meteor decision — made up front because it supersedes the
  // standard missed-day asteroid when both would fire in the same pass.
  //
  // The idle clock does not run through a paused day: it restarts from the
  // last one. Only once the clock has ever started (a city with no activity
  // on record stays un-meteorable, as before) — and only city-paused days
  // park it, because a member-only vacation leaves a crew that can still go
  // idle.
  const pDayNum = parseYmd(processingDate);
  const lastPausedNum = newPaused
    .map(parseYmd)
    .filter((d) => d <= pDayNum)
    .reduce<number | null>((a, d) => (a === null || d > a ? d : a), null);
  let idleFrom = lastActivityDate;
  if (idleFrom !== null && lastPausedNum !== null && lastPausedNum > parseYmd(idleFrom)) {
    idleFrom = formatYmd(lastPausedNum);
    updates.last_activity_date = idleFrom;
  }
  const idleDays = idleFrom !== null ? daysBetween(idleFrom, processingDate) : null;
  const meteorDue =
    !isGraceDay &&
    !dayPaused &&
    !daySuccessful &&
    idleDays !== null &&
    idleDays >= INACTIVITY_METEOR_DAYS &&
    (lastInactivityMeteorDate === null ||
      daysBetween(lastInactivityMeteorDate, processingDate) >= INACTIVITY_METEOR_DAYS);

  // --- Build progression / standard asteroid ---
  if (currentBuild !== null) {
    if (daySuccessful) {
      // Snapped, so three thirds land as exactly one day (see gameMode.ts).
      const newDays = snapProgress(currentBuild.days_completed + share);

      if (isBuildFinished(newDays, currentBuild.days_required)) {
        // Fallback landing: `completeGoal` lands immediately, so this only
        // runs when the day became all-complete without a completion call
        // (roster change / pause). The tile is stamped with the game day the
        // crew completed on, matching what completeGoal would have written.
        const landed = landBuild({
          currentBuild,
          cityMap,
          parks,
          buildOrder: buildOrder ?? null,
          tileBuildDates: newBuildDates,
          rubbleOrigins,
          streakFreezes: freezes,
          landedOn: settledGameDay,
          nowIso,
        });
        if (landed) {
          if (landed.city_map) updates.city_map = landed.city_map;
          if (landed.build_order) updates.build_order = landed.build_order;
          if (landed.parks) updates.parks = landed.parks;
          if (landed.tile_build_dates) {
            Object.assign(newBuildDates, landed.tile_build_dates);
            buildDatesChanged = true;
          }
          if (landed.rubble_origins) updates.rubble_origins = landed.rubble_origins;
          updates.pending_event = landed.pending_event;
          freezes = landed.streak_freezes;
        }
        updates.current_build = null;
      } else {
        // Build advances
        updates.current_build = {
          ...currentBuild,
          days_completed: newDays,
        };
      }
    } else if (isGraceDay || dayPaused) {
      // First-day grace, or a paused day: keep the build, no punishment.
    } else if (meteorDue) {
      // ≥7 idle days is abandonment, not a slip: the build is simply gone
      // and the meteor (below) does the talking. No rescue offer.
      updates.current_build = null;
    } else {
      // Missed a day of the build. The city is NOT damaged — the build is
      // lifted into `abandoned_build`, rescuable with a freeze for one day.
      updates.current_build = null;
      updates.abandoned_build = {
        type: currentBuild.type,
        days_required: currentBuild.days_required,
        days_completed: currentBuild.days_completed,
        abandoned_on: processingDate,
        // A stalled restoration stays a restoration through a rescue.
        ...(currentBuild.target_tile ? { target_tile: currentBuild.target_tile } : {}),
        ...(currentBuild.target_park ? { target_park: currentBuild.target_park } : {}),
      };
    }
  }

  // An older rescue offer has outlived its window (it was only good for the
  // single day after `abandoned_on`, and we are now settling a later day).
  if (
    updates.abandoned_build === undefined &&
    abandonedBuild &&
    abandonedBuild.abandoned_on !== processingDate
  ) {
    updates.abandoned_build = null;
  }

  // --- Log the successful day (landing or not) ---
  if (daySuccessful && !newCompletions.includes(processingDate)) {
    newCompletions.push(processingDate);
  }

  // --- Inactivity meteor ---
  if (meteorDue) {
    const mapNow = updates.city_map ?? cityMap;
    const occupied = findOccupiedTiles(mapNow);
    // Parks are part of the city, so they count toward "20% of what you
    // built" and can absorb hits. Leaving them out made a crew that built
    // parks strictly harder to hurt — the more green space, the less there
    // was to lose, which inverts the whole risk the game runs on.
    const builds = occupied.length + parks.length;
    if (builds > 0) {
      const nDestroy = Math.min(
        INACTIVITY_DESTROY_MAX,
        Math.max(1, Math.ceil(builds * INACTIVITY_DESTROY_FRACTION)),
      );
      // One lottery over both, so a hit lands on whatever it lands on. A park
      // enters ONCE (weighted by its day cost, like any build) and is damaged
      // in part when picked — see `damagePark`.
      const parkPicks = new Set<string>();
      const parkEntries = parks.map((pk) => ({
        parkId: pk.park_id,
        weight: destroyWeight(parkTypeForCells(pk.cells)),
      }));
      const tileWeight = occupied.reduce((a, t) => a + destroyWeight(t.type), 0);
      const parkWeight = parkEntries.reduce((a, e) => a + e.weight, 0);
      // How many of the N hits land on parks, in expectation. Resolved up
      // front so the tile draw below stays exactly what it was.
      let parkHits = 0;
      for (let i = 0; i < nDestroy; i++) {
        if (parkWeight > 0 && Math.random() * (tileWeight + parkWeight) >= tileWeight) {
          parkHits++;
        }
      }
      const remainingParks = [...parkEntries];
      for (let i = 0; i < parkHits && remainingParks.length > 0; i++) {
        const total = remainingParks.reduce((a, e) => a + e.weight, 0);
        let r = Math.random() * total;
        let idx = 0;
        for (; idx < remainingParks.length; idx++) {
          r -= remainingParks[idx].weight;
          if (r <= 0) break;
        }
        const chosen = remainingParks[Math.min(idx, remainingParks.length - 1)];
        parkPicks.add(chosen.parkId);
        remainingParks.splice(remainingParks.indexOf(chosen), 1);
      }
      if (parkPicks.size > 0) {
        updates.parks = parks.map((pk) =>
          parkPicks.has(pk.park_id)
            ? { ...pk, damage: damagePark(pk.cells, pk.damage ?? {}) }
            : pk,
        );
      }
      const nTiles = Math.max(0, nDestroy - parkHits);
      const { map, tiles, origins } = destroyBuildings(mapNow, nTiles);
      updates.city_map = map;
      // Remember what stood on each levelled lot so it can be rebuilt. Merged
      // over any existing ledger: earlier ruins stay repairable.
      updates.rubble_origins = { ...rubbleOrigins, ...origins };
      for (const t of tiles) {
        delete newBuildDates[`${t.row},${t.col}`];
        buildDatesChanged = true;
      }
      updates.pending_event = {
        event_id: makeEventId(),
        type: "asteroid",
        cause: "inactivity",
        tiles_destroyed: tiles,
        timestamp: nowIso,
      };
    }
    // Stamp even when there was nothing to destroy so an idle-but-empty
    // group doesn't get re-checked (and instantly meteored) every pass.
    updates.last_inactivity_meteor_date = processingDate;
  }

  // --- Streak freeze consumption / break recording ---
  // Gap = days between the last active (successful or frozen) day and the
  // processed day. Lazy processing can batch several absent days into one
  // pass, so the whole gap is settled here: freeze it all or break.
  //
  // Paused days are bridge days but NOT "active" days here: the gap is
  // measured from the last completed-or-frozen day, and the paused days
  // inside it are simply not counted as missed. That is what settles days
  // genuinely missed BEFORE a pause (they still cost a freeze or break the
  // chain) while the pause itself costs nothing — and it runs on a paused
  // processing day too, for exactly that reason.
  if (!isGraceDay) {
    const activeDayNums = [
      ...new Set([...newCompletions, ...newFrozen].map(parseYmd)),
    ];
    const pausedNums = new Set(newPaused.map(parseYmd));
    const pDay = pDayNum;
    const before = activeDayNums.filter((d) => d < pDay);
    if (before.length > 0) {
      const lastActive = Math.max(...before);
      const missed: number[] = []; // days lastActive+1 .. pDay-1, minus paused
      for (let d = lastActive + 1; d <= pDay - 1; d++) {
        if (!pausedNums.has(d)) missed.push(d);
      }
      if (missed.length > 0) {
        const preStreak = computeStreakWithFreezes(
          newCompletions,
          bridgeDates(newFrozen, newPaused),
          formatYmd(lastActive),
        );
        if (preStreak > 0) {
          if (freezes >= missed.length) {
            for (const d of missed) {
              const ds = formatYmd(d);
              if (!newFrozen.includes(ds)) newFrozen.push(ds);
            }
            freezes -= missed.length;
          } else {
            // Not enough freezes — the streak breaks, but keep a repairable
            // record. Don't burn a partial stock that can't save the chain.
            // The chain factually died the first day the yesterday-anchor
            // failed (the day after the first missed one), which may be well
            // before this pass when lazy processing batches a long absence —
            // only record breaks still inside the repair window.
            const brokenOnDay = missed[0] + 1;
            if (pDay - brokenOnDay <= REPAIR_WINDOW_DAYS) {
              broken = {
                value: preStreak,
                broken_on: formatYmd(brokenOnDay),
                last_active_date: formatYmd(lastActive),
              };
            }
          }
        }
      }
    }
  }

  // Single source of truth for streak: derive from the (possibly
  // appended-to) completions log + frozen bridge days, relative to the day
  // we just processed.
  updates.building_completions = newCompletions;
  updates.streak_freezes = freezes;
  updates.frozen_dates = newFrozen;
  updates.paused_dates = newPaused;
  updates.broken_streak = broken;
  updates.streak = computeStreakWithFreezes(
    newCompletions,
    bridgeDates(newFrozen, newPaused),
    processingDate,
  );
  if (buildDatesChanged) {
    updates.tile_build_dates = newBuildDates;
  }
  return updates;
}

// ---------------------------------------------------------------------------
// isRescuableBuild — is this stalled build still resumable today?
//
// The offer stands only on the day right after the missed day, and only
// while no other build has been started. Mirrored client-side in
// `mobile/src/utils/streak.ts` (parity-tested) so the app can show the
// prompt without a round-trip. Freeze stock is checked separately: the
// prompt still appears at zero freezes, it just says the build is lost.
// ---------------------------------------------------------------------------

export function isRescuableBuild(
  abandonedBuild: AbandonedBuild | null | undefined,
  currentBuild: CurrentBuild | null | undefined,
  todayStr: string,
): boolean {
  if (!abandonedBuild) return false;
  if (currentBuild) return false;
  const age = daysBetween(abandonedBuild.abandoned_on, todayStr);
  return age >= 0 && age <= BUILD_RESCUE_WINDOW_DAYS;
}

// ---------------------------------------------------------------------------
// applyBuildRescue — spend one streak freeze to resume a stalled build
//
// Returns the fields to write, or null when there is nothing to rescue
// (no record, window passed, another build already running) or the group
// holds no freezes. Progress is preserved exactly: `days_completed` is
// untouched, so the crew gets a fresh shot at the day they missed.
//
// The freeze covers the STREAK for the missed day too. The missed day's
// label (`abandoned_on`) is not in `frozen_dates` yet — the pass that stalls
// the build only settles gap days before it, and charges that label on the
// NEXT pass (see the freeze-consumption block in processEndOfDay). Without
// recording it here, one miss cost two freezes (rescue today, auto-burn
// tomorrow), or broke the streak the morning after the crew spent their last
// freeze "saving" it. One freeze, one missed day, both the build and the
// chain kept — which is what the rescue sheet promises.
// ---------------------------------------------------------------------------

export function applyBuildRescue(params: {
  abandonedBuild: AbandonedBuild | null;
  currentBuild: CurrentBuild | null;
  streakFreezes: number;
  /** Absent only in older callers; the missed day is still frozen from an
   *  empty list. */
  frozenDates?: string[];
  todayStr: string;
}): {
  current_build: CurrentBuild;
  abandoned_build: null;
  streak_freezes: number;
  frozen_dates: string[];
} | null {
  const { abandonedBuild, currentBuild, streakFreezes, frozenDates = [], todayStr } = params;
  if (!isRescuableBuild(abandonedBuild, currentBuild, todayStr)) return null;
  if (streakFreezes < 1) return null;

  const missed = abandonedBuild!.abandoned_on;
  const frozen = frozenDates.includes(missed) ? [...frozenDates] : [...frozenDates, missed];

  return {
    current_build: {
      type: abandonedBuild!.type,
      days_required: abandonedBuild!.days_required,
      days_completed: abandonedBuild!.days_completed,
      ...(abandonedBuild!.target_tile ? { target_tile: abandonedBuild!.target_tile } : {}),
      ...(abandonedBuild!.target_park ? { target_park: abandonedBuild!.target_park } : {}),
    },
    abandoned_build: null,
    streak_freezes: streakFreezes - 1,
    frozen_dates: frozen,
  };
}

// ---------------------------------------------------------------------------
// applyStreakRepair — one-tap repair of a recently broken streak
//
// Retroactively freezes the gap days from the break's `last_active_date`
// through `todayStr` (the current day label in the group's timezone),
// reconnecting the old chain. Free, one shot per break — the record is
// cleared on use. Returns null when there is nothing repairable (no record,
// or the break is older than REPAIR_WINDOW_DAYS).
//
// Through TODAY, inclusive, not yesterday. `todayStr` is a settlement label:
// the pass that just ran settled the game day before it under that label,
// and if that day was missed too (the usual case — you notice the break the
// morning after) the label is a hole the next pass would charge again,
// re-breaking a streak that visibly read as repaired. A label the crew
// actually completed is skipped, as are paused days.
// ---------------------------------------------------------------------------

export function applyStreakRepair(params: {
  buildingCompletions: string[];
  frozenDates: string[];
  /** Paused days already bridge the chain; a repair must not re-label them
   *  as spent freezes. */
  pausedDates?: string[];
  brokenStreak: BrokenStreak | null;
  todayStr: string;
}): {
  frozen_dates: string[];
  streak: number;
  broken_streak: null;
} | null {
  const { buildingCompletions, frozenDates, pausedDates = [], brokenStreak, todayStr } = params;
  if (!brokenStreak) return null;
  if (daysBetween(brokenStreak.broken_on, todayStr) > REPAIR_WINDOW_DAYS) {
    return null;
  }

  const lastActive = parseYmd(brokenStreak.last_active_date);
  const today = parseYmd(todayStr);
  const frozen = [...frozenDates];
  for (let d = lastActive + 1; d <= today; d++) {
    const ds = formatYmd(d);
    if (
      !frozen.includes(ds) &&
      !pausedDates.includes(ds) &&
      !buildingCompletions.includes(ds)
    ) {
      frozen.push(ds);
    }
  }

  return {
    frozen_dates: frozen,
    streak: computeStreakWithFreezes(
      buildingCompletions,
      bridgeDates(frozen, pausedDates),
      todayStr,
    ),
    broken_streak: null,
  };
}
