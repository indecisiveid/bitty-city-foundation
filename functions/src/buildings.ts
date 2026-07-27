/**
 * Human-readable names for building types. Shared by the callables (the
 * "city grew" push) and the scheduler (the morning "Day X of Y" nudge) so a
 * building is never called two different things in two different pushes.
 */
import { BUILDING_DAYS } from "./gameLogic";

export const BUILDING_LABEL: Record<string, string> = {
  house: "House",
  apartment: "Apartment",
  skyscraper: "Skyscraper",
};

/** The active build's progress, when it's a multi-day one worth narrating. */
export interface BuildProgress {
  label: string;
  /** 1-based: the day the crew is working on right now. */
  dayNumber: number;
  daysRequired: number;
}

/**
 * Describe the in-flight build for "Day X of Y" copy. Returns null for no
 * build, or a single-day build (nothing to count down).
 *
 * `days_completed` counts days already banked, so today is the next one up —
 * a fresh 3-day build reads "Day 1 of 3", and after one all-complete day it
 * reads "Day 2 of 3".
 */
export function buildProgressOf(currentBuild: unknown): BuildProgress | null {
  if (!currentBuild || typeof currentBuild !== "object") return null;
  const build = currentBuild as {
    type?: string;
    days_required?: number;
    days_completed?: number;
  };
  const type = build.type ?? "";
  const daysRequired = build.days_required ?? BUILDING_DAYS[type] ?? 0;
  if (daysRequired < 2) return null;

  const daysCompleted = build.days_completed ?? 0;
  // Clamp: a finished-but-not-yet-processed build shouldn't read "Day 4 of 3".
  const dayNumber = Math.min(daysCompleted + 1, daysRequired);

  return {
    label: BUILDING_LABEL[type] ?? "building",
    dayNumber,
    daysRequired,
  };
}
