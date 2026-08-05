import {
  allocateParkRegion,
  isParkId,
  parkCellKeys,
  parkFootprint,
  normalizeParks,
  Park,
} from "../parks";
import { findEmptyTiles, processEndOfDay, CityMap } from "../gameLogic";

/**
 * Parks are the first thing that occupies the city WITHOUT occupying
 * `city_map`, so the risks are all about the two staying in agreement:
 * a building landing on the lawn, or the same cells being handed to two parks.
 */

function emptyMap(rows: number, cols: number): CityMap {
  const m: CityMap = {};
  for (let r = 0; r < rows; r++) m[String(r)] = new Array(cols).fill(null);
  return m;
}

describe("park footprints", () => {
  it("maps the two catalog sizes to three-deep rectangles", () => {
    // Both three deep so ONE layout rule covers both — interior is
    // (rows-2)×(cols-2), i.e. 1 cell at 3×3 and 3 at 3×5.
    expect(parkFootprint("park_small")).toEqual({ rows: 3, cols: 3 });
    expect(parkFootprint("park_large")).toEqual({ rows: 3, cols: 5 });
  });

  it("counts cells consistent with the catalog", () => {
    const s = parkFootprint("park_small")!;
    const l = parkFootprint("park_large")!;
    expect(s.rows * s.cols).toBe(9);
    expect(l.rows * l.cols).toBe(15);
  });

  it("rejects buildings and junk", () => {
    expect(parkFootprint("house_a")).toBeUndefined();
    expect(isParkId("house_a")).toBe(false);
    expect(isParkId("park_small")).toBe(true);
    expect(isParkId(undefined)).toBe(false);
  });
});

describe("allocateParkRegion", () => {
  it("returns exactly the footprint's cells, contiguous", () => {
    const cells = allocateParkRegion(emptyMap(4, 6), [], 3, 5)!;
    expect(cells).toHaveLength(15);
    const rows = new Set(cells.map((c) => c.row));
    const cols = new Set(cells.map((c) => c.col));
    expect(rows.size).toBe(3);
    expect(cols.size).toBe(5);
  });

  it("is deterministic — the same map always yields the same cells", () => {
    // Placement must not wander between retries, or two writes of the same
    // completed build would disagree about where the park is.
    const a = allocateParkRegion(emptyMap(4, 6), [], 3, 3);
    const b = allocateParkRegion(emptyMap(4, 6), [], 3, 3);
    expect(a).toEqual(b);
  });

  it("never overlaps an existing park", () => {
    const map = emptyMap(3, 6);
    const first = allocateParkRegion(map, [], 3, 3)!;
    const parks: Park[] = [
      { park_id: "p1", cells: first, damage: {}, built_on: "2026-08-04" },
    ];
    const second = allocateParkRegion(map, parks, 3, 3)!;
    const overlap = second.filter((c) =>
      parkCellKeys(parks).has(`${c.row},${c.col}`),
    );
    expect(overlap).toEqual([]);
  });

  it("refuses to place over a building, but will pave rubble", () => {
    const withBuilding = emptyMap(3, 3);
    withBuilding["1"][1] = "house_a";
    expect(allocateParkRegion(withBuilding, [], 3, 3)).toBeNull();

    const withRubble = emptyMap(3, 3);
    withRubble["1"][1] = "rubble";
    // A cleared lot is exactly what a park is for.
    expect(allocateParkRegion(withRubble, [], 3, 3)).toHaveLength(9);
  });

  it("returns null when the city is too small to hold the footprint", () => {
    expect(allocateParkRegion(emptyMap(2, 2), [], 3, 3)).toBeNull();
    expect(allocateParkRegion(emptyMap(3, 4), [], 3, 5)).toBeNull();
  });
});

describe("findEmptyTiles excludes park cells", () => {
  it("stops a building landing on the lawn", () => {
    // The one coupling the separate-storage design introduces: park cells are
    // null in city_map by design, so placement must subtract them explicitly.
    const map = emptyMap(3, 6);
    const cells = allocateParkRegion(map, [], 3, 3)!;
    const parks: Park[] = [
      { park_id: "p1", cells, damage: {}, built_on: "2026-08-04" },
    ];
    const empty = findEmptyTiles(map, parks);
    const keys = new Set(empty.map(([r, c]) => `${r},${c}`));
    for (const c of cells) expect(keys.has(`${c.row},${c.col}`)).toBe(false);
    expect(empty).toHaveLength(3 * 6 - 9);
  });

  it("is unchanged for a city with no parks", () => {
    expect(findEmptyTiles(emptyMap(3, 3))).toHaveLength(9);
    expect(findEmptyTiles(emptyMap(3, 3), [])).toHaveLength(9);
    expect(findEmptyTiles(emptyMap(3, 3), null)).toHaveLength(9);
  });
});

describe("processEndOfDay — a completed park", () => {
  const base = {
    groupMembers: ["A"],
    completionsToday: ["A"],
    streak: 1,
    buildingCompletions: [] as string[],
    processingDate: "2026-08-04",
  };

  it("records a park and leaves city_map untouched", () => {
    const cityMap = emptyMap(3, 6);
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
      cityMap,
      parks: [],
    });
    expect(updates.parks).toHaveLength(1);
    expect(updates.parks![0].cells).toHaveLength(9);
    // The whole point: no sentinel in the building grid.
    expect(updates.city_map).toBeUndefined();
    expect(updates.current_build).toBeNull();
  });

  it("appends rather than replacing, so a second park keeps the first", () => {
    const cityMap = emptyMap(3, 6);
    const first = allocateParkRegion(cityMap, [], 3, 3)!;
    const parks: Park[] = [
      { park_id: "p1", cells: first, damage: {}, built_on: "2026-08-03" },
    ];
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
      cityMap,
      parks,
    });
    expect(updates.parks).toHaveLength(2);
    expect(updates.parks![0].park_id).toBe("p1");
  });

  it("keeps the build alive when there is no room, rather than spending it", () => {
    // Clearing current_build here would burn the crew's entire streak on
    // nothing — the single worst outcome in a streak game.
    const full = emptyMap(3, 3);
    full["1"][1] = "house_a";
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_large", days_required: 7, days_completed: 6 },
      cityMap: full,
      parks: [],
    });
    expect(updates.parks).toBeUndefined();
    expect(updates.current_build).toBeUndefined();
  });

  it("still lands ordinary buildings in city_map", () => {
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "house_a", days_required: 1, days_completed: 0 },
      cityMap: emptyMap(3, 3),
      parks: [],
    });
    expect(updates.city_map).toBeDefined();
    expect(updates.parks).toBeUndefined();
  });
});

describe("normalizeParks", () => {
  it("tolerates cities that predate the field", () => {
    expect(normalizeParks(undefined)).toEqual([]);
    expect(normalizeParks(null)).toEqual([]);
    expect(normalizeParks("nonsense")).toEqual([]);
    expect(normalizeParks([{ nope: true }])).toEqual([]);
  });
});
