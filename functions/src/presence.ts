/**
 * Per-user presence — when did this PERSON last open the app?
 *
 * Every reminder decision used to be per-city: "is this crew done today?"
 * Nothing knew whether the person on the other end had opened the app in the
 * last month. So a city whose only member walked away in August kept getting
 * three or four pushes a day, forever — the fastest way to be uninstalled.
 *
 * `users/{uid}.last_seen_at` is stamped from the callables the app fires when
 * someone is actually looking at it (getGroup on mount/foreground,
 * registerPushToken once per session, completeGoal). The scheduler reads it to
 * pick a reminder tier (reminderTiers.ts). A missing stamp means "unknown" and
 * is treated as active — a user who simply predates the field must not be
 * farewelled by mistake; scripts/backfill-last-seen.mjs seeds it from Auth.
 *
 * `completion_minutes` (the local minute-of-day of the last N completions) is
 * recorded here too. Nothing reads it yet: it exists so that, once a couple of
 * weeks of data exist, reminders can be sent shortly before each person's
 * usual completion time instead of at four fixed slots.
 *
 * Best-effort throughout: presence must never break a game action.
 */
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { DateTime } from "luxon";

const db = () => getFirestore();

/** Don't rewrite the stamp more often than this — Home calls getGroup once per city on every foreground. */
export const TOUCH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How many recent completion times to keep per user. */
export const COMPLETION_MINUTES_KEPT = 14;

const MS_PER_DAY = 86_400_000;

/** Firestore Timestamp | Date | ISO string | anything else → Date | null. */
export function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

/** Whether the stamp is old enough to be worth another write. */
export function shouldTouch(prev: Date | null, now: Date): boolean {
  if (!prev) return true;
  return now.getTime() - prev.getTime() >= TOUCH_MIN_INTERVAL_MS;
}

/**
 * Whole days since this person last opened the app, or null when unknown.
 * Unknown is deliberately NOT "forever": see the module comment.
 */
export function idleDaysFor(user: { last_seen_at?: unknown } | undefined, now: Date): number | null {
  const seen = toDate(user?.last_seen_at);
  if (!seen) return null;
  return Math.max(0, Math.floor((now.getTime() - seen.getTime()) / MS_PER_DAY));
}

/** Append, keeping only the newest `cap` entries. */
export function pushCapped<T>(arr: readonly T[], value: T, cap: number): T[] {
  const next = [...arr, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Minutes since local midnight in the given IANA zone. */
export function localMinutesOf(now: Date, timezone: string): number {
  const local = DateTime.fromJSDate(now).setZone(timezone);
  const use = local.isValid ? local : DateTime.fromJSDate(now).setZone("UTC");
  return use.hour * 60 + use.minute;
}

export interface TouchOptions {
  /** Stamp even if the last one is recent (a completion is real activity). */
  force?: boolean;
  /** Local minute-of-day of a completion to remember. */
  completionMinutes?: number;
  now?: Date;
}

/**
 * Stamp `last_seen_at` (throttled), clear a farewell so reminders can resume,
 * and optionally remember a completion time. One read, at most one write.
 */
export async function touchLastSeen(uid: string, opts: TouchOptions = {}): Promise<void> {
  try {
    const ref = db().collection("users").doc(uid);
    const snap = await ref.get();
    const data = snap.data() ?? {};
    const now = opts.now ?? new Date();
    const stamp = opts.force || shouldTouch(toDate(data.last_seen_at), now);

    const update: Record<string, unknown> = {};
    if (stamp) {
      update.last_seen_at = Timestamp.fromDate(now);
      // They're back: the "we'll stop reminding you" record no longer applies.
      if (data.reminders?.farewell_sent_at) {
        update.reminders = { farewell_sent_at: null };
      }
    }
    if (opts.completionMinutes !== undefined) {
      const prev: unknown[] = Array.isArray(data.completion_minutes) ? data.completion_minutes : [];
      update.completion_minutes = pushCapped(prev, opts.completionMinutes, COMPLETION_MINUTES_KEPT);
    }
    if (Object.keys(update).length === 0) return;
    // merge:true deep-merges maps, so `reminders.date` / `.sent` survive.
    await ref.set(update, { merge: true });
  } catch (err) {
    console.error("[presence] touch failed", uid, err);
  }
}
