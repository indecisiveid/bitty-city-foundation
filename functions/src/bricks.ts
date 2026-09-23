/**
 * Bricks — PURE. The currency behind the city shop.
 *
 * Bricks belong to the PERSON (`users/{uid}.bricks`), earned by every
 * member of a city when a build lands and spent on that city's hard hats
 * (and, later, cosmetic packs). Store purchases will also land here once the
 * receipt webhook exists; the shape below is what it will call.
 *
 *   users/{uid}.bricks         number, never negative, never expires
 *   users/{uid}.brick_ledger   trailing entries, newest last, capped — the
 *                              event ids double as the idempotency key so a
 *                              landing processed twice pays once
 *
 * Earn rates: by the build's day cost. A restoration (a levelled lot put
 * back, one day) earns the one-day rate. Streak milestones come later.
 */

export const HAT_PRICE_BRICKS = 60;
export const BRICK_LEDGER_MAX = 30;

const BRICKS_BY_DAYS: Record<number, number> = { 1: 10, 3: 40, 5: 75, 7: 120 };

export function bricksForLanding(days: number | undefined): number {
  if (days == null) return BRICKS_BY_DAYS[1];
  const known = Object.keys(BRICKS_BY_DAYS).map(Number).sort((a, b) => a - b);
  // Nearest tier at or below, so an odd day cost still pays something sane.
  let pick = known[0];
  for (const k of known) if (k <= days) pick = k;
  return BRICKS_BY_DAYS[pick];
}

export type BrickReason = "landing" | "hats" | "purchase" | "quest";

export interface BrickEntry {
  /** Idempotency key: the landing's event id, a purchase's transaction id,
   *  or a spend's own uuid. */
  event_id: string;
  /** Positive to earn, negative to spend. */
  amount: number;
  reason: BrickReason;
  group_id?: string;
  at: string;
}

export interface BrickWallet {
  bricks?: number;
  brick_ledger?: BrickEntry[];
}

/**
 * Apply one entry to a wallet. Returns the fields to write, or null when the
 * entry's event id has already been applied (so callers can retry freely).
 * A spend that would go negative also returns null.
 */
export function applyBrickEntry(
  wallet: BrickWallet | null | undefined,
  entry: BrickEntry,
): { bricks: number; brick_ledger: BrickEntry[] } | null {
  const ledger = wallet?.brick_ledger ?? [];
  if (ledger.some((e) => e.event_id === entry.event_id)) return null;
  const bricks = (wallet?.bricks ?? 0) + entry.amount;
  if (bricks < 0) return null;
  return { bricks, brick_ledger: [...ledger, entry].slice(-BRICK_LEDGER_MAX) };
}

/**
 * What a hard-hat refill costs. `count` is clamped to the empty slots, so
 * asking for three with two equipped buys one. Zero slots → null.
 */
export function hatRefillQuote(params: {
  streakFreezes: number;
  cap: number;
  count: number;
}): { count: number; cost: number } | null {
  const empty = Math.max(0, params.cap - params.streakFreezes);
  const count = Math.max(0, Math.min(Math.floor(params.count), empty));
  if (count === 0) return null;
  return { count, cost: count * HAT_PRICE_BRICKS };
}
