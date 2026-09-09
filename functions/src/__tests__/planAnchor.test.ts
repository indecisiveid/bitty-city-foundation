/**
 * The plan anchor re-stamp. The app never read `plan_frozen_at_buildings`
 * until 2026-09-09 (its snapshot mapper dropped the field), so every city has
 * only ever rendered with the legacy ray plan. The first client that reads
 * the anchor must find every city stamped at its CURRENT size, in slot units,
 * or buildings already standing would move.
 */
import { planAnchorUpdates, PLAN_ANCHOR_VERSION } from "../groupHandlers";

const map = {
  "0": ["house", null, "rubble"],
  "1": [null, "apartment", null],
};

describe("planAnchorUpdates", () => {
  it("re-stamps a city the old rule anchored — at its current slot count", () => {
    // Stamped 7 back when the rule shipped; it has 3 slots now (one levelled).
    expect(planAnchorUpdates({ city_map: map, plan_frozen_at_buildings: 7 })).toEqual({
      plan_frozen_at_buildings: 3,
      plan_anchor_version: PLAN_ANCHOR_VERSION,
    });
  });

  it("re-stamps a city founded after the rule, which was stamped 0", () => {
    expect(planAnchorUpdates({ city_map: map, plan_frozen_at_buildings: 0 })?.plan_frozen_at_buildings).toBe(3);
  });

  it("stamps a city that was never anchored", () => {
    expect(planAnchorUpdates({ city_map: map })?.plan_frozen_at_buildings).toBe(3);
  });

  it("prefers build_order's length, since that is exactly what the client counts", () => {
    expect(
      planAnchorUpdates({ city_map: map, build_order: ["0,0", "1,1", "0,2", "9,9"] })
        ?.plan_frozen_at_buildings,
    ).toBe(4);
  });

  it("writes nothing once the current version is stamped — one write per city, ever", () => {
    expect(
      planAnchorUpdates({
        city_map: map,
        plan_frozen_at_buildings: 3,
        plan_anchor_version: PLAN_ANCHOR_VERSION,
      }),
    ).toBeNull();
  });

  it("an empty city anchors at 0 and is compact from its first block", () => {
    expect(planAnchorUpdates({ city_map: { "0": [null] } })?.plan_frozen_at_buildings).toBe(0);
  });
});
