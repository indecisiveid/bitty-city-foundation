/**
 * Kudos — pure logic.
 *
 * A kudo is one member cheering another member who already finished today's
 * goal. State lives on the group doc as a single-day bucket:
 *
 *   kudos_today: { date: "YYYY-MM-DD", pairs: [{ from, to }, …] }
 *
 * Why a date-stamped bucket instead of an ever-growing log:
 *  - kudos are a *today* thing — the UI only needs "did I already cheer
 *    Bob today", so the doc never grows without bound;
 *  - day processing clears the field (see `maybeProcessDay`), and the date
 *    stamp is the belt-and-braces guard for the window where a day has
 *    rolled over but nothing has triggered lazy processing yet — appending
 *    into a stale bucket silently resets it instead of resurrecting
 *    yesterday's hearts;
 *  - it's a map of an array (never an array of arrays), which Firestore
 *    accepts.
 *
 * Pairs are objects rather than a `"from|to"` string so a display name
 * containing the separator can't collide.
 */

export interface KudosPair {
  from: string;
  to: string;
}

export interface KudosState {
  date: string; // "YYYY-MM-DD" — the game day this bucket belongs to
  pairs: KudosPair[];
}

const isPair = (v: unknown): v is KudosPair =>
  !!v &&
  typeof v === "object" &&
  typeof (v as KudosPair).from === "string" &&
  typeof (v as KudosPair).to === "string";

/**
 * Coerce whatever is on the doc into a usable bucket for `today`. Anything
 * missing, malformed, or stamped with a different day comes back empty.
 */
export function normalizeKudos(raw: unknown, today: string): KudosState {
  const candidate = raw as Partial<KudosState> | null | undefined;
  if (!candidate || candidate.date !== today || !Array.isArray(candidate.pairs)) {
    return { date: today, pairs: [] };
  }
  return { date: today, pairs: candidate.pairs.filter(isPair) };
}

/** Has `from` already cheered `to` in this bucket? */
export function hasKudos(state: KudosState, from: string, to: string): boolean {
  return state.pairs.some((p) => p.from === from && p.to === to);
}

/** How many kudos has `to` received in this bucket? */
export function kudosCountFor(state: KudosState, to: string): number {
  return state.pairs.filter((p) => p.to === to).length;
}

/**
 * Add a kudo. Idempotent: sending the same pair twice in a day leaves the
 * state untouched and reports `isNew: false`, so the caller knows not to
 * fire a second push.
 */
export function applyKudos(
  raw: unknown,
  today: string,
  from: string,
  to: string,
): { state: KudosState; isNew: boolean } {
  const state = normalizeKudos(raw, today);
  if (hasKudos(state, from, to)) return { state, isNew: false };
  return { state: { date: today, pairs: [...state.pairs, { from, to }] }, isNew: true };
}
