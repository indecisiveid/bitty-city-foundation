/**
 * PURE decision logic for the once-a-day nudge. No Firestore, no clock, no
 * push — just "given this group's state at this local moment, should we nudge,
 * whom, and how urgently?". Kept pure so it's jest-testable like gameLogic.
 *
 * The scheduler runs hourly; exactly one run per group per day lands on the
 * group's reminder hour (a few hours before its reset), so we fire at most one
 * nudge per game-day. The message escalates by urgency:
 *
 *   meteor   → the 7-day inactivity meteor is one idle day away  → warn ALL
 *   streak   → a live streak is on the line and the day isn't done → nudge the
 *              members who still haven't completed
 *   reminder → plain "don't forget today's goal"                  → same
 */
import { INACTIVITY_METEOR_DAYS } from "./gameLogic";

/** How many hours before the daily reset the nudge fires. */
export const REMIND_LEAD_HOURS = 3;

export type NudgeKind = "meteor" | "streak" | "reminder";

export interface NudgeInput {
  /** Current hour (0–23) in the group's timezone. */
  localHour: number;
  /** The group's reset hour (0–23), parsed from goal_reset_time "HH:MM". */
  resetHour: number;
  /** The current game-day label (getProcessingDate) in the group's tz. */
  todayGameDate: string;
  /** Group's stored last_reminder_date, or null if never nudged. */
  lastReminderDate: string | null;
  memberCount: number;
  completedCount: number;
  /** Current streak length. */
  streak: number;
  /** Whole days since last activity (completion), or null if unknown. */
  idleDays: number | null;
}

export interface Nudge {
  kind: NudgeKind;
  /** 'all' for the meteor warning, 'incomplete' otherwise. */
  recipients: "all" | "incomplete";
}

/** The local hour, 0–23, at which a group with this reset hour gets nudged. */
export function reminderHour(resetHour: number): number {
  return ((resetHour - REMIND_LEAD_HOURS) % 24 + 24) % 24;
}

/**
 * Decide whether to nudge this group on this hourly tick. Returns null when
 * it's not this group's reminder hour, it's already been nudged today, or the
 * whole crew is already done.
 */
export function decideNudge(input: NudgeInput): Nudge | null {
  // Only the one hourly tick that matches this group's reminder hour fires.
  if (input.localHour !== reminderHour(input.resetHour)) return null;

  // At most one nudge per game-day.
  if (input.lastReminderDate === input.todayGameDate) return null;

  // No members, or everyone's already done → nothing to nudge about.
  if (input.memberCount === 0) return null;
  const allComplete = input.completedCount >= input.memberCount;
  if (allComplete) return null;

  // Meteor is imminent when the crew is one idle day short of the threshold
  // and today still isn't a success (nobody's completed yet counts as idle).
  const meteorImminent =
    input.idleDays !== null && input.idleDays >= INACTIVITY_METEOR_DAYS - 1;
  if (meteorImminent) return { kind: "meteor", recipients: "all" };

  if (input.streak > 0) return { kind: "streak", recipients: "incomplete" };

  return { kind: "reminder", recipients: "incomplete" };
}
