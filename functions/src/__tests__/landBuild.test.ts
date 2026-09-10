import { landBuild, FREEZE_CAP } from "../gameLogic";

const DAY = "2026-09-10";
const NOW = "2026-09-10T15:00:00.000Z";
const emptyMap = () => Object.fromEntries(Array.from({ length: 3 }, (_, r) => [String(r), [null, null, null]]));

const base = () => ({
  currentBuild: { type: "house", days_required: 1, days_completed: 0 },
  cityMap: emptyMap() as Record<string, (string | null)[]>,
  parks: [],
  buildOrder: [] as string[],
  tileBuildDates: {},
  rubbleOrigins: {},
  streakFreezes: 0,
  landedOn: DAY,
  nowIso: NOW,
});

describe("landBuild", () => {
  it("places the building, stamps the tile with the day the crew completed, appends the slot", () => {
    const r = landBuild(base())!;
    expect(r.current_build).toBeNull();
    const cells = Object.values(r.city_map!).flat().filter(Boolean);
    expect(cells).toEqual(["house"]);
    expect(Object.values(r.tile_build_dates!)).toEqual([DAY]);
    expect(r.build_order).toHaveLength(1);
    expect(r.pending_event.type).toBe("build_complete");
    expect(r.pending_event.timestamp).toBe(NOW);
  });

  it("earns a freeze, capped", () => {
    expect(landBuild(base())!.streak_freezes).toBe(1);
    expect(landBuild({ ...base(), streakFreezes: FREEZE_CAP })!.streak_freezes).toBe(FREEZE_CAP);
  });

  it("a repair lands on its own lot and drops the ruin from the ledger", () => {
    const cityMap = emptyMap() as Record<string, (string | null)[]>;
    cityMap["1"][1] = "rubble";
    const r = landBuild({
      ...base(),
      cityMap,
      buildOrder: ["1,1"],
      rubbleOrigins: { "1,1": "apartment" },
      currentBuild: { type: "apartment", days_required: 3, days_completed: 2, target_tile: { row: 1, col: 1 } },
    })!;
    expect(r.city_map!["1"][1]).toBe("apartment");
    // The lot was already listed (rubble keeps its slot), so the order is untouched.
    expect(r.build_order).toBeUndefined();
    expect(r.rubble_origins).toEqual({});
    expect(r.tile_build_dates).toEqual({ "1,1": DAY });
  });

  it("returns null when the city is full", () => {
    const cityMap = emptyMap() as Record<string, (string | null)[]>;
    for (const row of Object.values(cityMap)) row.fill("house");
    expect(landBuild({ ...base(), cityMap })).toBeNull();
  });
});
