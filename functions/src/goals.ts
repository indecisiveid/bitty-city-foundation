/**
 * Goal categories — PURE.
 *
 * The goal itself stays free text (`daily_goal`); `goal_type` is an optional,
 * deliberately general tag next to it. No thresholds: "exercise" means any
 * logged workout counts, "mindfulness" any logged mindful session. That is
 * enough for the app to offer a Health-based check-in suggestion later
 * without turning the game into a fitness tracker. "custom" (the default,
 * and what an absent field means) is a goal no device can see.
 */

export const GOAL_TYPES = ["custom", "exercise", "mindfulness"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const DEFAULT_GOAL_TYPE: GoalType = "custom";

export function isGoalType(v: unknown): v is GoalType {
  return typeof v === "string" && (GOAL_TYPES as readonly string[]).includes(v);
}

/** Absent or unknown → custom: cities founded before categories existed. */
export function normalizeGoalType(v: unknown): GoalType {
  return isGoalType(v) ? v : DEFAULT_GOAL_TYPE;
}
