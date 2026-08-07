import { v4 as uuidv4 } from "uuid";
import { Park, makeParkId, parkFootprint } from "./parks";
import { DateTime } from "luxon";
import { daysFor, isKnownBuild } from "./buildCatalog";

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
  days_completed: number;
  /**
   * Land this build on THIS lot instead of a random one.
   *
   * Set only by a repair: the whole promise of tapping a ruin is that the
   * building comes back where it stood. An ordinary build leaves this unset
   * and still lands wherever the city has room.
   */
  target_tile?: { row: number; col: number };
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
  /** Parks, recorded outside `city_map` — absent on cities that predate them. */
  parks?: Park[] | null;
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
  parks?: Park[];
  current_build?: CurrentBuild | null;
  abandoned_build?: AbandonedBuild | null;
  streak?: number;
  streak_freezes?: number;
  frozen_dates?: string[];
  broken_streak?: BrokenStreak | null;
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
// Semantics (2026-07-08):
// - Every day on which ALL members completed the goal is logged in
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

  const membersSet = new Set(groupMembers);
  const completionsSet = new Set(completionsToday);
  const daySuccessful =
    groupMembers.length > 0 &&
    completionsToday.length > 0 &&
    [...membersSet].every((m) => completionsSet.has(m));

  // Inactivity meteor decision — made up front because it supersedes the
  // standard missed-day asteroid when both would fire in the same pass.
  const idleDays =
    lastActivityDate !== null ? daysBetween(lastActivityDate, processingDate) : null;
  const meteorDue =
    !isGraceDay &&
    !daySuccessful &&
    idleDays !== null &&
    idleDays >= INACTIVITY_METEOR_DAYS &&
    (lastInactivityMeteorDate === null ||
      daysBetween(lastInactivityMeteorDate, processingDate) >= INACTIVITY_METEOR_DAYS);

  // --- Build progression / standard asteroid ---
  if (currentBuild !== null) {
    if (daySuccessful) {
      const newDays = currentBuild.days_completed + 1;

      if (newDays >= currentBuild.days_required) {
        const footprint = parkFootprint(currentBuild.type);

        if (footprint) {
          // A park takes no `city_map` cell at all — it's recorded beside the
          // grid so slot indices and the buildings count stay correct, and the
          // CLIENT places it, because only the client knows the block plan
          // that turns slots into positions (see parks.ts).
          const park: Park = {
            park_id: makeParkId(),
            cells: (footprint.rows * footprint.cols) as 9 | 15,
            // Anchors the park in the block sequence — see parks.ts. Counted
            // from the grid the same way the client counts slots.
            built_at_buildings: findOccupiedTiles(cityMap).length,
            damage: {},
            built_on: processingDate,
          };
          updates.parks = [...parks, park];
          updates.pending_event = {
            event_id: makeEventId(),
            type: "build_complete",
            building: currentBuild.type,
            tile: [0, 0],
            timestamp: nowIso,
          };
          freezes = Math.min(FREEZE_CAP, freezes + 1);
          updates.current_build = null;
        } else {
        // Building complete — place on the repair's own lot if it has one,
        // otherwise a random empty/rubble tile. A repair that landed anywhere
        // else would break the only promise tapping a ruin makes.
        const empty = findEmptyTiles(cityMap);
        const target = currentBuild.target_tile;
        const targetFree =
          target != null &&
          empty.some(([r, c]) => r === target.row && c === target.col);
        if (empty.length > 0) {
          const newMap: CityMap = Object.fromEntries(
            Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
          );
          // If the target got built on while the repair was in flight, fall
          // back to a normal landing rather than dropping the build.
          const tile = targetFree
            ? [target!.row, target!.col]
            : empty[Math.floor(Math.random() * empty.length)];
          newMap[tile[0]][tile[1]] = currentBuild.type;
          updates.city_map = newMap;
          newBuildDates[`${tile[0]},${tile[1]}`] = processingDate;
          buildDatesChanged = true;
          // Something stands here again, so the lot is no longer a ruin
          // awaiting repair — drop it from the ledger.
          if (rubbleOrigins[`${tile[0]},${tile[1]}`] !== undefined) {
            const next = { ...rubbleOrigins };
            delete next[`${tile[0]},${tile[1]}`];
            updates.rubble_origins = next;
          }
          updates.pending_event = {
            event_id: makeEventId(),
            type: "build_complete",
            building: currentBuild.type,
            tile: tile,
            timestamp: nowIso,
          };
          // A landing earns a streak freeze (capped)
          freezes = Math.min(FREEZE_CAP, freezes + 1);
        }
        updates.current_build = null;
        }
      } else {
        // Build advances
        updates.current_build = {
          ...currentBuild,
          days_completed: newDays,
        };
      }
    } else if (isGraceDay) {
      // First-day grace: keep the build, no punishment.
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
  if (!isGraceDay) {
    const activeDayNums = [
      ...new Set([...newCompletions, ...newFrozen].map(parseYmd)),
    ];
    const pDay = parseYmd(processingDate);
    const before = activeDayNums.filter((d) => d < pDay);
    if (before.length > 0) {
      const lastActive = Math.max(...before);
      const gapLen = pDay - 1 - lastActive; // days lastActive+1 .. pDay-1
      if (gapLen > 0) {
        const preStreak = computeStreakWithFreezes(
          newCompletions,
          newFrozen,
          formatYmd(lastActive),
        );
        if (preStreak > 0) {
          if (freezes >= gapLen) {
            for (let d = lastActive + 1; d <= pDay - 1; d++) {
              const ds = formatYmd(d);
              if (!newFrozen.includes(ds)) newFrozen.push(ds);
            }
            freezes -= gapLen;
          } else {
            // Not enough freezes — the streak breaks, but keep a repairable
            // record. Don't burn a partial stock that can't save the chain.
            // The chain factually died the first day the yesterday-anchor
            // failed (lastActive + 2), which may be well before this pass
            // when lazy processing batches a long absence — only record
            // breaks still inside the repair window.
            const brokenOnDay = lastActive + 2;
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
  updates.broken_streak = broken;
  updates.streak = computeStreakWithFreezes(
    newCompletions,
    newFrozen,
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
// ---------------------------------------------------------------------------

export function applyBuildRescue(params: {
  abandonedBuild: AbandonedBuild | null;
  currentBuild: CurrentBuild | null;
  streakFreezes: number;
  todayStr: string;
}): {
  current_build: CurrentBuild;
  abandoned_build: null;
  streak_freezes: number;
} | null {
  const { abandonedBuild, currentBuild, streakFreezes, todayStr } = params;
  if (!isRescuableBuild(abandonedBuild, currentBuild, todayStr)) return null;
  if (streakFreezes < 1) return null;

  return {
    current_build: {
      type: abandonedBuild!.type,
      days_required: abandonedBuild!.days_required,
      days_completed: abandonedBuild!.days_completed,
    },
    abandoned_build: null,
    streak_freezes: streakFreezes - 1,
  };
}

// ---------------------------------------------------------------------------
// applyStreakRepair — one-tap repair of a recently broken streak
//
// Retroactively freezes the gap days from the break's `last_active_date`
// through yesterday (relative to `todayStr`, the current day in the group's
// timezone), reconnecting the old chain. Free, one shot per break — the
// record is cleared on use. Returns null when there is nothing repairable
// (no record, or the break is older than REPAIR_WINDOW_DAYS).
// ---------------------------------------------------------------------------

export function applyStreakRepair(params: {
  buildingCompletions: string[];
  frozenDates: string[];
  brokenStreak: BrokenStreak | null;
  todayStr: string;
}): {
  frozen_dates: string[];
  streak: number;
  broken_streak: null;
} | null {
  const { buildingCompletions, frozenDates, brokenStreak, todayStr } = params;
  if (!brokenStreak) return null;
  if (daysBetween(brokenStreak.broken_on, todayStr) > REPAIR_WINDOW_DAYS) {
    return null;
  }

  const lastActive = parseYmd(brokenStreak.last_active_date);
  const today = parseYmd(todayStr);
  const frozen = [...frozenDates];
  for (let d = lastActive + 1; d <= today - 1; d++) {
    const ds = formatYmd(d);
    if (!frozen.includes(ds)) frozen.push(ds);
  }

  return {
    frozen_dates: frozen,
    streak: computeStreakWithFreezes(buildingCompletions, frozen, todayStr),
    broken_streak: null,
  };
}
