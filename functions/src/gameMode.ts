/**
 * Game mode — PURE. How a city counts a day.
 *
 *   hard   All or nothing. A day is won only when EVERY active member
 *          completes; the build advances one whole day. This is the game
 *          v1.0 shipped with, and what a city with no `game_mode` field runs.
 *
 *   easy   Everyone lays a brick. Each completion adds its SHARE of the day
 *          (1 / active members), so a full crew still banks exactly one day
 *          and a partial crew banks part of one. A day with any completion
 *          at all is a won day for the streak; only a day with none is a
 *          miss. Easy mode can never be faster than hard mode — only more
 *          forgiving — which is what keeps hard mode the real game.
 *
 * Why proportional rather than "one completion banks the day": that rule
 * makes every tap after the first redundant, so three people learn to wait
 * for the fourth. A share per completion keeps every tap worth the same.
 *
 * Mirrored on the client in `mobile/src/utils/gameMode.ts` — change both.
 */

export type GameMode = "easy" | "hard";

/**
 * What a city runs when its doc carries no `game_mode`: every city founded
 * before the field existed keeps its rules to the letter. NOT the onboarding
 * default — the app preselects easy for a new crew and always sends the
 * choice explicitly. An old binary that never sends one founds a hard city,
 * which is the only game that binary knows how to show.
 */
export const LEGACY_GAME_MODE: GameMode = "hard";

export function isGameMode(raw: unknown): raw is GameMode {
  return raw === "easy" || raw === "hard";
}

export function normalizeGameMode(raw: unknown): GameMode {
  return isGameMode(raw) ? raw : LEGACY_GAME_MODE;
}

// ---------------------------------------------------------------------------
// Progress arithmetic
//
// `days_completed` is an integer in hard mode and may be fractional in easy
// mode. Shares like 1/3 don't round-trip through floats, so every step is
// rounded to PROGRESS_PRECISION and SNAPPED to the nearest whole day when it
// lands within EPSILON of one — three thirds must read as exactly 1, or the
// day number floors to 0 and the bar shows a day nobody has banked.
// ---------------------------------------------------------------------------

const PROGRESS_PRECISION = 4;
const EPSILON = 1e-3;

export function snapProgress(n: number): number {
  const whole = Math.round(n);
  if (Math.abs(n - whole) < EPSILON) return whole;
  const p = 10 ** PROGRESS_PRECISION;
  return Math.round(n * p) / p;
}

/**
 * How much of a day this roster banked. 0 means the day was missed.
 *
 *   hard: 1 when everyone (and someone) completed, else 0
 *   easy: completed / active, 0 when nobody did
 */
export function dayShare(mode: GameMode, completedActive: number, activeCount: number): number {
  if (activeCount <= 0 || completedActive <= 0) return 0;
  if (mode === "hard") return completedActive >= activeCount ? 1 : 0;
  return snapProgress(Math.min(1, completedActive / activeCount));
}

/** A build with this much banked has landed. Tolerant of float drift. */
export function isBuildFinished(daysCompleted: number, daysRequired: number): boolean {
  return daysCompleted + EPSILON >= daysRequired;
}

// ---------------------------------------------------------------------------
// Struggle detection — "try easy mode"
//
// A NEAR MISS is a hard-mode day where someone finished but not everyone: the
// exact day easy mode would have banked. Days where nobody finished are not
// counted — that crew needs the meteor nudge, not a rule change.
//
// Three near misses inside a week suggests the mode, not the crew, is the
// problem. The suggestion goes out once, then not again for a fortnight, so
// a crew that chose hard mode on purpose isn't nagged four times a month.
// ---------------------------------------------------------------------------

export const NEAR_MISS_WINDOW_DAYS = 7;
export const NEAR_MISS_THRESHOLD = 3;
export const MODE_SUGGESTION_COOLDOWN_DAYS = 14;
/** The ledger only needs the trailing window; keep a little slack. */
const NEAR_MISS_KEEP_DAYS = 14;

export interface ModeSuggestion {
  /** Settlement label of the pass that raised it. */
  suggested_on: string;
  /** Near misses in the trailing window at that moment. */
  near_misses: number;
  /** Members who chose "Keep hard mode" — the sheet stays closed for them. */
  dismissed_by: string[];
}

function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Whole days from `a` to `b` (positive when b is later). */
function daysBetweenYmd(a: string, b: string): number {
  return parseYmd(b) - parseYmd(a);
}

/** Near misses inside the trailing window ending at `processingDate`. */
export function recentNearMisses(nearMissDates: string[], processingDate: string): number {
  return nearMissDates.filter((d) => {
    const age = daysBetweenYmd(d, processingDate);
    return age >= 0 && age < NEAR_MISS_WINDOW_DAYS;
  }).length;
}

/** Drop entries older than the keep window; dedupe; keep order. */
export function pruneNearMisses(nearMissDates: string[], processingDate: string): string[] {
  const out: string[] = [];
  for (const d of nearMissDates) {
    const age = daysBetweenYmd(d, processingDate);
    if (age >= 0 && age < NEAR_MISS_KEEP_DAYS && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Should this pass raise (or re-raise) the easy-mode suggestion?
 * Only ever in hard mode; only past the threshold; only outside the cooldown
 * of the last one.
 */
export function shouldSuggestEasyMode(params: {
  mode: GameMode;
  nearMissDates: string[];
  processingDate: string;
  suggestion: ModeSuggestion | null | undefined;
}): boolean {
  const { mode, nearMissDates, processingDate, suggestion } = params;
  if (mode !== "hard") return false;
  if (recentNearMisses(nearMissDates, processingDate) < NEAR_MISS_THRESHOLD) return false;
  if (suggestion && daysBetweenYmd(suggestion.suggested_on, processingDate) < MODE_SUGGESTION_COOLDOWN_DAYS) {
    return false;
  }
  return true;
}
