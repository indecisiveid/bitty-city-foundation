/**
 * PURE per-person reminder tiers. reminderLogic decides what a CITY owes at
 * this slot; this decides how much of that a PERSON should actually receive,
 * given how long since they last opened the app (presence.ts).
 *
 *   active   (< 7 days idle)  → everything the cities decided.
 *   cooling  (7–13 days)      → at most ONE push per game-day, and only the
 *                               late-day slots (evening / last call) — a
 *                               morning "plan your day" to someone who hasn't
 *                               looked in a week is noise. The meteor warning
 *                               still passes: it's the one push about a real
 *                               consequence.
 *   dormant  (≥ 14 days)      → one farewell ("we'll stop reminding you"),
 *                               then silence until they open the app again,
 *                               which clears the farewell (presence.ts) and
 *                               puts them back on the active tier.
 *
 * Why a farewell at all: silently stopping looks like the app broke; saying so
 * is honest, and it is the last push that can still bring someone back.
 */
import { NudgeEntry } from "./nudgeMessages";
import { SlotId } from "./reminderLogic";

export type ReminderTier = "active" | "cooling" | "dormant";

export const COOLING_AFTER_DAYS = 7;
export const DORMANT_AFTER_DAYS = 14;

/** Null (unknown presence) is treated as active — never farewell on a guess. */
export function tierFor(idleDays: number | null): ReminderTier {
  if (idleDays === null) return "active";
  if (idleDays >= DORMANT_AFTER_DAYS) return "dormant";
  if (idleDays >= COOLING_AFTER_DAYS) return "cooling";
  return "active";
}

/** What `users/{uid}.reminders` holds, normalized. */
export interface UserReminderState {
  /** Game-date the `sent` count belongs to. */
  date: string | null;
  /** Pushes sent to this person on `date`. */
  sent: number;
  farewellSent: boolean;
}

export const EMPTY_REMINDER_STATE: UserReminderState = { date: null, sent: 0, farewellSent: false };

export function reminderStateOf(raw: unknown): UserReminderState {
  if (!raw || typeof raw !== "object") return EMPTY_REMINDER_STATE;
  const r = raw as { date?: unknown; sent?: unknown; farewell_sent_at?: unknown };
  return {
    date: typeof r.date === "string" ? r.date : null,
    sent: typeof r.sent === "number" ? r.sent : 0,
    farewellSent: Boolean(r.farewell_sent_at),
  };
}

export type TierDecision =
  | { action: "send"; entries: NudgeEntry[] }
  | { action: "farewell" }
  | { action: "skip"; reason: string };

/** Slots a cooling user still hears. */
const COOLING_SLOTS: ReadonlySet<SlotId> = new Set<SlotId>(["evening", "lastCall"]);

export function sentTodayOf(state: UserReminderState, todayDate: string): number {
  return state.date === todayDate ? state.sent : 0;
}

export function applyUserTier(
  entries: NudgeEntry[],
  tier: ReminderTier,
  state: UserReminderState,
  todayDate: string,
): TierDecision {
  if (tier === "dormant") {
    return state.farewellSent ? { action: "skip", reason: "dormant: farewell already sent" } : { action: "farewell" };
  }
  if (entries.length === 0) return { action: "skip", reason: "nothing owed" };
  if (tier === "active") return { action: "send", entries };

  // cooling
  const kept = entries.filter((e) => e.nudge.kind === "meteor" || COOLING_SLOTS.has(e.nudge.slot));
  if (kept.length === 0) return { action: "skip", reason: "cooling: quiet slot" };
  if (sentTodayOf(state, todayDate) >= 1) return { action: "skip", reason: "cooling: daily cap" };
  return { action: "send", entries: kept };
}
