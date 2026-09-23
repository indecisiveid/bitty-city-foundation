/**
 * City shop callables.
 *
 *   buyHardHats  { group_id, count }  — spend the caller's bricks to refill
 *                                       this city's hard hats, up to the cap
 *
 * Server-authoritative like every other write: the client never touches
 * `bricks` or `streak_freezes`. One transaction covers the wallet and the
 * city so a refill can't debit without crediting or vice versa. The spend is
 * written to the freeze ledger as a `refill` event so the rest of the crew
 * sees "Sam bought 2 hard hats".
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import { FREEZE_CAP, FreezeEvent, appendFreezeEvent } from "./gameLogic";
import { applyBrickEntry, hatRefillQuote, HAT_PRICE_BRICKS } from "./bricks";
import { memberNameForUid, maybeProcessDay } from "./groupHandlers";
import { normalizeGameMode } from "./gameMode";
import { groupToResponse } from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

export const buyHardHats = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, count } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");
  const wanted = typeof count === "number" && count > 0 ? count : 1;

  const groupRef = db().collection("groups").doc(group_id);
  const userRef = db().collection("users").doc(uid);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  // Settle first so the refill applies to today's stock, not yesterday's.
  await maybeProcessDay(group_id, snap.data()!);

  let finalGroup: FirebaseFirestore.DocumentData | null = null;
  let bricksLeft = 0;
  await db().runTransaction(async (tx) => {
    const [g, u] = await Promise.all([tx.get(groupRef), tx.get(userRef)]);
    const group = g.data()!;
    const member = memberNameForUid(group, uid);
    const quote = hatRefillQuote({
      streakFreezes: group.streak_freezes ?? 0,
      cap: FREEZE_CAP,
      count: wanted,
    });
    if (!quote) {
      throw new HttpsError("failed-precondition", "Hard hats are full", { reason: "full" });
    }
    const wallet = u.exists ? u.data()! : null;
    const have = wallet?.bricks ?? 0;
    if (have < quote.cost) {
      throw new HttpsError(
        "failed-precondition",
        `Not enough bricks: ${quote.cost} needed, ${have} in hand`,
        { reason: "bricks", needed: quote.cost, have },
      );
    }
    const now = new Date().toISOString();
    const debit = applyBrickEntry(wallet, {
      event_id: `hats-${uuidv4()}`,
      amount: -quote.cost,
      reason: "hats",
      group_id,
      at: now,
    });
    if (!debit) throw new HttpsError("failed-precondition", "Not enough bricks", { reason: "bricks" });

    const remaining = (group.streak_freezes ?? 0) + quote.count;
    const event: FreezeEvent = {
      date: now.slice(0, 10),
      kind: "refill",
      mode: normalizeGameMode(group.game_mode),
      covered: [],
      days: quote.count,
      remaining,
      by: member,
      at: now,
    };
    const groupUpdates = {
      streak_freezes: remaining,
      last_freeze_event: event,
      freeze_ledger: appendFreezeEvent(group.freeze_ledger, event),
    };
    tx.set(userRef, debit, { merge: true });
    tx.update(groupRef, groupUpdates);
    finalGroup = { ...group, ...groupUpdates };
    bricksLeft = debit.bricks;
  });

  return { ...groupToResponse(group_id, finalGroup!), bricks: bricksLeft, hat_price: HAT_PRICE_BRICKS };
});
