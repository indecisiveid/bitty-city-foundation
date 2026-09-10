/**
 * PURE decision logic for the daily goal nudges. No Firestore, no clock, no
 * push — just "given this group's state at this local moment, should we nudge,
 * whom, and how urgently?". Kept pure so it's jest-testable like gameLogic.
 *
 * The crew gets up to FOUR nudges per game-day, at fixed local times:
 *
 *   08:00  morning   → plan the day ("Today is Day 2 of 3…" on a multi-day build)
 *   11:30  midday
 *   17:30  evening
 *   21:00  lastCall
 *
 * The scheduler runs every 30 minutes and each slot claims a 30-minute window
 * starting at its time, so a tick lands in at most one slot and scheduler
 * jitter (a run at :02 instead of :00) still fires. Slots whose window already
 * passed are never back-filled — so a build started at 3pm simply gets the
 * 17:30 and 21:00 nudges, not the two it slept through.
 *
 * Each slot is sent at most once per game-day (`remindersSentSlots`, scoped to
 * `remindersSentDate`), and nobody is nudged once their crew is done.
 *
 * WHO gets each slot differs, and that is the point of `recipients`:
 *
 *   morning / midday / evening → only the members who still haven't completed.
 *                                Telling someone who is already done that the
 *                                goal is open is just noise to them.
 *   lastCall                   → EVERYONE. The people who are done are the
 *                                only ones who can still save the day, by
 *                                chasing whoever is holding it up, so the last
 *                                slot addresses both sides. They get different
 *                                copy (see `messageFor`): finish it vs chase
 *                                them.
 *
 * A crew that is already complete is never nudged at all, so the last-call
 * chaser can only reach someone whose crew genuinely still has a gap.
 *
 * The message escalates by urgency:
 *
 *   meteor   → the 7-day inactivity meteor lands tomorrow unless today's goal
 *              is done (see daysUntilMeteor — a landed one doesn't
 *              re-warn until the next is due)                    → warn ALL
 *   streak   → a live streak is on the line and the day isn't done → nudge the
 *              members who still haven't completed
 *   reminder → plain "don't forget today's goal"                  → same
 */
import { INACTIVITY_METEOR_DAYS } from "./gameLogic";
import { GameMode } from "./gameMode";

export type SlotId = "morning" | "midday" | "evening" | "lastCall";

/** How long after its start time a slot still counts as "now" (scheduler jitter). */
export const SLOT_WINDOW_MINUTES = 30;

/** The four daily nudge times, as minutes since local midnight. */
export const REMINDER_SLOTS: ReadonlyArray<{ id: SlotId; minutes: number }> = [
  { id: "morning", minutes: 8 * 60 }, // 08:00
  { id: "midday", minutes: 11 * 60 + 30 }, // 11:30
  { id: "evening", minutes: 17 * 60 + 30 }, // 17:30
  { id: "lastCall", minutes: 21 * 60 }, // 21:00
];

export type NudgeKind = "meteor" | "streak" | "reminder";

export interface NudgeInput {
  /** Minutes since midnight (0–1439) in the group's timezone. */
  localMinutes: number;
  /** The current game-day label (getProcessingDate) in the group's tz. */
  todayGameDate: string;
  /** The game-date the stored slot list belongs to, or null if never nudged. */
  remindersSentDate: string | null;
  /** Slot ids already sent for `remindersSentDate`. */
  remindersSentSlots: SlotId[];
  memberCount: number;
  completedCount: number;
  /** Current streak length. */
  streak: number;
  /** Whole days since last activity (completion), or null if unknown. */
  idleDays: number | null;
  /** Whole days since the last inactivity meteor landed, or null if never. */
  daysSinceMeteor: number | null;
  /**
   * How the city counts a day. In easy mode a single completion already
   * keeps the streak, so "streak on the line" is only true while NOBODY has
   * finished; after that the late members get the plain reminder. Absent =
   * hard, the v1.0 rule.
   */
  gameMode?: GameMode;
}

export interface Nudge {
  kind: NudgeKind;
  /** 'all' for the meteor warning, 'incomplete' otherwise. */
  recipients: "all" | "incomplete";
  /** Which of the four daily slots this nudge is filling. */
  slot: SlotId;
}

/**
 * Which slot (if any) the given local time falls inside. A slot owns the
 * SLOT_WINDOW_MINUTES starting at its time; outside every window this is null.
 */
export function slotForLocalMinutes(localMinutes: number): SlotId | null {
  const slot = REMINDER_SLOTS.find(
    (s) =>
      localMinutes >= s.minutes && localMinutes < s.minutes + SLOT_WINDOW_MINUTES,
  );
  return slot?.id ?? null;
}

/**
 * Whole days until the inactivity meteor would land, by the game's own rule
 * (gameLogic.processEndOfDay): it fires once the crew has been idle for
 * INACTIVITY_METEOR_DAYS, and then at most once per INACTIVITY_METEOR_DAYS
 * after the previous landing. Null when activity is unknown.
 *
 * Landing a meteor does NOT reset the idle count — only a completion does —
 * which is why the previous landing has to be part of this. Zero or below
 * means it is overdue: day processing is lazy (and completeGoal runs it first),
 * so an overdue meteor lands the moment anyone opens the app.
 */
export function daysUntilMeteor(
  idleDays: number | null,
  daysSinceMeteor: number | null,
): number | null {
  if (idleDays === null) return null;
  const byIdle = INACTIVITY_METEOR_DAYS - idleDays;
  if (daysSinceMeteor === null) return byIdle;
  return Math.max(byIdle, INACTIVITY_METEOR_DAYS - daysSinceMeteor);
}

/**
 * Decide whether to nudge this group on this tick. Returns null when the tick
 * isn't inside a slot window, that slot already went out today, or the whole
 * crew is already done.
 */
export function decideNudge(input: NudgeInput): Nudge | null {
  const slot = slotForLocalMinutes(input.localMinutes);
  if (!slot) return null;

  // At most one send per slot per game-day. A stored list from an older
  // game-date is stale and means nothing has gone out today yet.
  const sentToday =
    input.remindersSentDate === input.todayGameDate
      ? input.remindersSentSlots
      : [];
  if (sentToday.includes(slot)) return null;

  // No members, or everyone's already done → nothing to nudge about.
  if (input.memberCount === 0) return null;
  const allComplete = input.completedCount >= input.memberCount;
  if (allComplete) return null;

  // Meteor is imminent when it lands TOMORROW unless today's goal is done —
  // exactly one day out, not "at least". Any later and it has either landed
  // already (the idle count keeps growing after a landing, so `>=` warned
  // four times a day forever) or is overdue and can no longer be stopped.
  const meteorImminent =
    daysUntilMeteor(input.idleDays, input.daysSinceMeteor) === 1;
  if (meteorImminent) return { kind: "meteor", recipients: "all", slot };

  // Last call goes to the whole crew — the members who are done are the ones
  // who can still chase the stragglers, and this is the last moment it can
  // make a difference.
  const recipients: Nudge["recipients"] = slot === "lastCall" ? "all" : "incomplete";

  const streakAtRisk =
    input.streak > 0 && ((input.gameMode ?? "hard") === "hard" || input.completedCount === 0);
  if (streakAtRisk) return { kind: "streak", recipients, slot };

  return { kind: "reminder", recipients, slot };
}
