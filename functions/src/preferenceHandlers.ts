/**
 * Preference callables — see preferences.ts for the fields.
 *
 *   markTipsSeen    { ids: string[] }                         → { seen_tips }
 *   setEmailUpdates { enabled: boolean, source: "settings"|"tip" } → { email_updates }
 *
 * users/{uid} is server-written only (firestore.rules), so these are the
 * app's way to record either. Both are per-person and touch no city.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { requireAuth } from "./auth";
import {
  EmailUpdates,
  MAX_TIPS_PER_CALL,
  isEmailUpdateSource,
  isTipId,
  mergeSeenTips,
} from "./preferences";

const db = () => getFirestore();

export const markTipsSeen = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const ids: unknown = request.data?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TIPS_PER_CALL || !ids.every(isTipId)) {
    throw new HttpsError("invalid-argument", "ids must be 1–20 tip ids");
  }
  const ref = db().collection("users").doc(uid);
  let seen: string[] = [];
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    seen = mergeSeenTips(snap.data()?.seen_tips, ids as string[]);
    tx.set(ref, { seen_tips: seen }, { merge: true });
  });
  return { seen_tips: seen };
});

export const setEmailUpdates = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { enabled, source } = request.data ?? {};
  if (typeof enabled !== "boolean") throw new HttpsError("invalid-argument", "enabled must be true or false");
  if (!isEmailUpdateSource(source)) throw new HttpsError("invalid-argument", "source must be settings or tip");
  const record: EmailUpdates = { enabled, at: new Date().toISOString(), source };
  await db().collection("users").doc(uid).set({ email_updates: record }, { merge: true });
  return { email_updates: record };
});
