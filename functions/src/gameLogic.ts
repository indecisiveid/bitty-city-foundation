import { v4 as uuidv4 } from "uuid";
import { GRID_ROWS, GRID_COLS } from "./utils";

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
  completions_today: string[];
  streak: number;
  current_build: CurrentBuild | null;
  city_map: CityMap;
  last_processed_date: string | null;
  pending_event: PendingEvent | null;
  created_at: FirebaseFirestore.Timestamp;
}

export function needsDayProcessing(
  goalResetTime: string,
  lastProcessedDate: string | null,
): boolean {
  const now = new Date();
  const [hour, minute] = goalResetTime.split(":").map(Number);

  // Build today's reset datetime in UTC
  const resetToday = new Date(now);
  resetToday.setUTCHours(hour, minute, 0, 0);

  let checkDate: string;
  if (now < resetToday) {
    // Check against yesterday's date
    const yesterday = new Date(resetToday);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    checkDate = formatDate(yesterday);
  } else {
    checkDate = formatDate(resetToday);
  }

  if (lastProcessedDate === checkDate) {
    return false;
  }

  return true;
}

export function getProcessingDate(goalResetTime: string): string {
  const now = new Date();
  const [hour, minute] = goalResetTime.split(":").map(Number);

  const resetToday = new Date(now);
  resetToday.setUTCHours(hour, minute, 0, 0);

  if (now < resetToday) {
    const yesterday = new Date(resetToday);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return formatDate(yesterday);
  }
  return formatDate(resetToday);
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function findEmptyTiles(cityMap: CityMap): number[][] {
  const tiles: number[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (cityMap[r][c] === null || cityMap[r][c] === "rubble") {
        tiles.push([r, c]);
      }
    }
  }
  return tiles;
}

export function findOccupiedTiles(
  cityMap: CityMap,
): { row: number; col: number; type: string }[] {
  const tiles: { row: number; col: number; type: string }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = cityMap[r][c];
      if (cell === "house" || cell === "apartment" || cell === "skyscraper") {
        tiles.push({ row: r, col: c, type: cell });
      }
    }
  }
  return tiles;
}

// Weighted random selection (equivalent to Python's random.choices with k=1)
function weightedChoice<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export interface EndOfDayUpdates {
  completions_today: string[];
  city_map?: CityMap;
  current_build?: CurrentBuild | null;
  streak?: number;
  pending_event?: PendingEvent;
}

export function processEndOfDay(params: {
  groupMembers: string[];
  completionsToday: string[];
  currentBuild: CurrentBuild | null;
  cityMap: CityMap;
  streak: number;
}): EndOfDayUpdates {
  const { groupMembers, completionsToday, currentBuild, cityMap, streak } =
    params;

  const updates: EndOfDayUpdates = {
    completions_today: [],
  };

  const nowIso = new Date().toISOString();

  // No active build — just clear completions
  if (currentBuild === null) {
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
      }

      updates.current_build = null;
      updates.streak = 0;
    } else {
      // Streak continues
      updates.current_build = {
        ...currentBuild,
        days_completed: newDays,
      };
      updates.streak = streak + 1;
    }
  } else {
    // Failed — asteroid
    updates.streak = 0;
    updates.current_build = null;

    const occupied = findOccupiedTiles(cityMap);
    if (occupied.length > 0) {
      // Determine how many to destroy (1-3, but leave at least 1)
      let maxDestroy = Math.min(3, occupied.length - 1);
      if (maxDestroy < 1) {
        maxDestroy = occupied.length > 1 ? 1 : 0;
      }

      if (maxDestroy > 0) {
        const nDestroy =
          Math.floor(Math.random() * maxDestroy) + 1;

        // Ensure we don't wipe the entire city
        const actualDestroy = Math.min(nDestroy, occupied.length - 1);

        if (actualDestroy > 0) {
          // Weighted selection without replacement
          const remaining = [...occupied];
          const remainingWeights = remaining.map(
            (t) => DESTROY_WEIGHTS[t.type] || 1,
          );
          const destroyedIndices: number[] = [];

          for (let i = 0; i < actualDestroy; i++) {
            if (remaining.length === 0) break;
            const idx = weightedChoice(
              remaining.map((_, j) => j),
              remainingWeights,
            );
            destroyedIndices.push(occupied.indexOf(remaining[idx]));
            remaining.splice(idx, 1);
            remainingWeights.splice(idx, 1);
          }

          const newMap: CityMap = Object.fromEntries(
            Object.entries(cityMap).map(([k, row]) => [k, [...row]]),
          );
          const tilesDestroyed: number[][] = [];
          for (const idx of destroyedIndices) {
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

  return updates;
}
