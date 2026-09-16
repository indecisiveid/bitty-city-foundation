/**
 * Restoring what the meteor broke — the park-design rules
 * (vault specs/2026-08-02-park-design.md, "Damage and repair"):
 *   - a levelled building costs RESTORE_BUILDING_DAYS (1), whatever it cost;
 *   - a damaged park costs clamp(ceil(damaged / 4), 1, 4) and is fixed in place;
 *   - a restoration survives a stall + rescue as a restoration.
 */
import {
  landBuild,
  processEndOfDay,
  applyBuildRescue,
  parkRestoreDays,
  damagedCellCount,
  isRestoreBuild,
  RESTORE_BUILDING_DAYS,
} from "../gameLogic";
import { Park } from "../parks";

const DAY = "2026-09-10";
const NOW = "2026-09-10T15:00:00.000Z";
const emptyMap = () =>
  Object.fromEntries(Array.from({ length: 3 }, (_, r) => [String(r), [null, null, null]])) as Record<
    string,
    (string | null)[]
  >;

const park = (over: Partial<Park> = {}): Park => ({
  park_id: "pk_1",
  cells: 9,
  built_at_buildings: 2,
  damage: { "0": 1, "4": 2, "8": 1 },
  built_on: "2026-09-01",
  ...over,
});

const landBase = () => ({
  cityMap: emptyMap(),
  parks: [] as Park[],
  buildOrder: [] as string[],
  tileBuildDates: {},
  rubbleOrigins: {},
  streakFreezes: 0,
  landedOn: DAY,
  nowIso: NOW,
});

describe("restore costs", () => {
  it("a levelled building restores in one day, whatever it cost", () => {
    expect(RESTORE_BUILDING_DAYS).toBe(1);
  });

  it.each([
    [0, 1],
    [1, 1],
    [4, 1],
    [5, 2],
    [8, 2],
    [9, 3],
    [12, 3],
    [13, 4],
    [15, 4],
  ])("a park with %i damaged cells takes %i day(s)", (damaged, days) => {
    expect(parkRestoreDays(damaged)).toBe(days);
  });

  it("counts damaged cells at any level", () => {
    expect(damagedCellCount({ "0": 1, "3": 2 })).toBe(2);
    expect(damagedCellCount({})).toBe(0);
    expect(damagedCellCount(undefined)).toBe(0);
  });

  it("recognises a restoration build", () => {
    expect(isRestoreBuild({ target_tile: { row: 0, col: 0 } })).toBe(true);
    expect(isRestoreBuild({ target_park: "pk_1" })).toBe(true);
    expect(isRestoreBuild({})).toBe(false);
    expect(isRestoreBuild(null)).toBe(false);
  });
});

describe("landBuild — park restoration", () => {
  it("clears the target park's damage in place and adds no park", () => {
    const other = park({ park_id: "pk_2", damage: { "1": 1 } });
    const r = landBuild({
      ...landBase(),
      parks: [park(), other],
      currentBuild: { type: "park_small", days_required: 1, days_completed: 0, target_park: "pk_1" },
    })!;
    expect(r.parks).toHaveLength(2);
    expect(r.parks!.find((p) => p.park_id === "pk_1")!.damage).toEqual({});
    // Only the target is touched.
    expect(r.parks!.find((p) => p.park_id === "pk_2")!.damage).toEqual({ "1": 1 });
    expect(r.city_map).toBeUndefined();
    expect(r.pending_event).toMatchObject({ type: "build_complete", building: "park_small", restored: true });
    expect(r.streak_freezes).toBe(1);
  });

  it("completes without wedging the slot when the park is gone", () => {
    const r = landBuild({
      ...landBase(),
      parks: [],
      currentBuild: { type: "park_small", days_required: 1, days_completed: 0, target_park: "pk_gone" },
    })!;
    expect(r.current_build).toBeNull();
    expect(r.parks).toBeUndefined();
  });

  it("an ordinary park build still founds a new park", () => {
    const r = landBuild({
      ...landBase(),
      parks: [park()],
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
    })!;
    expect(r.parks).toHaveLength(2);
    expect(r.pending_event.restored).toBeUndefined();
  });

  it("marks a building restored only when it lands on its own lot", () => {
    const cityMap = emptyMap();
    cityMap["1"][1] = "rubble";
    const restored = landBuild({
      ...landBase(),
      cityMap,
      rubbleOrigins: { "1,1": "skyscraper_slim" },
      currentBuild: { type: "skyscraper_slim", days_required: 1, days_completed: 0, target_tile: { row: 1, col: 1 } },
    })!;
    expect(restored.city_map!["1"][1]).toBe("skyscraper_slim");
    expect(restored.pending_event.restored).toBe(true);

    const plain = landBuild({
      ...landBase(),
      currentBuild: { type: "house_a", days_required: 1, days_completed: 0 },
    })!;
    expect(plain.pending_event.restored).toBeUndefined();
  });
});

describe("a stalled restoration stays a restoration", () => {
  const MEMBERS = ["A", "B"];
  const build = { type: "park_large", days_required: 3, days_completed: 1, target_park: "pk_1" };

  it("carries its target into the rescue offer and back out", () => {
    const stalled = processEndOfDay({
      groupMembers: MEMBERS,
      completionsToday: [],
      currentBuild: build,
      cityMap: emptyMap(),
      parks: [park({ cells: 15 })],
      streak: 0,
      buildingCompletions: [],
      processingDate: DAY,
      streakFreezes: 1,
    });
    expect(stalled.abandoned_build).toMatchObject({ target_park: "pk_1", days_completed: 1 });

    const rescued = applyBuildRescue({
      abandonedBuild: stalled.abandoned_build!,
      currentBuild: null,
      streakFreezes: 1,
      frozenDates: [],
      todayStr: DAY,
    })!;
    expect(rescued.current_build).toMatchObject({ type: "park_large", target_park: "pk_1" });

    // …and landing it restores rather than founding a second park.
    const landed = landBuild({
      ...landBase(),
      parks: [park({ cells: 15 })],
      currentBuild: rescued.current_build,
    })!;
    expect(landed.parks).toHaveLength(1);
    expect(landed.parks![0].damage).toEqual({});
  });

  it("carries a building's target lot too", () => {
    const stalled = processEndOfDay({
      groupMembers: MEMBERS,
      completionsToday: [],
      currentBuild: { type: "house_a", days_required: 1, days_completed: 0, target_tile: { row: 2, col: 0 } },
      cityMap: emptyMap(),
      streak: 0,
      buildingCompletions: [],
      processingDate: DAY,
    });
    expect(stalled.abandoned_build?.target_tile).toEqual({ row: 2, col: 0 });
  });

  it("an ordinary stall carries no target", () => {
    const stalled = processEndOfDay({
      groupMembers: MEMBERS,
      completionsToday: [],
      currentBuild: { type: "house_a", days_required: 3, days_completed: 1 },
      cityMap: emptyMap(),
      streak: 0,
      buildingCompletions: [],
      processingDate: DAY,
    });
    expect(stalled.abandoned_build).not.toHaveProperty("target_tile");
    expect(stalled.abandoned_build).not.toHaveProperty("target_park");
  });
});
