/**
 * City settings callable — updateCitySettings.
 *
 *   updateCitySettings { group_id, group_name?, daily_goal?, goal_category?, health_goal? }
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
 * `health_goal` (healthGoal.ts): a HealthGoal sets what Apple Health counts
 * for this city; `null` turns Health off for it. Changing it alone sends no
 * push — it changes how check-ins are proven, not what the crew committed to.
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
import { notice } from "./eventMessages";
import { normalizeGoalCategory } from "./goals";
import { HealthGoal, cleanHealthGoal, isHealthGoal } from "./healthGoal";
import { groupToResponse, requireGoalCategory, requireTrimmed } from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

export const updateCitySettings = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, group_name, daily_goal, goal_category, health_goal } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");

  // Validate everything before touching the city, with the createGroup rules.
  const name = group_name === undefined ? undefined : requireTrimmed(group_name, "group_name", 3, 40);
  const goal = daily_goal === undefined ? undefined : requireTrimmed(daily_goal, "daily_goal", 1, 200);
  const type = goal_category === undefined ? undefined : requireGoalCategory(goal_category);
  const healthGoal = health_goal === undefined ? undefined : requireHealthGoalSetting(health_goal);

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  const callerName = memberNameForUid(snap.data()!, uid);
  // maybeProcessDay is a no-op when the day is already settled.
  const data = await maybeProcessDay(group_id, snap.data()!);

  const updates: Record<string, unknown> = {};
  if (name !== undefined && name !== data.group_name) updates.group_name = name;
  if (goal !== undefined && goal !== data.daily_goal) updates.daily_goal = goal;
  if (type !== undefined && type !== normalizeGoalCategory(data.goal_category)) updates.goal_category = type;
  if (healthGoal !== undefined && !sameHealthGoalSetting(healthGoal, data.health_goal)) updates.health_goal = healthGoal;

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
      notice(message, {
        type: "city_settings",
        category: "crew",
        priority: "normal",
        variant: "city_settings.goal.v2",
      }),
      callerName,
    );
  }

  return groupToResponse(group_id, after);
});

/** A HealthGoal (only its known fields are kept) or `null` = off. */
function requireHealthGoalSetting(v: unknown): HealthGoal | null {
  if (v === null) return null;
  if (!isHealthGoal(v)) throw new HttpsError("invalid-argument", "health_goal is not a valid Health goal");
  return cleanHealthGoal(v);
}

/** Is the requested setting what's already stored? (absent ≠ null: null is an explicit "off"). */
function sameHealthGoalSetting(next: HealthGoal | null, stored: unknown): boolean {
  if (next === null) return stored === null;
  if (!isHealthGoal(stored)) return false;
  return JSON.stringify(cleanHealthGoal(stored)) === JSON.stringify(next);
}
