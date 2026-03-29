import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import {
  needsDayProcessing,
  getProcessingDate,
  processEndOfDay,
  findEmptyTiles,
  BUILDING_DAYS,
} from "./gameLogic";
import { generateGroupCode, EMPTY_CITY } from "./utils";

const db = () => getFirestore();

function groupToResponse(groupId: string, data: FirebaseFirestore.DocumentData) {
  return {
    group_id: groupId,
    group_code: data.group_code,
    group_name: data.group_name,
    group_members: data.group_members,
    daily_goal: data.daily_goal,
    goal_reset_time: data.goal_reset_time,
    completions_today: data.completions_today,
    streak: data.streak,
    current_build: data.current_build ?? null,
    city_map: data.city_map,
    last_processed_date: data.last_processed_date ?? null,
    pending_event: data.pending_event ?? null,
    created_at: data.created_at?.toDate?.()?.toISOString?.() ?? new Date().toISOString(),
  };
}

async function maybeProcessDay(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
): Promise<FirebaseFirestore.DocumentData> {
  if (!needsDayProcessing(data.goal_reset_time, data.last_processed_date)) {
    return data;
  }

  const updates = processEndOfDay({
    groupMembers: data.group_members,
    completionsToday: data.completions_today,
    currentBuild: data.current_build ?? null,
    cityMap: data.city_map,
    streak: data.streak,
  });

  const writeUpdates: Record<string, unknown> = {
    ...updates,
    last_processed_date: getProcessingDate(data.goal_reset_time),
  };

  await db().collection("groups").doc(groupId).update(writeUpdates);

  return { ...data, ...writeUpdates };
}

// --- createGroup ---

export const createGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const { group_name, member, daily_goal, goal_reset_time = "00:00" } =
    request.data;

  if (!group_name || !member || !daily_goal) {
    throw new HttpsError("invalid-argument", "group_name, member, and daily_goal are required");
  }

  const groupId = uuidv4();

  // Retry up to 5 times on code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateGroupCode();

    try {
      await db().runTransaction(async (tx) => {
        const codeRef = db().collection("group_codes").doc(code);
        const codeSnap = await tx.get(codeRef);

        if (codeSnap.exists) {
          throw new Error("CODE_COLLISION");
        }

        const groupRef = db().collection("groups").doc(groupId);
        const groupData = {
          group_code: code,
          group_name,
          group_members: [member],
          daily_goal,
          goal_reset_time,
          completions_today: [],
          streak: 0,
          current_build: null,
          city_map: EMPTY_CITY,
          last_processed_date: null,
          pending_event: null,
          created_at: FieldValue.serverTimestamp(),
        };

        tx.set(codeRef, { group_id: groupId });
        tx.set(groupRef, groupData);
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
  const { group_code, member } = request.data;

  if (!group_code || !member) {
    throw new HttpsError("invalid-argument", "group_code and member are required");
  }

  const code = group_code.toUpperCase();
  const codeSnap = await db().collection("group_codes").doc(code).get();

  if (!codeSnap.exists) {
    throw new HttpsError("not-found", "Invalid group code");
  }

  const groupId = codeSnap.data()!.group_id;
  const groupRef = db().collection("groups").doc(groupId);

  let finalData: FirebaseFirestore.DocumentData;

  await db().runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "Group not found");
    }

    const data = groupSnap.data()!;
    const members: string[] = data.group_members;

    // Idempotent — already a member
    if (members.includes(member)) {
      finalData = data;
      return;
    }

    if (members.length >= 4) {
      throw new HttpsError("failed-precondition", "Group is full (max 4 members)");
    }

    tx.update(groupRef, {
      group_members: [...members, member],
    });

    finalData = { ...data, group_members: [...members, member] };
  });

  finalData = await maybeProcessDay(groupId, finalData!);
  return groupToResponse(groupId, finalData);
});

// --- getGroup ---

export const getGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const snap = await db().collection("groups").doc(group_id).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const data = await maybeProcessDay(group_id, snap.data()!);
  return groupToResponse(group_id, data);
});

// --- completeGoal ---

export const completeGoal = onCall({ enforceAppCheck: true }, async (request) => {
  const { group_id, member } = request.data;

  if (!group_id || !member) {
    throw new HttpsError("invalid-argument", "group_id and member are required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  let finalData: FirebaseFirestore.DocumentData;

  // First, run day processing if needed (outside transaction for simplicity)
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;

  if (!data.group_members.includes(member)) {
    throw new HttpsError("failed-precondition", "Not a member of this group");
  }

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date)) {
    data = await maybeProcessDay(group_id, data);
  }

  // Now mark completion in a transaction
  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const completions: string[] = freshData.completions_today;

    // Idempotent
    if (completions.includes(member)) {
      finalData = freshData;
      return;
    }

    const newCompletions = [...completions, member];
    tx.update(groupRef, { completions_today: newCompletions });
    finalData = { ...freshData, completions_today: newCompletions };
  });

  return groupToResponse(group_id, finalData!);
});

// --- selectBuild ---

export const selectBuild = onCall({ enforceAppCheck: true }, async (request) => {
  const { group_id, member, type } = request.data;

  if (!group_id || !member || !type) {
    throw new HttpsError("invalid-argument", "group_id, member, and type are required");
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

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date)) {
    data = await maybeProcessDay(group_id, data);
  }

  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;

    if (freshData.current_build !== null) {
      throw new HttpsError("failed-precondition", "A build is already in progress");
    }

    if (!freshData.group_members.includes(member)) {
      throw new HttpsError("failed-precondition", "Not a member of this group");
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

// --- deleteGroup ---

export const deleteGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const code = snap.data()!.group_code;
  const batch = db().batch();
  batch.delete(groupRef);
  batch.delete(db().collection("group_codes").doc(code));
  await batch.commit();

  return { success: true };
});
