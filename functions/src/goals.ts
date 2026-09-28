/**
 * Goal categories — PURE.
 *
 * The goal itself stays free text (`daily_goal`); `goal_category` is the
 * part of life it serves, the same four groups the app's goal picker shows
 * (mobile/src/api/goalCategories.ts — keep the two lists in lockstep). No
 * thresholds and no device mapping: a Health-based check-in suggestion, when
 * it comes, reads the goal itself, since "Body" also holds water and sleep.
 *
 * "custom" is a goal the founder typed themselves, and what an absent field
 * means (cities founded before categories existed).
 */

export const GOAL_CATEGORIES = ["custom", "body", "mind", "focus", "life"] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

export const DEFAULT_GOAL_CATEGORY: GoalCategory = "custom";

export function isGoalCategory(v: unknown): v is GoalCategory {
  return typeof v === "string" && (GOAL_CATEGORIES as readonly string[]).includes(v);
}

/** Absent or unknown → custom. */
export function normalizeGoalCategory(v: unknown): GoalCategory {
  return isGoalCategory(v) ? v : DEFAULT_GOAL_CATEGORY;
}
