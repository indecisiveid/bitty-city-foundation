import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";
import {
  needsDayProcessing,
  getProcessingDate,
  processEndOfDay,
  applyStreakRepair,
  isFirstDayGrace,
  findEmptyTiles,
  BUILDING_DAYS,
  STARTING_FREEZES,
} from "./gameLogic";
import {
  generateGroupCode,
  groupToResponse,
  requireTrimmed,
  requireResetTime,
  EMPTY_CITY,
  MAX_MEMBERS_PER_GROUP,
  MAX_GROUPS_PER_USER,
} from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

/**
 * Resolve the caller's display name inside a group. Membership is
 * uid-based (`member_uids`, index-aligned with the display names in
 * `group_members`); the name remains the currency of the game state
 * (completions_today etc.) so the UI stays name-driven.
 */
function memberNameForUid(
  data: FirebaseFirestore.DocumentData,
  uid: string,
): string {
  const uids: string[] = data.member_uids ?? [];
  const idx = uids.indexOf(uid);
  if (idx === -1) {
    throw new HttpsError("failed-precondition", "Not a member of this group");
  }
  return data.group_members[idx];
}

function createdAtIso(data: FirebaseFirestore.DocumentData): string | null {
  return data.created_at?.toDate?.()?.toISOString?.() ?? null;
}

/** Legacy groups predate last_activity_date — fall back to creation day. */
function lastActivityFallback(
  data: FirebaseFirestore.DocumentData,
  tz: string,
): string | null {
  if (data.last_activity_date) return data.last_activity_date;
  const iso = createdAtIso(data);
  if (!iso) return null;
  const dt = DateTime.fromISO(iso).setZone(tz);
  return dt.isValid ? dt.toISODate() : iso.slice(0, 10);
}

async function maybeProcessDay(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
): Promise<FirebaseFirestore.DocumentData> {
  const goalResetTimezone: string = data.goal_reset_timezone ?? "UTC";
  if (!needsDayProcessing(data.goal_reset_time, data.last_processed_date, goalResetTimezone)) {
    return data;
  }

  const processingDate = getProcessingDate(data.goal_reset_time, goalResetTimezone);
  const createdIso = createdAtIso(data);
  const updates = processEndOfDay({
    groupMembers: data.group_members,
    completionsToday: data.completions_today,
    currentBuild: data.current_build ?? null,
    cityMap: data.city_map,
    streak: data.streak,
    buildingCompletions: data.building_completions ?? [],
    processingDate,
    lastActivityDate: lastActivityFallback(data, goalResetTimezone),
    streakFreezes: data.streak_freezes ?? 0,
    frozenDates: data.frozen_dates ?? [],
    brokenStreak: data.broken_streak ?? null,
    lastInactivityMeteorDate: data.last_inactivity_meteor_date ?? null,
    isGraceDay: createdIso
      ? isFirstDayGrace(createdIso, processingDate, data.goal_reset_time, goalResetTimezone)
      : false,
    tileBuildDates: data.tile_build_dates ?? {},
  });

  const writeUpdates: Record<string, unknown> = {
    ...updates,
    last_processed_date: processingDate,
  };

  await db().collection("groups").doc(groupId).update(writeUpdates);

  return { ...data, ...writeUpdates };
}

// --- createGroup ---

export const createGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);

  const groupName = requireTrimmed(request.data.group_name, "group_name", 3, 40);
  const member = requireTrimmed(request.data.member, "member", 1, 30);
  const dailyGoal = requireTrimmed(request.data.daily_goal, "daily_goal", 1, 200);
  const goalResetTime = requireResetTime(request.data.goal_reset_time ?? "00:00");
  const goalResetTimezone =
    typeof request.data.goal_reset_timezone === "string" && request.data.goal_reset_timezone
      ? request.data.goal_reset_timezone
      : "UTC";

  const groupId = uuidv4();
  const userRef = db().collection("users").doc(uid);

  // Retry up to 5 times on code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateGroupCode();

    try {
      await db().runTransaction(async (tx) => {
        const codeRef = db().collection("group_codes").doc(code);
        const [codeSnap, userSnap] = await Promise.all([
          tx.get(codeRef),
          tx.get(userRef),
        ]);

        if (codeSnap.exists) {
          throw new Error("CODE_COLLISION");
        }

        const groupIds: string[] = userSnap.data()?.group_ids ?? [];
        if (groupIds.length >= MAX_GROUPS_PER_USER) {
          throw new HttpsError(
            "failed-precondition",
            `You can be in at most ${MAX_GROUPS_PER_USER} cities`,
          );
        }

        const groupRef = db().collection("groups").doc(groupId);
        const groupData = {
          group_code: code,
          group_name: groupName,
          group_members: [member],
          owner_uid: uid,
          member_uids: [uid],
          daily_goal: dailyGoal,
          goal_reset_time: goalResetTime,
          goal_reset_timezone: goalResetTimezone,
          completions_today: [],
          streak: 0,
          streak_freezes: STARTING_FREEZES,
          frozen_dates: [],
          broken_streak: null,
          last_activity_date: getProcessingDate(goalResetTime, goalResetTimezone),
          last_inactivity_meteor_date: null,
          current_build: null,
          city_map: EMPTY_CITY,
          last_processed_date: null,
          pending_event: null,
          building_completions: [],
          tile_build_dates: {},
          created_at: FieldValue.serverTimestamp(),
        };

        tx.set(codeRef, { group_id: groupId });
        tx.set(groupRef, groupData);
        tx.set(
          userRef,
          {
            display_name: member,
            group_ids: FieldValue.arrayUnion(groupId),
            created_at: userSnap.exists ? userSnap.data()!.created_at ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });

      // Read back with server timestamp resolved
      const snap = await db().collection("groups").doc(groupId).get();
      return groupToResponse(groupId, snap.data()!);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === "CODE_COLLISION") {
        continue;
      }
      throw e;
    }
  }

  throw new HttpsError("internal", "Failed to generate unique group code");
});

// --- joinGroup ---

export const joinGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const rawCode = requireTrimmed(request.data.group_code, "group_code", 6, 6);
  const member = requireTrimmed(request.data.member, "member", 1, 30);

  const code = rawCode.toUpperCase();
  const codeSnap = await db().collection("group_codes").doc(code).get();

  if (!codeSnap.exists) {
    throw new HttpsError("not-found", "Invalid group code");
  }

  const groupId = codeSnap.data()!.group_id;
  const groupRef = db().collection("groups").doc(groupId);
  const userRef = db().collection("users").doc(uid);

  let finalData: FirebaseFirestore.DocumentData;

  await db().runTransaction(async (tx) => {
    const [groupSnap, userSnap] = await Promise.all([
      tx.get(groupRef),
      tx.get(userRef),
    ]);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "Group not found");
    }

    const data = groupSnap.data()!;
    const members: string[] = data.group_members;
    const memberUids: string[] = data.member_uids ?? [];

    // Idempotent — already a member
    if (memberUids.includes(uid)) {
      finalData = data;
      return;
    }

    if (members.length >= MAX_MEMBERS_PER_GROUP) {
      throw new HttpsError(
        "failed-precondition",
        `Group is full (max ${MAX_MEMBERS_PER_GROUP} members)`,
      );
    }

    const groupIds: string[] = userSnap.data()?.group_ids ?? [];
    if (groupIds.length >= MAX_GROUPS_PER_USER) {
      throw new HttpsError(
        "failed-precondition",
        `You can be in at most ${MAX_GROUPS_PER_USER} cities`,
      );
    }

    // Display names are the game-state currency (completions etc.), so
    // they must be unique within a group — suffix on collision.
    let name = member;
    for (let i = 2; members.includes(name); i++) {
      name = `${member} ${i}`;
    }

    tx.update(groupRef, {
      group_members: [...members, name],
      member_uids: [...memberUids, uid],
    });
    tx.set(
      userRef,
      {
        display_name: member,
        group_ids: FieldValue.arrayUnion(groupId),
        created_at: userSnap.exists ? userSnap.data()!.created_at ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    finalData = {
      ...data,
      group_members: [...members, name],
      member_uids: [...memberUids, uid],
    };
  });

  finalData = await maybeProcessDay(groupId, finalData!);
  return groupToResponse(groupId, finalData);
});

// --- getGroup ---

export const getGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const snap = await db().collection("groups").doc(group_id).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  // Membership check (throws failed-precondition for non-members)
  memberNameForUid(snap.data()!, uid);

  const data = await maybeProcessDay(group_id, snap.data()!);
  return groupToResponse(group_id, data);
});

// --- completeGoal ---

export const completeGoal = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  let finalData: FirebaseFirestore.DocumentData;

  // First, run day processing if needed (outside transaction for simplicity)
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  // Now mark completion in a transaction
  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const member = memberNameForUid(freshData, uid);
    const completions: string[] = freshData.completions_today;

    // The current game-day label in the group's timezone — completing the
    // goal is "activity" for the 7-day inactivity meteor.
    const activityDate = getProcessingDate(
      freshData.goal_reset_time,
      freshData.goal_reset_timezone ?? "UTC",
    );

    // Idempotent
    if (completions.includes(member)) {
      finalData = freshData;
      return;
    }

    const newCompletions = [...completions, member];
    tx.update(groupRef, {
      completions_today: newCompletions,
      last_activity_date: activityDate,
    });
    finalData = {
      ...freshData,
      completions_today: newCompletions,
      last_activity_date: activityDate,
    };
  });

  return groupToResponse(group_id, finalData!);
});

// --- selectBuild ---

export const selectBuild = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, type } = request.data;

  if (!group_id || !type) {
    throw new HttpsError("invalid-argument", "group_id and type are required");
  }

  if (!(type in BUILDING_DAYS)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid building type. Must be one of: ${Object.keys(BUILDING_DAYS).join(", ")}`,
    );
  }

  const groupRef = db().collection("groups").doc(group_id);
  let finalData: FirebaseFirestore.DocumentData;

  // Run day processing first
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    memberNameForUid(freshData, uid);

    if (freshData.current_build !== null) {
      throw new HttpsError("failed-precondition", "A build is already in progress");
    }

    // Check if city is full
    const hasEmpty = findEmptyTiles(freshData.city_map).length > 0;
    if (!hasEmpty) {
      throw new HttpsError("failed-precondition", "City is full — no empty tiles");
    }

    const newBuild = {
      type,
      days_required: BUILDING_DAYS[type],
      days_completed: 0,
    };

    tx.update(groupRef, { current_build: newBuild });
    finalData = { ...freshData, current_build: newBuild };
  });

  return groupToResponse(group_id, finalData!);
});

// --- repairStreak ---

export const repairStreak = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  // Settle any pending day first so broken_streak is current
  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  const today = getProcessingDate(
    data.goal_reset_time,
    data.goal_reset_timezone ?? "UTC",
  );
  const repaired = applyStreakRepair({
    buildingCompletions: data.building_completions ?? [],
    frozenDates: data.frozen_dates ?? [],
    brokenStreak: data.broken_streak ?? null,
    todayStr: today,
  });

  if (!repaired) {
    throw new HttpsError(
      "failed-precondition",
      "There's no recently broken streak to repair",
    );
  }

  await groupRef.update({
    frozen_dates: repaired.frozen_dates,
    streak: repaired.streak,
    broken_streak: null,
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- leaveGroup ---

export const leaveGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const userRef = db().collection("users").doc(uid);

  await db().runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      // Already gone — just clean up the membership pointer.
      tx.set(userRef, { group_ids: FieldValue.arrayRemove(group_id) }, { merge: true });
      return;
    }

    const data = groupSnap.data()!;
    const name = memberNameForUid(data, uid);

    if (data.owner_uid === uid) {
      throw new HttpsError(
        "failed-precondition",
        "The founder can't leave their city — delete it instead",
      );
    }

    const idx = (data.member_uids as string[]).indexOf(uid);
    const newMembers = (data.group_members as string[]).filter((_, i) => i !== idx);
    const newUids = (data.member_uids as string[]).filter((_, i) => i !== idx);
    const newCompletions = (data.completions_today as string[]).filter(
      (m) => m !== name,
    );

    tx.update(groupRef, {
      group_members: newMembers,
      member_uids: newUids,
      completions_today: newCompletions,
    });
    tx.set(userRef, { group_ids: FieldValue.arrayRemove(group_id) }, { merge: true });
  });

  return { success: true };
});

// --- deleteGroup ---

export const deleteGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const data = snap.data()!;
  // Server-enforced ownership: only the founder can delete a city.
  if (data.owner_uid !== uid) {
    throw new HttpsError(
      "permission-denied",
      "Only the city's founder can delete it",
    );
  }

  const code = data.group_code;
  const memberUids: string[] = data.member_uids ?? [];
  const batch = db().batch();
  batch.delete(groupRef);
  batch.delete(db().collection("group_codes").doc(code));
  for (const memberUid of memberUids) {
    batch.set(
      db().collection("users").doc(memberUid),
      { group_ids: FieldValue.arrayRemove(group_id) },
      { merge: true },
    );
  }
  await batch.commit();

  return { success: true };
});

// --- deleteAccount ---
// App Store guideline 5.1.1(v): apps with account creation must offer
// in-app account deletion. Removes the caller from every city they're in
// (cities they founded are deleted for everyone — the app warns first),
// deletes users/{uid}, then the Auth user itself.

export const deleteAccount = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const userRef = db().collection("users").doc(uid);
  const userSnap = await userRef.get();
  const groupIds: string[] = userSnap.data()?.group_ids ?? [];

  for (const groupId of groupIds) {
    const groupRef = db().collection("groups").doc(groupId);
    const snap = await groupRef.get();
    if (!snap.exists) continue;
    const data = snap.data()!;

    if (data.owner_uid === uid) {
      // Founder: the city goes with them.
      const batch = db().batch();
      batch.delete(groupRef);
      batch.delete(db().collection("group_codes").doc(data.group_code));
      for (const memberUid of (data.member_uids as string[]) ?? []) {
        if (memberUid === uid) continue;
        batch.set(
          db().collection("users").doc(memberUid),
          { group_ids: FieldValue.arrayRemove(groupId) },
          { merge: true },
        );
      }
      await batch.commit();
    } else {
      const idx = ((data.member_uids as string[]) ?? []).indexOf(uid);
      if (idx === -1) continue;
      const name = data.group_members[idx];
      await groupRef.update({
        group_members: (data.group_members as string[]).filter((_, i) => i !== idx),
        member_uids: (data.member_uids as string[]).filter((_, i) => i !== idx),
        completions_today: (data.completions_today as string[]).filter((m) => m !== name),
      });
    }
  }

  await userRef.delete();
  await getAuth().deleteUser(uid);

  return { success: true };
});

// --- upsertProfile ---
// Creates/updates the caller's users/{uid} doc. Called after sign-up (and
// harmlessly after sign-in) so the display name persists across groups and
// devices. Writes stay server-only; clients read the doc via Firestore rules.

export const upsertProfile = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const displayName = requireTrimmed(request.data.display_name, "display_name", 1, 30);

  const userRef = db().collection("users").doc(uid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    tx.set(
      userRef,
      {
        display_name: displayName,
        group_ids: snap.data()?.group_ids ?? [],
        created_at: snap.exists
          ? snap.data()!.created_at ?? FieldValue.serverTimestamp()
          : FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return { display_name: displayName };
});
