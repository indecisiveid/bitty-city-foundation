/**
 * Invite links — previewInvite.
 *
 *   previewInvite { group_code } → InvitePreview
 *
 * Backs the app's "Join Riley's city?" screen, which an invite link
 * (www.bitty.city/join/<code>) opens. Read-only: joining still goes through
 * joinGroup. See invites.ts for what the preview shows and why.
 *
 * Works SIGNED OUT too (App Check still applies): a friend who doesn't have
 * an account yet sees who invited them before "Sign up to join". Signed out,
 * the viewer is in no city, so is_member and at_city_limit are false.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { requireTrimmed } from "./utils";
import { invitePreviewOf } from "./invites";

const db = () => getFirestore();

export const previewInvite = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = request.auth?.uid ?? null;
  const code = requireTrimmed(request.data?.group_code, "group_code", 6, 6).toUpperCase();

  const codeSnap = await db().collection("group_codes").doc(code).get();
  if (!codeSnap.exists) throw new HttpsError("not-found", "Invalid group code");
  const groupId: string = codeSnap.data()!.group_id;

  const [groupSnap, userSnap] = await Promise.all([
    db().collection("groups").doc(groupId).get(),
    uid ? db().collection("users").doc(uid).get() : Promise.resolve(null),
  ]);
  if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found");

  return invitePreviewOf(groupId, groupSnap.data()!, uid, userSnap?.data()?.group_ids ?? []);
});
