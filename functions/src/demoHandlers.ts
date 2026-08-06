import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  processEndOfDay,
  findEmptyTiles,
  findOccupiedTiles,
  getProcessingDate,
  INACTIVITY_METEOR_DAYS,
} from "./gameLogic";
import { EMPTY_CITY, GRID_ROWS, GRID_COLS, groupToResponse } from "./utils";
import { requireDemoAccess } from "./auth";
import { buildableIds } from "./buildCatalog";

const db = () => getFirestore();

/** `YYYY-MM-DD`, `n` days before the given date. */
function daysBefore(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

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
    currentBuild = { type: "house_a", days_required: 1, days_completed: 0 };
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
    // Backdate activity so the INACTIVITY METEOR fires.
    //
    // This control used to pass the group's real `last_activity_date`, which
    // made it simulate a missed DAY — and under the current rules a missed day
    // deliberately destroys nothing ("falling rocks are reserved for real
    // abandonment"; the build is parked for rescue instead). So the callable
    // succeeded, wrote an update, and correctly changed nothing: a spinner,
    // a closing sheet, and an untouched city. It read as a dead button for
    // weeks.
    //
    // The meteor is the ONLY thing that destroys standing buildings, so a dev
    // control whose whole job is "show me the city being destroyed" has to
    // drive that path. Both fields are forced: the date to clear the 7-day
    // idle threshold, and the throttle to null so a second press works.
    lastActivityDate: daysBefore(processingDate, INACTIVITY_METEOR_DAYS),
    lastInactivityMeteorDate: null,
    tileBuildDates: data.tile_build_dates ?? {},
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

  // Catalog ids, so dev-seeded cities look like cities real players will
  // have. Spread across tiers to exercise the variety.
  const buildingTypes = ["house_a", "house_b", "apartment_c", "apartment_e",
    "tenement_g", "skyscraper_slim"];
  const newMap = Object.fromEntries(
    Object.entries(cityMap).map(([k, row]) => [k, [...(row as (string | null)[])]]),
  );
  const buildDates: Record<string, string> = { ...(data.tile_build_dates ?? {}) };
  const today = new Date().toISOString().slice(0, 10);
  for (const [r, c] of tilesToFill) {
    newMap[r][c] = buildingTypes[Math.floor(Math.random() * buildingTypes.length)];
    buildDates[`${r},${c}`] = today;
  }

  await groupRef.update({ city_map: newMap, tile_build_dates: buildDates });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoSetBuildings ---
// Port of Python `main.py` set_buildings endpoint.
// Builds a fresh city map with exactly `count` buildings of `type`
// placed row-major, then resets all build/streak/event state.

export const demoSetBuildings = onCall({ enforceAppCheck: true }, async (request) => {
  requireDemoAccess(request);
  const { group_id, count, type = "house_a" } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  // Legacy names stay valid here on purpose: these tools are also how a
  // legacy-shaped city gets reproduced for testing the compatibility path.
  const validTypes = [...buildableIds(), "house", "apartment", "skyscraper"];
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

  // Stagger the build dates (most-recent first placed) so tapping different
  // houses shows different "built on" dates — handy for exercising the
  // tap-to-inspect popup.
  const today = new Date();
  const buildDates: Record<string, string> = {};
  let placed = 0;
  outer: for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (placed >= clampedCount) break outer;
      newMap[String(r)][c] = type;
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - placed);
      buildDates[`${r},${c}`] = d.toISOString().slice(0, 10);
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
    tile_build_dates: buildDates,
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- demoShowcaseCity ---
//
// Stages the screenshot city: one of every build, both park sizes, a two-week
// streak. It exists on the SERVER on purpose.
//
// The app had this as a local-only override, which made the city look full
// while `city_map` was still empty. Every server-backed dev tool then failed on
// it for reasons the screen flatly contradicted — `demoAsteroid` returning
// "No buildings on the map to destroy" against a skyline full of buildings is
// the one that cost an afternoon. A demo city you cannot then strike, fill or
// process is only half a fixture.

const SHOWCASE_BUILDS = [
  // One of each, so every model in the catalog is on screen somewhere...
  "house_a", "house_b",
  "apartment_c", "apartment_d", "apartment_e", "apartment_f",
  "tenement_g", "highrise_h",
  "skyscraper_slim", "skyscraper_twin",
  // ...then weighted the way a real city grows: lots of small stuff, few towers.
  "house_a", "house_b", "apartment_e", "apartment_f",
  "house_a", "apartment_c", "house_b", "apartment_d",
  "house_a", "apartment_e", "house_b", "tenement_g",
  "house_a", "apartment_f", "house_b", "highrise_h",
  "apartment_c", "house_a", "apartment_d", "house_b",
];

export const demoShowcaseCity = onCall({ enforceAppCheck: true }, async (request) => {
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

  const newMap = Object.fromEntries(
    Object.entries(EMPTY_CITY).map(([k, row]) => [k, [...row]]),
  );
  const buildDates: Record<string, string> = {};
  const today = new Date();
  const dayBefore = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  SHOWCASE_BUILDS.slice(0, GRID_ROWS * GRID_COLS).forEach((type, i) => {
    const r = Math.floor(i / GRID_COLS);
    const c = i % GRID_COLS;
    newMap[String(r)][c] = type;
    buildDates[`${r},${c}`] = dayBefore(i);
  });

  // Fourteen consecutive all-complete days ending today — the streak the
  // header shows, derived rather than asserted, so it survives a day-process.
  const completions = Array.from({ length: 14 }, (_, i) => dayBefore(13 - i));

  await groupRef.update({
    city_map: newMap,
    tile_build_dates: buildDates,
    // Anchored to the block sequence, not to coordinates — see parks.ts.
    parks: [
      {
        park_id: "showcase_small", cells: 9, built_at_buildings: 12,
        damage: {}, built_on: dayBefore(3),
      },
      {
        park_id: "showcase_large", cells: 15, built_at_buildings: 22,
        damage: {}, built_on: dayBefore(1),
      },
    ],
    building_completions: completions,
    last_activity_date: completions[completions.length - 1],
    streak: 14,
    streak_freezes: 3,
    frozen_dates: [],
    broken_streak: null,
    // 0 = plan this city compactly from its first procedural block. A showcase
    // frozen into the old ray plan would be the star-shaped city the compact
    // growth work exists to replace.
    plan_frozen_at_buildings: 0,
    current_build: null,
    pending_event: null,
    completions_today: [],
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
    tile_build_dates: {},
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});
