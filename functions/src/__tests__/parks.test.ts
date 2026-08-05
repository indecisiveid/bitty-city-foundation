import {
  isParkId,
  parkCellCount,
  parkFootprint,
  normalizeParks,
  Park,
} from "../parks";
import { findEmptyTiles, processEndOfDay, CityMap } from "../gameLogic";

/**
 * A park is the first thing that occupies the city without occupying
 * `city_map`, so these pin the two invariants that separation buys: the
 * building grid is untouched, and a park is ONE building however many cells it
 * covers.
 *
 * Note what is deliberately NOT here: coordinates. `city_map` row/col are
 * bookkeeping, not geometry — `computeCityLayout` never reads them — so the
 * server records only the footprint and the client does the placing.
 */

function emptyMap(rows: number, cols: number): CityMap {
  const m: CityMap = {};
  for (let r = 0; r < rows; r++) m[String(r)] = new Array(cols).fill(null);
  return m;
}

describe("park footprints", () => {
  it("maps the two catalog sizes to three-deep rectangles", () => {
    // Both three deep so ONE layout rule covers both: interior is
    // (rows-2)×(cols-2), i.e. 1 cell at 3×3 and 3 at 3×5.
    expect(parkFootprint("park_small")).toEqual({ rows: 3, cols: 3 });
    expect(parkFootprint("park_large")).toEqual({ rows: 3, cols: 5 });
  });

  it("agrees with the catalog's cell counts", () => {
    expect(parkCellCount("park_small")).toBe(9);
    expect(parkCellCount("park_large")).toBe(15);
  });

  it("rejects buildings and junk", () => {
    expect(parkFootprint("house_a")).toBeUndefined();
    expect(isParkId("house_a")).toBe(false);
    expect(isParkId("park_small")).toBe(true);
    expect(isParkId(undefined)).toBe(false);
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
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
      cityMap: emptyMap(3, 6),
      parks: [],
    });
    expect(updates.parks).toHaveLength(1);
    expect(updates.parks![0].cells).toBe(9);
    // The whole point: no sentinel in the building grid, so slot indices and
    // tile_build_dates keep meaning what they meant.
    expect(updates.city_map).toBeUndefined();
    expect(updates.current_build).toBeNull();
  });

  it("records the large footprint for the 7-day park", () => {
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_large", days_required: 7, days_completed: 6 },
      cityMap: emptyMap(3, 6),
      parks: [],
    });
    expect(updates.parks![0].cells).toBe(15);
  });

  it("appends rather than replacing, so a second park keeps the first", () => {
    const parks: Park[] = [
      { park_id: "p1", cells: 9, damage: {}, built_on: "2026-08-03" },
    ];
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
      cityMap: emptyMap(3, 6),
      parks,
    });
    expect(updates.parks).toHaveLength(2);
    expect(updates.parks![0].park_id).toBe("p1");
  });

  it("lands even in a city with no free tiles — a park needs no tile", () => {
    // A building would be stuck here; a park isn't, because it doesn't take a
    // cell in the grid at all.
    const full = emptyMap(2, 2);
    full["0"][0] = "house_a";
    full["0"][1] = "house_a";
    full["1"][0] = "house_a";
    full["1"][1] = "house_a";
    const updates = processEndOfDay({
      ...base,
      currentBuild: { type: "park_small", days_required: 5, days_completed: 4 },
      cityMap: full,
      parks: [],
    });
    expect(updates.parks).toHaveLength(1);
    expect(updates.current_build).toBeNull();
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

  it("leaves findEmptyTiles alone — parks consume no grid cells", () => {
    expect(findEmptyTiles(emptyMap(3, 3))).toHaveLength(9);
  });
});

describe("normalizeParks", () => {
  it("tolerates cities that predate the field", () => {
    expect(normalizeParks(undefined)).toEqual([]);
    expect(normalizeParks(null)).toEqual([]);
    expect(normalizeParks("nonsense")).toEqual([]);
  });

  it("drops records whose footprint isn't one we can render", () => {
    expect(normalizeParks([{ park_id: "x", cells: 12 }])).toEqual([]);
    expect(
      normalizeParks([{ park_id: "x", cells: 9, damage: {}, built_on: "d" }]),
    ).toHaveLength(1);
  });
});
