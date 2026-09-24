/**
 * App Store packs — PURE. What each product grants, whose it is, and how a
 * verified purchase lands in a person's inventory.
 *
 * No in-game currency: people buy a pack of hard hats or a pack of bricks
 * with real money, and it goes into THEIR inventory, usable in any city.
 *
 *   users/{uid}.hard_hats     number — bought hard hats not yet put in a city
 *   users/{uid}.bricks        number — earned on landings AND bought (bricks.ts)
 *   users/{uid}.store_ledger  trailing purchases, newest last, capped
 *   store_transactions/{id}   server-only: which account an App Store
 *                             transaction was credited to (global replay guard)
 *
 * A city's own hard hats (`groups.streak_freezes`, cap 3, +1 per landing,
 * spent automatically on a miss) are unchanged. Putting one of yours into a
 * city moves it from `users.hard_hats` into that pool (`useHardHats`).
 *
 * Product ids are App Store Connect product ids. Changing a grant for an id
 * that has already sold changes what later buyers get, never past purchases.
 */
import { v5 as uuidv5 } from "uuid";
import { BrickEntry, applyBrickEntry, BrickWallet } from "./bricks";

export const BUNDLE_ID = "com.sidejawn.bittycity";
export const APP_APPLE_ID = 6788958958;

export interface Grant {
  hard_hats?: number;
  bricks?: number;
}

export const STORE_PRODUCTS: Record<string, Grant> = {
  "com.sidejawn.bittycity.hardhats.1": { hard_hats: 1 },
  "com.sidejawn.bittycity.hardhats.3": { hard_hats: 3 },
  "com.sidejawn.bittycity.bricks.small": { bricks: 120 },
  "com.sidejawn.bittycity.bricks.medium": { bricks: 400 },
  "com.sidejawn.bittycity.bricks.large": { bricks: 1000 },
};

export function grantFor(productId: string | undefined | null): Grant | null {
  return (productId && STORE_PRODUCTS[productId]) || null;
}

/**
 * The `appAccountToken` a purchase must carry: a UUID derived from the uid,
 * so the server can tell a purchase belongs to the account redeeming it
 * without storing anything first. The app computes the same value
 * (mobile/src/store/accountToken.ts) — parity-tested on both sides.
 */
export const ACCOUNT_TOKEN_NAMESPACE = "6f1b2c1e-8d4a-4c1b-9a57-3b1d0c2e7f10";
export function accountTokenFor(uid: string): string {
  return uuidv5(uid, ACCOUNT_TOKEN_NAMESPACE);
}

/** What the server keeps about each purchase on the buyer's profile. */
export interface StoreEntry {
  transaction_id: string;
  product_id: string;
  grant: Grant;
  environment: string;
  at: string;
}
export const STORE_LEDGER_MAX = 30;

export interface Inventory extends BrickWallet {
  hard_hats?: number;
  store_ledger?: StoreEntry[];
}

/** The subset of Apple's decoded transaction the rules below read. */
export interface VerifiedTransaction {
  transactionId?: string;
  productId?: string;
  bundleId?: string;
  appAccountToken?: string;
  type?: string;
  revocationDate?: number;
  environment?: string;
}

export type RedeemRefusal =
  | "unknown_product"
  | "wrong_app"
  | "not_consumable"
  | "wrong_account"
  | "revoked"
  | "no_transaction";

/** Checks that don't need the database. Null = fine. */
export function refuseTransaction(t: VerifiedTransaction, uid: string): RedeemRefusal | null {
  if (!t.transactionId) return "no_transaction";
  if (t.bundleId !== BUNDLE_ID) return "wrong_app";
  if (!grantFor(t.productId)) return "unknown_product";
  if (t.type && t.type !== "Consumable") return "not_consumable";
  if (!t.appAccountToken || t.appAccountToken.toLowerCase() !== accountTokenFor(uid)) return "wrong_account";
  if (t.revocationDate) return "revoked";
  return null;
}

/**
 * Credit a verified purchase. Returns the fields to write on users/{uid}, or
 * null when this transaction is already on the ledger (a retry — the app
 * then just finishes the transaction).
 */
export function applyPurchase(
  inv: Inventory | null | undefined,
  t: { transactionId: string; productId: string; environment?: string },
  at: string,
): { hard_hats: number; bricks: number; brick_ledger?: BrickEntry[]; store_ledger: StoreEntry[] } | null {
  const ledger = inv?.store_ledger ?? [];
  if (ledger.some((e) => e.transaction_id === t.transactionId)) return null;
  const grant = grantFor(t.productId);
  if (!grant) return null;
  const entry: StoreEntry = {
    transaction_id: t.transactionId,
    product_id: t.productId,
    grant,
    environment: t.environment ?? "Production",
    at,
  };
  const out: { hard_hats: number; bricks: number; brick_ledger?: BrickEntry[]; store_ledger: StoreEntry[] } = {
    hard_hats: (inv?.hard_hats ?? 0) + (grant.hard_hats ?? 0),
    bricks: inv?.bricks ?? 0,
    store_ledger: [...ledger, entry].slice(-STORE_LEDGER_MAX),
  };
  if (grant.bricks) {
    const credit = applyBrickEntry(inv, {
      event_id: `purchase-${t.transactionId}`,
      amount: grant.bricks,
      reason: "purchase",
      at,
    });
    if (credit) {
      out.bricks = credit.bricks;
      out.brick_ledger = credit.brick_ledger;
    }
  }
  return out;
}

/**
 * Putting your hard hats into a city: how many actually move. Clamped to
 * what you hold and to the city's empty slots. Zero → null.
 */
export function hatTransferQuote(params: { held: number; streakFreezes: number; cap: number; count: number }): number | null {
  const empty = Math.max(0, params.cap - params.streakFreezes);
  const n = Math.max(0, Math.min(Math.floor(params.count), empty, Math.floor(params.held)));
  return n > 0 ? n : null;
}
