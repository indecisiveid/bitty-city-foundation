/**
 * Peer nudges — pure logic.
 *
 * A nudge is one member manually reminding another member who has *not*
 * finished today's goal yet. It is the mirror image of a kudo (which cheers
 * someone who *has* finished), and it deliberately shares that feature's
 * shape: a single-day bucket on the group doc,
 *
 *   nudges_today: { date: "YYYY-MM-DD", pairs: [{ from, to }, …] }
 *
 * Why a date-stamped bucket instead of an ever-growing log: the UI only ever
 * asks "have I already reminded Bob today", so the doc never grows without
 * bound; day processing clears the field, and the date stamp covers the
 * window where a day has rolled over but nothing has triggered lazy
 * processing yet (appending into a stale bucket resets it rather than
 * resurrecting yesterday's nudges).
 *
 * NOT to be confused with `reminders_sent_date` / `reminders_sent_slots`
 * (see `reminderLogic.ts` + `scheduled.ts`), which are the *automatic*
 * 8:00/11:30/17:30/21:00 nudges the server sends on a schedule. These are
 * person-to-person and only exist because someone pressed a button.
 */

export interface NudgePair {
  from: string;
  to: string;
}

export interface NudgeState {
  date: string; // "YYYY-MM-DD" — the game day this bucket belongs to
  pairs: NudgePair[];
}

const isPair = (v: unknown): v is NudgePair =>
  !!v &&
  typeof v === "object" &&
  typeof (v as NudgePair).from === "string" &&
  typeof (v as NudgePair).to === "string";

/**
 * Coerce whatever is on the doc into a usable bucket for `today`. Anything
 * missing, malformed, or stamped with a different day comes back empty.
 */
export function normalizeNudges(raw: unknown, today: string): NudgeState {
  const candidate = raw as Partial<NudgeState> | null | undefined;
  if (!candidate || candidate.date !== today || !Array.isArray(candidate.pairs)) {
    return { date: today, pairs: [] };
  }
  return { date: today, pairs: candidate.pairs.filter(isPair) };
}

/** Has `from` already nudged `to` in this bucket? */
export function hasNudged(state: NudgeState, from: string, to: string): boolean {
  return state.pairs.some((p) => p.from === from && p.to === to);
}

/** How many nudges has `to` received in this bucket, from anyone? */
export function nudgeCountFor(state: NudgeState, to: string): number {
  return state.pairs.filter((p) => p.to === to).length;
}

/**
 * Record a nudge. Idempotent: the same sender→recipient twice in a day
 * leaves the state untouched and reports `isNew: false`, which is what
 * enforces the once-a-day rule — the caller knows not to fire a second
 * push.
 */
export function applyNudge(
  raw: unknown,
  today: string,
  from: string,
  to: string,
): { state: NudgeState; isNew: boolean } {
  const state = normalizeNudges(raw, today);
  if (hasNudged(state, from, to)) return { state, isNew: false };
  return { state: { date: today, pairs: [...state.pairs, { from, to }] }, isNew: true };
}

/**
 * The push body, e.g. "Christian is reminding you to Exercise for 30
 * minutes." Kept here (not in the handler) so the copy is testable and so
 * a goal with trailing punctuation doesn't produce "...minutes.."
 */
export function nudgeBody(fromName: string, dailyGoal: string): string {
  const goal = (dailyGoal ?? "").trim().replace(/[.!?]+$/, "");
  if (!goal) return `${fromName} is reminding you to complete today's goal.`;
  return `${fromName} is reminding you to ${goal}.`;
}
