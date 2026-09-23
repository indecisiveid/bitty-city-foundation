/**
 * City settings callable — updateCitySettings.
 *
 *   updateCitySettings { group_id, group_name?, daily_goal?, goal_type? }
 *
 * Backs the app's city settings page. Send only the fields being changed;
 * an omitted field is left as it is. ANY member may edit, like setGameMode:
 * the goal is the crew's contract with itself, not the founder's. The
 * pending day is settled first so an edit never lands inside a day the
 * scheduler hasn't closed yet.
 *
 * A new goal applies immediately. Check-ins already made today stand; they
 * were made against the goal that was showing at the time.
 *
 * The reset time and timezone are NOT editable here: moving the day
 * boundary mid-game can skip or double-settle a day, and needs its own
 * design.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { memberNameForUid, maybeProcessDay } from "./groupHandlers";
import { citySettingsChangedMessage } from "./crewMessages";
import { notifyAllMembers } from "./notify";
import { normalizeGoalType } from "./goals";
import { groupToResponse, requireGoalType, requireTrimmed } from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

export const updateCitySettings = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, group_name, daily_goal, goal_type } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");

  // Validate everything before touching the city, with the createGroup rules.
  const name = group_name === undefined ? undefined : requireTrimmed(group_name, "group_name", 3, 40);
  const goal = daily_goal === undefined ? undefined : requireTrimmed(daily_goal, "daily_goal", 1, 200);
  const type = goal_type === undefined ? undefined : requireGoalType(goal_type);

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  const callerName = memberNameForUid(snap.data()!, uid);
  // maybeProcessDay is a no-op when the day is already settled.
  const data = await maybeProcessDay(group_id, snap.data()!);

  const updates: Record<string, unknown> = {};
  if (name !== undefined && name !== data.group_name) updates.group_name = name;
  if (goal !== undefined && goal !== data.daily_goal) updates.daily_goal = goal;
  if (type !== undefined && type !== normalizeGoalType(data.goal_type)) updates.goal_type = type;

  if (Object.keys(updates).length === 0) {
    // Nothing to change, nothing to announce.
    return groupToResponse(group_id, data);
  }

  await groupRef.update(updates);
  const after: FirebaseFirestore.DocumentData = { ...data, ...updates };

  const message = citySettingsChangedMessage(callerName, data.group_name ?? "your city", {
    newName: updates.group_name as string | undefined,
    newGoal: updates.daily_goal as string | undefined,
  });
  if (message) {
    await notifyAllMembers(
      group_id,
      after,
      { ...message, data: { type: "city_settings" } },
      callerName,
    );
  }

  return groupToResponse(group_id, after);
});
