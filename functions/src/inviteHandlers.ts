/**
 * Invite links — previewInvite.
 *
 *   previewInvite { group_code } → InvitePreview
 *
 * Backs the app's "Join Riley's city?" screen, which an invite link
 * (www.bitty.city/join/<code>) opens. Read-only: joining still goes through
 * joinGroup. See invites.ts for what the preview shows and why.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { requireAuth } from "./auth";
import { requireTrimmed } from "./utils";
import { invitePreviewOf } from "./invites";

const db = () => getFirestore();

export const previewInvite = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const code = requireTrimmed(request.data?.group_code, "group_code", 6, 6).toUpperCase();

  const codeSnap = await db().collection("group_codes").doc(code).get();
  if (!codeSnap.exists) throw new HttpsError("not-found", "Invalid group code");
  const groupId: string = codeSnap.data()!.group_id;

  const [groupSnap, userSnap] = await Promise.all([
    db().collection("groups").doc(groupId).get(),
    db().collection("users").doc(uid).get(),
  ]);
  if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found");

  return invitePreviewOf(groupId, groupSnap.data()!, uid, userSnap.data()?.group_ids ?? []);
});
