/**
 * Human-readable names for building types. Shared by the callables (the
 * "city grew" push) and the scheduler (the morning "Day X of Y" nudge) so a
 * building is never called two different things in two different pushes.
 */
import { daysFor, labelFor } from "./buildCatalog";

/**
 * "a House" / "an Office" / "the Apartments". The labels are a closed, hand-written set, so a
 * leading-vowel test is enough — no need for a real article library.
 */
export function withArticle(label: string): string {
  // Plural names ("Apartments", "Twin Towers") take "the": "an Apartments"
  // and "a Twin Towers" read as typos.
  if (/[^s]s$/i.test(label)) return `the ${label}`;
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

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
    target_tile?: unknown;
    target_park?: unknown;
  };
  const type = build.type ?? "";
  const daysRequired = build.days_required ?? daysFor(type) ?? 0;
  if (daysRequired < 2) return null;

  // Floored: easy mode banks fractions of a day (gameMode.ts), and the day
  // in flight is the one after the last WHOLE day banked.
  const daysCompleted = Math.floor(build.days_completed ?? 0);
  // Clamp: a finished-but-not-yet-processed build shouldn't read "Day 4 of 3".
  const dayNumber = Math.min(daysCompleted + 1, daysRequired);

  return {
    // A restoration narrates as one ("Day 1 of 3 banked toward your Park
    // restoration") rather than as a second park going up.
    label:
      build.target_tile != null || build.target_park != null
        ? `${labelFor(type)} restoration`
        : labelFor(type),
    dayNumber,
    daysRequired,
  };
}

/**
 * The label of the build that LANDS if the crew wins today, or null. Unlike
 * `buildProgressOf` this includes single-day builds: "finish today and your
 * Cottage lands tonight" is exactly the stake a fresh solo city has.
 */
export function landingTodayLabel(currentBuild: unknown): string | null {
  if (!currentBuild || typeof currentBuild !== "object") return null;
  const build = currentBuild as {
    type?: string;
    days_required?: number;
    days_completed?: number;
    target_tile?: unknown;
    target_park?: unknown;
  };
  const type = build.type ?? "";
  const daysRequired = build.days_required ?? daysFor(type) ?? 0;
  if (daysRequired < 1) return null;
  const daysCompleted = build.days_completed ?? 0;
  if (daysRequired - daysCompleted > 1) return null;
  const label = labelFor(type);
  return build.target_tile != null || build.target_park != null ? `${label} restoration` : label;
}
