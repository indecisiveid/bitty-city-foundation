/**
 * PURE — a person's app preferences on `users/{uid}`.
 *
 *   seen_tips: string[]        in-app feature tips already shown (the app's
 *                              src/tips registry). Kept on the account so a
 *                              tip never repeats on a second phone.
 *   email_updates: {           consent to product-update email, as a record:
 *     enabled: boolean,        what they chose,
 *     at: ISO string,          when,
 *     source: string,          and where in the app they chose it.
 *   }
 *
 * The consent record is what lets us show, later, that anyone we emailed
 * asked for it. Absent = never asked = do NOT email.
 */

/** Tip ids are the app's stable registry keys: snake_case, short. */
const TIP_ID = /^[a-z][a-z0-9_]{1,39}$/;
/** More than the registry will ever hold; bounds the array on the doc. */
export const MAX_SEEN_TIPS = 100;
/** Per call — the app marks one tip at a time; a batch is a replay. */
export const MAX_TIPS_PER_CALL = 20;

export function isTipId(v: unknown): v is string {
  return typeof v === "string" && TIP_ID.test(v);
}

/** Merge newly seen ids into the stored list: deduped, order kept, capped. */
export function mergeSeenTips(stored: unknown, incoming: string[]): string[] {
  const out = Array.isArray(stored) ? stored.filter(isTipId) : [];
  for (const id of incoming) if (!out.includes(id)) out.push(id);
  return out.slice(-MAX_SEEN_TIPS);
}

export const EMAIL_UPDATE_SOURCES = ["settings", "tip"] as const;
export type EmailUpdateSource = (typeof EMAIL_UPDATE_SOURCES)[number];

export interface EmailUpdates {
  enabled: boolean;
  at: string;
  source: EmailUpdateSource;
}

export function isEmailUpdateSource(v: unknown): v is EmailUpdateSource {
  return typeof v === "string" && (EMAIL_UPDATE_SOURCES as readonly string[]).includes(v);
}

/** Only an explicit, recorded yes counts. */
export function wantsEmailUpdates(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as Partial<EmailUpdates>).enabled === true;
}
