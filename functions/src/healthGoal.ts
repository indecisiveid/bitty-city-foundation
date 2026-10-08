/**
 * Health goals — PURE.
 *
 * A city whose goal Apple Health can count (steps, exercise minutes, a
 * workout, mindful minutes) lets a member check in with a Health reading
 * instead of a photo. The phone reads Health and sends a summary; the server
 * decides whether that summary meets the CITY's target (see `proofs.ts` /
 * `resolveHealthProof`).
 *
 * The city's goal is `groups/{id}.health_goal`:
 *   - a HealthGoal object → that goal (set from city settings);
 *   - `null`             → a member turned Health off for this city;
 *   - absent             → derived from the goal text, when it is one of the
 *                          app picker's presets (`presetHealthGoal`).
 *
 * MIRRORED in the app: bitty-city/mobile/src/health/healthGoal.ts. The two
 * files must change together — same metrics, presets, bounds and rules.
 */

export const HEALTH_METRICS = ["steps", "exercise_minutes", "workout", "mindful_minutes"] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];

export interface HealthGoal {
  metric: HealthMetric;
  target: number;
  activity?: string;
}

/**
 * Upper bounds (inclusive) for a reading's value AND a goal's target. A
 * target is at least 1; a value at least 0. `workout` is in minutes.
 */
export const METRIC_BOUNDS: Record<HealthMetric, number> = {
  steps: 200000,
  exercise_minutes: 1440,
  workout: 1440,
  mindful_minutes: 1440,
};

export const MAX_ACTIVITY_LENGTH = 30;

export function isHealthMetric(v: unknown): v is HealthMetric {
  return typeof v === "string" && (HEALTH_METRICS as readonly string[]).includes(v);
}

/** Integer in [min, max]. */
export function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

export function isActivity(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_ACTIVITY_LENGTH;
}

export function isHealthGoal(v: unknown): v is HealthGoal {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const g = v as Partial<HealthGoal>;
  if (!isHealthMetric(g.metric)) return false;
  if (!isIntIn(g.target, 1, METRIC_BOUNDS[g.metric])) return false;
  if (g.activity !== undefined && !isActivity(g.activity)) return false;
  return true;
}

/** Just the known fields, so nothing a client tacked on gets stored. */
export function cleanHealthGoal(g: HealthGoal): HealthGoal {
  return g.activity !== undefined
    ? { metric: g.metric, target: g.target, activity: g.activity }
    : { metric: g.metric, target: g.target };
}

/** The app goal picker's presets Health can count. Keys are lowercase. */
const PRESETS: Record<string, HealthGoal> = {
  "walk 10,000 steps": { metric: "steps", target: 10000 },
  "exercise for 30 min": { metric: "exercise_minutes", target: 30 },
  "meditate for 10 min": { metric: "mindful_minutes", target: 10 },
};

/** A preset goal text (case-insensitive, trimmed) → its Health goal. */
export function presetHealthGoal(dailyGoal: unknown): HealthGoal | null {
  if (typeof dailyGoal !== "string") return null;
  const preset = PRESETS[dailyGoal.trim().toLowerCase()];
  return preset ? { ...preset } : null;
}

/**
 * The city's effective Health goal. An explicit object wins; an explicit
 * `null` means Health is off for this city; absent derives from the goal
 * text. Anything else on the field (never written by the server) counts as
 * off rather than guessing.
 */
export function effectiveHealthGoal(group: { health_goal?: unknown; daily_goal?: unknown }): HealthGoal | null {
  const explicit = group.health_goal;
  if (explicit === undefined) return presetHealthGoal(group.daily_goal);
  return isHealthGoal(explicit) ? cleanHealthGoal(explicit) : null;
}
