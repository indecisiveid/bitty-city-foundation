/**
 * PURE — the one policy every push passes through.
 *
 * Until now only the four scheduled reminder slots were budgeted per person
 * (reminderTiers.ts); the ~20 event pushes (city grew, stall, joined, kudos,
 * nudges, pauses, …) went straight to FCM with no budget, no dormant filter
 * and no record. With quests adding their own announcements, a busy crew
 * could get reminders + teammate pings + quest pings with nothing counting.
 *
 * Every push is now a NOTICE with a type, a category and a priority, and
 * `decideNotice` answers, per recipient: send it, send it quietly, or drop it.
 *
 *   category    what it is                                 examples
 *   reminder    the four daily slots                       "Last call"
 *   crew        something happened in your city           city grew, joined, next up, stall
 *   social      a PERSON did something to you              kudos, peer nudge, "your turn"
 *   quest       a quest was offered / moved / ended        "Incoming Promotion!"
 *   winback     the one message allowed to reach someone   comeback quest
 *               who has gone quiet
 *   system      test pushes
 *
 *   priority    transactional (someone acted on you) · important (something
 *               at stake today, e.g. a stalled build) · normal
 *
 * Presence tiers are the same as the reminders' (reminderTiers.tierFor):
 *   - active: a daily budget per category;
 *   - cooling: 1 crew and 1 quest a day, important always, a few social;
 *   - dormant: only one friend's message a day, and one winback per
 *     WINBACK_COOLDOWN_DAYS — the "we'll stop reminding you" promise holds
 *     for everything automatic.
 * Quiet hours (22:00–07:30 in the city's clock) never drop: they deliver
 * silently (no sound, no wake — APNs "passive"), so the morning still has it.
 * A `dedupeKey` makes a notice once-only per person ("announce this quest").
 *
 * The scheduled reminders keep their own slot rules and are only RECORDED
 * here (category `reminder`), so one ledger shows everything a person got.
 */
import { ReminderTier } from "./reminderTiers";

export type NoticeCategory = "reminder" | "crew" | "social" | "quest" | "winback" | "system";
export type NoticePriority = "transactional" | "important" | "normal";

export interface NoticeMeta {
  /** What happened — also `data.type` on the push, so the app can route a tap. */
  type: string;
  category: NoticeCategory;
  priority: NoticePriority;
  /** Stable id of the copy used — `data.variant`, for measuring which words work. */
  variant: string;
  /** Once per person per key, ever (within the ledger's memory). */
  dedupeKey?: string;
}

export interface NoticeLedger {
  /** Local game-date the counts belong to. */
  date: string | null;
  counts: Partial<Record<NoticeCategory, number>>;
  /** dedupeKey (and "winback") → ISO date last sent. */
  keys: Record<string, string>;
}

export const EMPTY_LEDGER: NoticeLedger = { date: null, counts: {}, keys: {} };

/** Per tier, per category, per day. Absent = unlimited. */
export const DAILY_BUDGET: Record<ReminderTier, Partial<Record<NoticeCategory, number>>> = {
  active: { crew: 6, quest: 2, winback: 1, social: 20 },
  cooling: { crew: 1, quest: 1, winback: 1, social: 5 },
  dormant: { crew: 0, quest: 0, winback: 1, social: 1, reminder: 0 },
};

export const WINBACK_COOLDOWN_DAYS = 14;
export const QUIET_START_MINUTES = 22 * 60;
export const QUIET_END_MINUTES = 7 * 60 + 30;
/** Keys older than this are forgotten so the ledger stays small. */
export const KEY_MEMORY_DAYS = 45;

export function ledgerOf(raw: unknown): NoticeLedger {
  if (!raw || typeof raw !== "object") return { ...EMPTY_LEDGER, counts: {}, keys: {} };
  const r = raw as Partial<NoticeLedger>;
  return {
    date: typeof r.date === "string" ? r.date : null,
    counts: r.counts && typeof r.counts === "object" ? { ...r.counts } : {},
    keys: r.keys && typeof r.keys === "object" ? { ...r.keys } : {},
  };
}

export function isQuietTime(localMinutes: number): boolean {
  return localMinutes >= QUIET_START_MINUTES || localMinutes < QUIET_END_MINUTES;
}

const daysApart = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type NoticeDecision =
  | { deliver: true; quiet: boolean }
  | { deliver: false; reason: string };

export function decideNotice(
  meta: NoticeMeta,
  tier: ReminderTier,
  ledger: NoticeLedger,
  today: string,
  localMinutes: number,
): NoticeDecision {
  if (meta.dedupeKey && ledger.keys[meta.dedupeKey]) return { deliver: false, reason: "already sent" };

  if (meta.category === "winback") {
    const last = ledger.keys.winback;
    if (last && daysApart(last, today) < WINBACK_COOLDOWN_DAYS) return { deliver: false, reason: "winback cooldown" };
  }

  const sentToday = ledger.date === today ? ledger.counts[meta.category] ?? 0 : 0;
  const budget = DAILY_BUDGET[tier][meta.category];
  // Something at stake today goes to anyone who hasn't gone quiet, whatever
  // the day's count. It never breaks the dormant promise.
  const exempt = meta.priority === "important" && tier !== "dormant";
  if (budget !== undefined && !exempt && sentToday >= budget) {
    return { deliver: false, reason: `${meta.category} budget (${tier})` };
  }
  return { deliver: true, quiet: isQuietTime(localMinutes) };
}

/** The ledger after sending `meta` on `today`. */
export function recordNotice(ledger: NoticeLedger, meta: NoticeMeta, today: string): NoticeLedger {
  const counts = ledger.date === today ? { ...ledger.counts } : {};
  counts[meta.category] = (counts[meta.category] ?? 0) + 1;
  const keys: Record<string, string> = {};
  for (const [k, d] of Object.entries(ledger.keys)) if (daysApart(d, today) <= KEY_MEMORY_DAYS) keys[k] = d;
  if (meta.dedupeKey) keys[meta.dedupeKey] = today;
  if (meta.category === "winback") keys.winback = today;
  return { date: today, counts, keys };
}
