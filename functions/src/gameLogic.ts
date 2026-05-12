import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";

export const BUILDING_DAYS: Record<string, number> = {
  house: 1,
  apartment: 3,
  skyscraper: 7,
};

// Weights for asteroid targeting (higher = more likely to be hit)
const DESTROY_WEIGHTS: Record<string, number> = {
  house: 3,
  apartment: 2,
  skyscraper: 1,
};

export type CityMap = Record<string, (string | null)[]>;

export interface CurrentBuild {
  type: string;
  days_required: number;
  days_completed: number;
}

export interface PendingEvent {
  event_id: string;
  type: "build_complete" | "asteroid";
  tiles_destroyed?: number[][];
  building?: string;
  tile?: number[];
  timestamp: string;
}

export interface GroupDoc {
  group_id: string;
  group_code: string;
  group_name: string;
  group_members: string[];
  daily_goal: string;
  goal_reset_time: string;
  goal_reset_timezone?: string;
  completions_today: string[];
  streak: number;
  current_build: CurrentBuild | null;
  city_map: CityMap;
  last_processed_date: string | null;
  pending_event: PendingEvent | null;
  building_completions: string[];
  created_at: FirebaseFirestore.Timestamp;
}

export interface EndOfDayUpdates {
  completions_today: string[];
  city_map?: CityMap;
  current_build?: CurrentBuild | null;
  streak?: number;
  pending_event?: PendingEvent;
  building_completions?: string[];
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
// computeStreak — direct TS port of Python `compute_streak`
//
// Streak = consecutive recent days, ending at today or yesterday, on which
// a building was placed in the city. Anything older keeps living in the log
// but doesn't count toward the current run.
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
  if (completionDates.length === 0) return 0;

  // Parse YYYY-MM-DD → days since epoch for integer arithmetic (avoids tz drift)
  const parseYmd = (s: string): number => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };

  const today = parseYmd(todayStr);
  const yesterday = today - 1;

  // Deduplicate and sort descending
  const sortedDesc = Array.from(new Set(completionDates))
    .map(parseYmd)
    .sort((a, b) => b - a);

  if (sortedDesc[0] !== today && sortedDesc[0] !== yesterday) return 0;

  let streak = 1;
  let expected = sortedDesc[0] - 1;
  for (let i = 1; i < sortedDesc.length; i++) {
    if (sortedDesc[i] === expected) {
      streak++;
      expected -= 1;
    } else {
      break;
    }
  }
  return streak;
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
      if (cell === "house" || cell === "apartment" || cell === "skyscraper") {
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
// processEndOfDay — mirrors Python `process_end_of_day`
//
// Pure function: returns a dict of fields to update on the group document.
// Does NOT modify inputs.
//
// `processingDate` is the "YYYY-MM-DD" that this pass is processing — i.e.
// the day that just ended in the group's local timezone. Passed in from the
// caller so that `last_processed_date` and `building_completions` entries
// are guaranteed to use the same day boundary.
// ---------------------------------------------------------------------------

export function processEndOfDay(params: {
  groupMembers: string[];
  completionsToday: string[];
  currentBuild: CurrentBuild | null;
  cityMap: CityMap;
  streak: number; // legacy param — recomputed below; kept for caller compat
  buildingCompletions: string[];
  processingDate: string;
}): EndOfDayUpdates {
  const {
    groupMembers,
    completionsToday,
    currentBuild,
    cityMap,
    buildingCompletions,
    processingDate,
  } = params;

  const updates: EndOfDayUpdates = {
    completions_today: [],
  };

  const nowIso = new Date().toISOString();

  // Streak depends on the current building_completions log regardless of
  // whether a build was active. Compute once at the bottom.
  const newCompletions = [...buildingCompletions];

  // No active build — just clear completions + recompute streak in case
  // time passed and the run expired.
  if (currentBuild === null) {
    updates.building_completions = newCompletions;
    updates.streak = computeStreak(newCompletions, processingDate);
    return updates;
  }

  const membersSet = new Set(groupMembers);
  const completionsSet = new Set(completionsToday);
  const allCompleted = [...membersSet].every((m) => completionsSet.has(m));

  if (allCompleted) {
    const newDays = currentBuild.days_completed + 1;

    if (newDays >= currentBuild.days_required) {
      // Building complete — place on random empty/rubble tile
      const empty = findEmptyTiles(cityMap);
      const newMap: CityMap = Object.fromEntries(
        Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
      );

      if (empty.length > 0) {
        const tileIdx = Math.floor(Math.random() * empty.length);
        const tile = empty[tileIdx];
        newMap[tile[0]][tile[1]] = currentBuild.type;
        updates.city_map = newMap;
        updates.pending_event = {
          event_id: `evt_${uuidv4().replace(/-/g, "").slice(0, 12)}`,
          type: "build_complete",
          building: currentBuild.type,
          tile: tile,
          timestamp: nowIso,
        };
        // Log the landing date — de-dupe for idempotency safety
        if (!newCompletions.includes(processingDate)) {
          newCompletions.push(processingDate);
        }
      }

      updates.current_build = null;
    } else {
      // Build advances; building_completions log is unchanged this day
      updates.current_build = {
        ...currentBuild,
        days_completed: newDays,
      };
    }
  } else {
    // Failed — asteroid
    updates.current_build = null;

    const occupied = findOccupiedTiles(cityMap);
    if (occupied.length > 0) {
      let maxDestroy = Math.min(3, occupied.length - 1);
      if (maxDestroy < 1) {
        maxDestroy = occupied.length > 1 ? 1 : 0;
      }

      if (maxDestroy > 0) {
        const nDestroy = Math.floor(Math.random() * maxDestroy) + 1;
        const actualDestroy = Math.min(nDestroy, occupied.length - 1);

        if (actualDestroy > 0) {
          const remaining = [...occupied];
          const remainingWeights = remaining.map(
            (t) => DESTROY_WEIGHTS[t.type] || 1,
          );
          const destroyedOriginalIndices: number[] = [];

          for (let i = 0; i < actualDestroy; i++) {
            if (remaining.length === 0) break;
            const pickedIdx = weightedChoice(
              remaining.map((_, j) => j),
              remainingWeights,
            );
            // Find original index in occupied array
            destroyedOriginalIndices.push(
              occupied.indexOf(remaining[pickedIdx]),
            );
            remaining.splice(pickedIdx, 1);
            remainingWeights.splice(pickedIdx, 1);
          }

          const newMap: CityMap = Object.fromEntries(
            Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
          );
          const tilesDestroyed: number[][] = [];
          for (const idx of destroyedOriginalIndices) {
            const { row, col } = occupied[idx];
            newMap[row][col] = "rubble";
            tilesDestroyed.push([row, col]);
          }

          updates.city_map = newMap;
          updates.pending_event = {
            event_id: `evt_${uuidv4().replace(/-/g, "").slice(0, 12)}`,
            type: "asteroid",
            tiles_destroyed: tilesDestroyed,
            timestamp: nowIso,
          };
        }
      }
    }
  }

  // Single source of truth for streak: derive from the (possibly
  // appended-to) completions log relative to the day we just processed.
  updates.building_completions = newCompletions;
  updates.streak = computeStreak(newCompletions, processingDate);
  return updates;
}
