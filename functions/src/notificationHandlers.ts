/**
 * Callables for managing a user's FCM registration tokens. Tokens are stored
 * on `users/{uid}.push_tokens` (array — one per signed-in device). The client
 * registers on launch (after permission) and unregisters on sign-out.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "./auth";
import { isValidPushToken } from "./push";
import { notifyUids } from "./notify";
import { testNotice } from "./eventMessages";
import { touchLastSeen } from "./presence";

const db = () => getFirestore();

export const registerPushToken = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const token = request.data?.token;

  if (!isValidPushToken(token)) {
    throw new HttpsError("invalid-argument", "A valid FCM registration token is required");
  }

  // merge:true creates the doc if the user registers before their first
  // create/join; arrayUnion dedups so repeat registrations are no-ops.
  // Other fields (display_name, group_ids, created_at) are left untouched.
  await db()
    .collection("users")
    .doc(uid)
    .set({ push_tokens: FieldValue.arrayUnion(token) }, { merge: true });

  // The app registers once per session, on launch — a clean "opened the app"
  // signal even for someone who never taps into a city (presence.ts).
  await touchLastSeen(uid);

  return { success: true };
});

/**
 * Send a test push to the caller's own device(s). Self-only (uses the caller's
 * uid), so it's harmless — you can only notify yourself. Handy for verifying
 * the end-to-end pipeline (token → FCM → APNs → device) from a dev button.
 */
export const sendTestPush = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  await notifyUids([uid], testNotice());
  return { success: true };
});

export const unregisterPushToken = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const token = request.data?.token;

  if (typeof token !== "string" || !token) {
    throw new HttpsError("invalid-argument", "token is required");
  }

  await db()
    .collection("users")
    .doc(uid)
    .set({ push_tokens: FieldValue.arrayRemove(token) }, { merge: true });

  return { success: true };
});
