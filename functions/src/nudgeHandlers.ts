/**
 * sendNudge — manually remind a crew member to do today's goal.
 *
 * Server-authoritative like every other write: the sender is the caller's
 * uid (never a client-sent name), the recipient must be a member of the same
 * group who is *not* yet in `completions_today`, and self-nudges are refused.
 * One nudge per sender→recipient per day; the repeat is a no-op that sends no
 * second push (see `applyNudge`) — that is the "only once a day" rule, and it
 * lives here rather than in the UI because a disabled button is a suggestion,
 * not an enforcement.
 *
 * Requires a build in progress: the nudge exists to get today's build over
 * the line, and with no `current_build` there is nothing to be late for.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getProcessingDate } from "./gameLogic";
import { memberNameForUid } from "./groupHandlers";
import { applyNudge, nudgeBody, NudgeState } from "./nudges";
import { notifyMembers } from "./notify";
import { requireAuth } from "./auth";

const db = () => getFirestore();

export const sendNudge = onCall({ enforceAppCheck: true }, async (request) => {
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
  let goal = "";
  let finalData: FirebaseFirestore.DocumentData | null = null;
  let nudgeState: NudgeState | null = null;

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
      throw new HttpsError("failed-precondition", "You can't remind yourself");
    }
    if (!data.current_build) {
      throw new HttpsError(
        "failed-precondition",
        "There's no build in progress to remind them about",
      );
    }
    const completions: string[] = data.completions_today ?? [];
    if (completions.includes(to_member)) {
      throw new HttpsError(
        "failed-precondition",
        "They already finished today's goal",
      );
    }

    goal = data.daily_goal ?? "";

    const today = getProcessingDate(
      data.goal_reset_time,
      data.goal_reset_timezone ?? "UTC",
    );
    const result = applyNudge(data.nudges_today, today, fromName, to_member);
    isNew = result.isNew;
    nudgeState = result.state;
    finalData = { ...data, nudges_today: result.state };

    if (result.isNew) {
      tx.update(groupRef, { nudges_today: result.state });
    }
  });

  // Push the recipient — best-effort, after the write, and only when this
  // call is the one that recorded the nudge (a re-tap stays silent).
  if (isNew && finalData) {
    await notifyMembers(group_id, finalData, [to_member], {
      title: "⏰ Nudge!",
      body: nudgeBody(fromName, goal),
      data: { type: "nudge", from: fromName },
    });
  }

  return { success: true, is_new: isNew, nudges_today: nudgeState };
});
