import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  processEndOfDay,
  findEmptyTiles,
  findOccupiedTiles,
} from "./gameLogic";

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

// --- demoAsteroid ---

export const demoAsteroid = onCall(async (request) => {
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
  const cityMap = data.city_map;

  const occupied = findOccupiedTiles(cityMap);
  if (occupied.length === 0) {
    throw new HttpsError("failed-precondition", "No buildings on the map to destroy");
  }

  // If no active build, inject a dummy so the asteroid branch fires
  let currentBuild = data.current_build;
  if (currentBuild === null) {
    currentBuild = { type: "house", days_required: 1, days_completed: 0 };
  }

  const updates = processEndOfDay({
    groupMembers: data.group_members,
    completionsToday: [], // empty = failed day = asteroid
    currentBuild,
    cityMap,
    streak: data.streak,
  });

  await groupRef.update({ ...updates });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoFillCity ---

export const demoFillCity = onCall(async (request) => {
  const { group_id, count } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const data = snap.data()!;
  const cityMap = data.city_map;
  const empty = findEmptyTiles(cityMap);

  if (empty.length === 0) {
    throw new HttpsError("failed-precondition", "City is full — no empty tiles");
  }

  // Determine which tiles to fill
  let tilesToFill: number[][];
  if (count != null) {
    // Shuffle and take up to count
    const shuffled = [...empty].sort(() => Math.random() - 0.5);
    tilesToFill = shuffled.slice(0, Math.min(count, empty.length));
  } else {
    tilesToFill = empty;
  }

  const buildingTypes = ["house", "apartment", "skyscraper"];
  const newMap = cityMap.map((row: (string | null)[]) => [...row]);
  for (const [r, c] of tilesToFill) {
    newMap[r][c] = buildingTypes[Math.floor(Math.random() * buildingTypes.length)];
  }

  await groupRef.update({ city_map: newMap });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});
