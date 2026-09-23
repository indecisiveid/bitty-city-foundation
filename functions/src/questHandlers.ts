/**
 * Quest callables. The quest itself is rolled by the scheduler and advanced
 * by the game callables (questRunner.ts); a person only ever dismisses one.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { requireAuth, requireDemoAccess } from "./auth";
import { memberNameForUid } from "./groupHandlers";
import { getProcessingDate } from "./gameLogic";
import { groupToResponse } from "./utils";
import { Quest, QuestId, CATALOG_QUESTS, mergeQuestConfig, offerQuest } from "./quests";
import { withDisplay, questOfferedNotice } from "./questMessages";
import { questRng, sendQuestNotice, signalsFor } from "./questRunner";

const db = () => getFirestore();

/**
 * "Not for me": hide this quest's card for the caller and stop its pushes to
 * them. The quest carries on for the rest of the crew. Idempotent.
 */
export const dismissQuest = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");
  const ref = db().collection("groups").doc(group_id);
  const after = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Group not found");
    const data = snap.data()!;
    memberNameForUid(data, uid);
    const q = (data.quest as Quest) ?? null;
    if (!q || q.dismissed_by.includes(uid)) return data;
    const quest = withDisplay({ ...q, dismissed_by: [...q.dismissed_by, uid] });
    tx.update(ref, { quest });
    return { ...data, quest };
  });
  return groupToResponse(group_id, after);
});

/**
 * DEV (allowlisted): offer a specific quest to a city now, bypassing the
 * cadence and the `enabled` switch, with the real announce push — so every
 * quest can be exercised end to end before quests are switched on.
 */
export const demoOfferQuest = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
  const { group_id, quest_id } = request.data ?? {};
  if (!group_id || !(quest_id in CATALOG_QUESTS)) {
    throw new HttpsError("invalid-argument", `group_id and quest_id (${Object.keys(CATALOG_QUESTS).join(", ")}) are required`);
  }
  const ref = db().collection("groups").doc(group_id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  const data = snap.data()!;
  const today = getProcessingDate(data.goal_reset_time ?? "00:00", data.goal_reset_timezone ?? "UTC");
  const quest = withDisplay(
    offerQuest(quest_id as QuestId, signalsFor(group_id, data, today), mergeQuestConfig({ enabled: true }), questRng(group_id, today, "demo")),
  );
  await ref.update({ quest, quest_rolled_on: today });
  const after = { ...data, quest, quest_rolled_on: today };
  await sendQuestNotice(group_id, after, quest, questOfferedNotice(quest, data.group_name ?? "your city"));
  return groupToResponse(group_id, after);
});
