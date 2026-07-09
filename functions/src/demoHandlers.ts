import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  processEndOfDay,
  findEmptyTiles,
  findOccupiedTiles,
  getProcessingDate,
} from "./gameLogic";
import { EMPTY_CITY, GRID_ROWS, GRID_COLS, groupToResponse } from "./utils";
import { requireDemoAccess } from "./auth";

const db = () => getFirestore();

// --- demoAsteroid ---

export const demoAsteroid = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
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

  const processingDate = getProcessingDate(
    data.goal_reset_time,
    data.goal_reset_timezone ?? "UTC",
  );
  const updates = processEndOfDay({
    groupMembers: data.group_members,
    completionsToday: [], // empty = failed day = asteroid
    currentBuild,
    cityMap,
    streak: data.streak,
    buildingCompletions: data.building_completions ?? [],
    processingDate,
    // Pass the forgiveness fields through so a demo strike doesn't zero
    // the group's freeze stock (found in the 2026-07-08 simulator E2E).
    streakFreezes: data.streak_freezes ?? 0,
    frozenDates: data.frozen_dates ?? [],
    brokenStreak: data.broken_streak ?? null,
    lastActivityDate: data.last_activity_date ?? null,
    lastInactivityMeteorDate: data.last_inactivity_meteor_date ?? null,
    // Deliberately no grace day: the whole point of the dev tool is to
    // force a strike on demand.
  });

  await groupRef.update({ ...updates });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoFillCity ---

export const demoFillCity = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
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
  const newMap = Object.fromEntries(
    Object.entries(cityMap).map(([k, row]) => [k, [...(row as (string | null)[])]]),
  );
  for (const [r, c] of tilesToFill) {
    newMap[r][c] = buildingTypes[Math.floor(Math.random() * buildingTypes.length)];
  }

  await groupRef.update({ city_map: newMap });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoSetBuildings ---
// Port of Python `main.py` set_buildings endpoint.
// Builds a fresh city map with exactly `count` buildings of `type`
// placed row-major, then resets all build/streak/event state.

export const demoSetBuildings = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
  const { group_id, count, type = "house" } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const validTypes = ["house", "apartment", "skyscraper"];
  if (!validTypes.includes(type)) {
    throw new HttpsError(
      "invalid-argument",
      `type must be one of: ${validTypes.join(", ")}`,
    );
  }

  const maxTiles = GRID_ROWS * GRID_COLS;
  const clampedCount = Math.max(0, Math.min(Number(count) || 0, maxTiles));

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  // Start from a fresh empty city and fill row-major up to clampedCount
  const newMap = Object.fromEntries(
    Object.entries(EMPTY_CITY).map(([k, row]) => [k, [...row]]),
  );

  let placed = 0;
  outer: for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (placed >= clampedCount) break outer;
      newMap[String(r)][c] = type;
      placed++;
    }
  }

  await groupRef.update({
    city_map: newMap,
    current_build: null,
    pending_event: null,
    completions_today: [],
    streak: 0,
    building_completions: [],
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoResetCity ---
// Equivalent to demoSetBuildings with count = 0.

export const demoResetCity = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const emptyMap = Object.fromEntries(
    Object.entries(EMPTY_CITY).map(([k, row]) => [k, [...row]]),
  );

  await groupRef.update({
    city_map: emptyMap,
    current_build: null,
    pending_event: null,
    completions_today: [],
    streak: 0,
    building_completions: [],
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});
