/**
 * Game mode callables — setGameMode / dismissModeSuggestion.
 *
 * Server-authoritative like every other write. ANY member may switch the
 * mode (the requirement, not an oversight: the mode is the crew's contract
 * with itself, not the founder's). The pending day is settled first so a
 * switch can never re-score a day already decided; it applies from the next
 * settlement pass, which the app phrases as "from the next reset".
 *
 *   setGameMode          { group_id, mode: "easy" | "hard" }
 *   dismissModeSuggestion { group_id }   — "Keep hard mode": this member
 *                                          won't see the sheet again for
 *                                          this suggestion.
 *
 * A switch notifies the rest of the crew, because it moves the bar more
 * than any join or pause does (see crewMessages).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getProcessingDate } from "./gameLogic";
import { memberNameForUid, maybeProcessDay } from "./groupHandlers";
import { activeMembersOn, rosterOf } from "./pauses";
import { GameMode, isGameMode, normalizeGameMode } from "./gameMode";
import { modeChangedMessage } from "./crewMessages";
import { notifyAllMembers } from "./notify";
import { groupToResponse } from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

async function loadSettled(group_id: string) {
  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  // maybeProcessDay is a no-op when the day is already settled.
  const data = await maybeProcessDay(group_id, snap.data()!);
  const today = getProcessingDate(data.goal_reset_time, data.goal_reset_timezone ?? "UTC");
  return { groupRef, data, today };
}

export const setGameMode = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, mode } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");
  if (!isGameMode(mode)) {
    throw new HttpsError("invalid-argument", "mode must be 'easy' or 'hard'");
  }

  const { groupRef, data, today } = await loadSettled(group_id);
  const callerName = memberNameForUid(data, uid);

  const before: GameMode = normalizeGameMode(data.game_mode);
  if (before === mode && isGameMode(data.game_mode)) {
    // Nothing to change, nothing to announce.
    return groupToResponse(group_id, data);
  }

  // A switch answers the suggestion either way, so it stops re-opening.
  const updates = { game_mode: mode, game_mode_set_by: uid, mode_suggestion: null };
  await groupRef.update(updates);
  const after: FirebaseFirestore.DocumentData = { ...data, ...updates };

  if (before !== mode) {
    const activeCount = activeMembersOn(rosterOf(after), today).length;
    await notifyAllMembers(
      group_id,
      after,
      modeChangedMessage(callerName, after.group_name ?? "your city", mode, activeCount),
      callerName,
    );
  }

  return groupToResponse(group_id, after);
});

export const dismissModeSuggestion = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  const data = snap.data()!;
  memberNameForUid(data, uid);

  if (!data.mode_suggestion) return groupToResponse(group_id, data);

  await groupRef.update({ "mode_suggestion.dismissed_by": FieldValue.arrayUnion(uid) });
  const dismissed: string[] = data.mode_suggestion.dismissed_by ?? [];
  const after = {
    ...data,
    mode_suggestion: {
      ...data.mode_suggestion,
      dismissed_by: dismissed.includes(uid) ? dismissed : [...dismissed, uid],
    },
  };
  return groupToResponse(group_id, after);
});
