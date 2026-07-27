/**
 * sendKudos — cheer a teammate who finished today's goal.
 *
 * Server-authoritative like every other write: the sender is the caller's
 * uid (never a client-sent name), the recipient must be a member of the same
 * group who is already in `completions_today`, and self-kudos are refused.
 * One kudo per sender→recipient per day; the repeat is a no-op that sends no
 * second push (see `applyKudos`).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getProcessingDate } from "./gameLogic";
import { memberNameForUid } from "./groupHandlers";
import { applyKudos, KudosState } from "./kudos";
import { notifyMembers } from "./notify";
import { requireAuth } from "./auth";

const db = () => getFirestore();

export const sendKudos = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, to_member } = request.data ?? {};

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }
  if (typeof to_member !== "string" || !to_member.trim()) {
    throw new HttpsError("invalid-argument", "to_member is required");
  }

  const groupRef = db().collection("groups").doc(group_id);

  let fromName = "";
  let isNew = false;
  let finalData: FirebaseFirestore.DocumentData | null = null;
  let kudosState: KudosState | null = null;

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(groupRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Group not found");
    }
    const data = snap.data()!;

    // Throws failed-precondition if the caller isn't in this group.
    fromName = memberNameForUid(data, uid);

    const members: string[] = data.group_members ?? [];
    if (!members.includes(to_member)) {
      throw new HttpsError("not-found", "That member isn't in this city");
    }
    if (to_member === fromName) {
      throw new HttpsError("failed-precondition", "You can't send yourself kudos");
    }
    const completions: string[] = data.completions_today ?? [];
    if (!completions.includes(to_member)) {
      throw new HttpsError(
        "failed-precondition",
        "Kudos are for teammates who finished today's goal",
      );
    }

    const today = getProcessingDate(
      data.goal_reset_time,
      data.goal_reset_timezone ?? "UTC",
    );
    const result = applyKudos(data.kudos_today, today, fromName, to_member);
    isNew = result.isNew;
    kudosState = result.state;
    finalData = { ...data, kudos_today: result.state };

    if (result.isNew) {
      tx.update(groupRef, { kudos_today: result.state });
    }
  });

  // Push the recipient — best-effort, after the write, and only when this
  // call is the one that recorded the kudo (a re-tap stays silent).
  if (isNew && finalData) {
    await notifyMembers(group_id, finalData, [to_member], {
      title: "❤️ Kudos!",
      body: `${fromName} sent you kudos!`,
      data: { type: "kudos", from: fromName },
    });
  }

  return { success: true, is_new: isNew, kudos_today: kudosState };
});
