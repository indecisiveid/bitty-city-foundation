/**
 * Store callables.
 *
 *   redeemPurchase  { jws }                 — verify an App Store purchase and
 *                                             credit the pack to the caller
 *   placeHardHats   { group_id, count }     — move hard hats from the caller's
 *                                             inventory into a city's pool
 *
 * The app finishes a StoreKit transaction only after `redeemPurchase`
 * returns, so a crash between paying and crediting is retried on the next
 * launch (unfinished transactions are re-delivered). Redeeming is idempotent
 * per transaction: `store_transactions/{id}` records which account got it,
 * and the buyer's own ledger skips a repeat.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { FREEZE_CAP, FreezeEvent, appendFreezeEvent } from "./gameLogic";
import { memberNameForUid, maybeProcessDay } from "./groupHandlers";
import { normalizeGameMode } from "./gameMode";
import { groupToResponse } from "./utils";
import { requireAuth } from "./auth";
import { applyPurchase, hatTransferQuote, refuseTransaction, grantFor } from "./store";
import { verifySignedTransaction } from "./storeVerify";

const db = () => getFirestore();

export const redeemPurchase = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { jws } = request.data ?? {};
  if (typeof jws !== "string" || jws.split(".").length !== 3) {
    throw new HttpsError("invalid-argument", "jws (a signed App Store transaction) is required");
  }
  const t = await verifySignedTransaction(jws);
  if (!t) throw new HttpsError("permission-denied", "That purchase could not be verified", { reason: "unverified" });
  const refusal = refuseTransaction(t, uid);
  if (refusal) throw new HttpsError("failed-precondition", `Purchase refused: ${refusal}`, { reason: refusal });

  const transactionId = t.transactionId!;
  const productId = t.productId!;
  const userRef = db().collection("users").doc(uid);
  const txRef = db().collection("store_transactions").doc(transactionId);
  const at = new Date().toISOString();

  const result = await db().runTransaction(async (tx) => {
    const [txSnap, userSnap] = await Promise.all([tx.get(txRef), tx.get(userRef)]);
    if (txSnap.exists && txSnap.data()?.uid !== uid) {
      throw new HttpsError("failed-precondition", "Purchase refused: wrong_account", { reason: "wrong_account" });
    }
    const inv = userSnap.exists ? userSnap.data()! : null;
    // The global record is the authority: once a transaction is recorded it
    // has been credited, even after it scrolls off the buyer's capped ledger.
    const updates = txSnap.exists
      ? null
      : applyPurchase(inv, { transactionId, productId, environment: t.environment }, at);
    if (!txSnap.exists) {
      tx.create(txRef, { uid, product_id: productId, environment: t.environment ?? null, at });
    }
    if (!updates) {
      return { credited: false, hard_hats: inv?.hard_hats ?? 0, bricks: inv?.bricks ?? 0 };
    }
    tx.set(userRef, updates, { merge: true });
    return { credited: true, hard_hats: updates.hard_hats, bricks: updates.bricks };
  });

  return { ...result, transaction_id: transactionId, product_id: productId, grant: grantFor(productId) };
});

export const placeHardHats = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, count } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");
  const wanted = typeof count === "number" && count > 0 ? count : 1;

  const groupRef = db().collection("groups").doc(group_id);
  const userRef = db().collection("users").doc(uid);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  // Settle first so the hats land in today's stock, not yesterday's.
  await maybeProcessDay(group_id, snap.data()!);

  let finalGroup: FirebaseFirestore.DocumentData | null = null;
  let hatsLeft = 0;
  await db().runTransaction(async (tx) => {
    const [g, u] = await Promise.all([tx.get(groupRef), tx.get(userRef)]);
    const group = g.data()!;
    const member = memberNameForUid(group, uid);
    const held = (u.exists ? u.data()?.hard_hats : 0) ?? 0;
    const n = hatTransferQuote({ held, streakFreezes: group.streak_freezes ?? 0, cap: FREEZE_CAP, count: wanted });
    if (n == null) {
      if (held <= 0) throw new HttpsError("failed-precondition", "No hard hats in your inventory", { reason: "none" });
      throw new HttpsError("failed-precondition", "Hard hats are full", { reason: "full" });
    }
    const now = new Date().toISOString();
    const remaining = (group.streak_freezes ?? 0) + n;
    const event: FreezeEvent = {
      date: now.slice(0, 10),
      kind: "refill",
      source: "inventory",
      mode: normalizeGameMode(group.game_mode),
      covered: [],
      days: n,
      remaining,
      by: member,
      at: now,
    };
    const groupUpdates = {
      streak_freezes: remaining,
      last_freeze_event: event,
      freeze_ledger: appendFreezeEvent(group.freeze_ledger, event),
    };
    tx.set(userRef, { hard_hats: FieldValue.increment(-n) }, { merge: true });
    tx.update(groupRef, groupUpdates);
    finalGroup = { ...group, ...groupUpdates };
    hatsLeft = held - n;
  });

  return { ...groupToResponse(group_id, finalGroup!), hard_hats: hatsLeft };
});
