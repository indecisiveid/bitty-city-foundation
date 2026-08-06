/**
 * Unit tests for the pure game logic.
 *
 * The four docstring examples from Python's `compute_streak` are covered
 * first, then edge-case gaps, the timezone-aware helpers, and the
 * 2026-07-08 finish-line additions: streak-on-successful-days, streak
 * freezes + repair, the 7-day inactivity meteor, and first-day grace.
 */

import {
  computeStreak,
  computeStreakWithFreezes,
  needsDayProcessing,
  getProcessingDate,
  processEndOfDay,
  applyStreakRepair,
  applyBuildRescue,
  isRescuableBuild,
  isFirstDayGrace,
  daysBetween,
  findOccupiedTiles,
  FREEZE_CAP,
  CityMap,
} from "../gameLogic";

const TODAY = "2026-05-04";

describe("computeStreak", () => {
  // --- Python docstring examples (today = 2026-05-04) ---

  it("returns 1 for [today]", () => {
    expect(computeStreak(["2026-05-04"], TODAY)).toBe(1);
  });

  it("returns 2 for [yesterday, today]", () => {
    expect(computeStreak(["2026-05-03", "2026-05-04"], TODAY)).toBe(2);
  });

  it("returns 1 for [yesterday] only", () => {
    expect(computeStreak(["2026-05-03"], TODAY)).toBe(1);
  });

  it("returns 1 for [2 days ago, today] — gap breaks older streak", () => {
    expect(computeStreak(["2026-05-02", "2026-05-04"], TODAY)).toBe(1);
  });

  it("returns 0 for [2 days ago] — most recent is too old", () => {
    expect(computeStreak(["2026-05-02"], TODAY)).toBe(0);
  });

  it("returns 0 for empty list", () => {
    expect(computeStreak([], TODAY)).toBe(0);
  });

  // --- Additional edge cases ---

  it("deduplicates repeated dates", () => {
    expect(
      computeStreak(["2026-05-04", "2026-05-04", "2026-05-03"], TODAY),
    ).toBe(2);
  });

  it("handles a long consecutive run", () => {
    const dates = [
      "2026-05-04",
      "2026-05-03",
      "2026-05-02",
      "2026-05-01",
      "2026-04-30",
    ];
    expect(computeStreak(dates, TODAY)).toBe(5);
  });

  it("stops counting at a gap in the middle", () => {
    const dates = [
      "2026-05-04",
      "2026-05-03",
      "2026-05-01", // gap: 2026-05-02 missing
    ];
    expect(computeStreak(dates, TODAY)).toBe(2);
  });

  it("ignores future dates (older than the streak window)", () => {
    // Dates much older than yesterday should not extend the streak
    const dates = ["2026-05-04", "2026-03-01", "2026-01-15"];
    expect(computeStreak(dates, TODAY)).toBe(1);
  });

  it("returns 0 when the only date is 3 days ago", () => {
    expect(computeStreak(["2026-05-01"], TODAY)).toBe(0);
  });
});

describe("computeStreakWithFreezes", () => {
  it("frozen day bridges a gap without incrementing the count", () => {
    // completed 05-02, frozen 05-03, completed 05-04 → 2 (not 3)
    expect(
      computeStreakWithFreezes(
        ["2026-05-02", "2026-05-04"],
        ["2026-05-03"],
        TODAY,
      ),
    ).toBe(2);
  });

  it("frozen yesterday anchors the chain when today is missed", () => {
    // completed 05-01..05-02, frozen 05-03; today 05-04 missed → still 2
    expect(
      computeStreakWithFreezes(
        ["2026-05-01", "2026-05-02"],
        ["2026-05-03"],
        TODAY,
      ),
    ).toBe(2);
  });

  it("unfrozen gap still breaks the chain", () => {
    expect(
      computeStreakWithFreezes(["2026-05-01", "2026-05-04"], [], TODAY),
    ).toBe(1);
  });

  it("multiple consecutive frozen days bridge together", () => {
    expect(
      computeStreakWithFreezes(
        ["2026-05-01", "2026-05-04"],
        ["2026-05-02", "2026-05-03"],
        TODAY,
      ),
    ).toBe(2);
  });

  it("returns 0 when the chain is only frozen days (no completions)", () => {
    expect(
      computeStreakWithFreezes([], ["2026-05-03", "2026-05-04"], TODAY),
    ).toBe(0);
  });

  it("matches computeStreak when no frozen dates", () => {
    const dates = ["2026-05-04", "2026-05-03", "2026-05-02"];
    expect(computeStreakWithFreezes(dates, [], TODAY)).toBe(
      computeStreak(dates, TODAY),
    );
  });
});

describe("daysBetween", () => {
  it("computes positive spans", () => {
    expect(daysBetween("2026-05-01", "2026-05-04")).toBe(3);
  });
  it("is 0 for the same day", () => {
    expect(daysBetween("2026-05-04", "2026-05-04")).toBe(0);
  });
  it("crosses month boundaries", () => {
    expect(daysBetween("2026-04-28", "2026-05-04")).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// processEndOfDay
// ---------------------------------------------------------------------------

const MEMBERS = ["alice", "bob"];

function emptyMap(rows = 3, cols = 3): CityMap {
  return Object.fromEntries(
    Array.from({ length: rows }, (_, i) => [String(i), Array(cols).fill(null)]),
  );
}

/**
 * The same city, built with a CATALOG id rather than the legacy `"house"`.
 *
 * Every destruction fixture in this file used `"house"`, which meant the whole
 * consequence system was only ever tested against the v1.0 vocabulary. When
 * `findOccupiedTiles` keyed on three hard-coded legacy names, a city built
 * with catalog ids reported zero occupied tiles and was silently IMMUNE to
 * both the asteroid and the meteor — and no test noticed, because no test
 * used a catalog id. That is the shape of bug this fixture exists to catch.
 */
function mapWithCatalogBuilds(count: number, type = "house_a"): CityMap {
  const m = emptyMap();
  let placed = 0;
  for (let r = 0; r < 3 && placed < count; r++) {
    for (let c = 0; c < 3 && placed < count; c++) {
      m[String(r)][c] = type;
      placed++;
    }
  }
  return m;
}

function mapWithHouses(count: number): CityMap {
  const m = emptyMap();
  let placed = 0;
  for (let r = 0; r < 3 && placed < count; r++) {
    for (let c = 0; c < 3 && placed < count; c++) {
      m[String(r)][c] = "house";
      placed++;
    }
  }
  return m;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    groupMembers: MEMBERS,
    completionsToday: [] as string[],
    currentBuild: null,
    cityMap: emptyMap(),
    streak: 0,
    buildingCompletions: [] as string[],
    processingDate: TODAY,
    ...overrides,
  };
}

describe("processEndOfDay — streak on successful days", () => {
  it("logs the processed day when a multi-day build merely advances", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: { type: "apartment", days_required: 3, days_completed: 0 },
      }),
    );
    expect(updates.current_build).toEqual({
      type: "apartment",
      days_required: 3,
      days_completed: 1,
    });
    expect(updates.building_completions).toContain(TODAY);
    expect(updates.streak).toBe(1);
  });

  it("streak climbs daily through a multi-day build", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: { type: "apartment", days_required: 3, days_completed: 1 },
        buildingCompletions: ["2026-05-02", "2026-05-03"],
      }),
    );
    expect(updates.streak).toBe(3);
  });

  it("logs an all-complete day even with no active build", () => {
    const updates = processEndOfDay(
      baseParams({ completionsToday: MEMBERS }),
    );
    expect(updates.building_completions).toContain(TODAY);
    expect(updates.streak).toBe(1);
  });

  it("does not log a day when only some members completed", () => {
    const updates = processEndOfDay(
      baseParams({ completionsToday: ["alice"] }),
    );
    expect(updates.building_completions).not.toContain(TODAY);
    expect(updates.streak).toBe(0);
  });

  it("landing a building logs the day and places it", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: { type: "house", days_required: 1, days_completed: 0 },
      }),
    );
    expect(updates.current_build).toBeNull();
    expect(updates.pending_event?.type).toBe("build_complete");
    expect(updates.building_completions).toContain(TODAY);
    expect(updates.streak).toBe(1);
  });
});

describe("processEndOfDay — streak freezes", () => {
  it("landing a building earns a freeze, capped at FREEZE_CAP", () => {
    const land = (freezes: number) =>
      processEndOfDay(
        baseParams({
          completionsToday: MEMBERS,
          currentBuild: { type: "house", days_required: 1, days_completed: 0 },
          streakFreezes: freezes,
        }),
      );
    expect(land(0).streak_freezes).toBe(1);
    expect(land(FREEZE_CAP).streak_freezes).toBe(FREEZE_CAP);
  });

  it("a missed gap day is frozen when the chain rebuilds", () => {
    // completed 05-01, 05-02; missed 05-03; all complete on 05-04
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        buildingCompletions: ["2026-05-01", "2026-05-02"],
        streakFreezes: 1,
      }),
    );
    expect(updates.frozen_dates).toContain("2026-05-03");
    expect(updates.streak_freezes).toBe(0);
    expect(updates.streak).toBe(3); // 05-01, 05-02, 05-04 with 05-03 bridged
    expect(updates.broken_streak).toBeNull();
  });

  it("a multi-day absence consumes one freeze per gap day in one pass", () => {
    // completed 04-30, 05-01; gap 05-02 + 05-03; processing 05-04 (missed too)
    const updates = processEndOfDay(
      baseParams({
        buildingCompletions: ["2026-04-30", "2026-05-01"],
        streakFreezes: 3,
      }),
    );
    expect(updates.frozen_dates).toEqual(
      expect.arrayContaining(["2026-05-02", "2026-05-03"]),
    );
    expect(updates.streak_freezes).toBe(1);
    // chain: 04-30 ✓, 05-01 ✓, 05-02 ❄, 05-03 ❄ → anchored at yesterday
    expect(updates.streak).toBe(2);
  });

  it("insufficient freezes break the streak and record it without burning the stock", () => {
    const updates = processEndOfDay(
      baseParams({
        buildingCompletions: ["2026-04-29", "2026-04-30", "2026-05-01"],
        streakFreezes: 1, // gap is 2 days (05-02, 05-03)
      }),
    );
    expect(updates.streak).toBe(0);
    expect(updates.streak_freezes).toBe(1); // not burned
    expect(updates.broken_streak).toEqual({
      value: 3,
      broken_on: "2026-05-03", // the day the yesterday-anchor first failed
      last_active_date: "2026-05-01",
    });
  });

  it("does not record a repair offer for a chain that died long ago", () => {
    const updates = processEndOfDay(
      baseParams({
        buildingCompletions: ["2026-04-01"], // last active a month ago
        streakFreezes: 2,
      }),
    );
    expect(updates.broken_streak).toBeNull();
  });

  it("no freeze is consumed when there is no streak to protect", () => {
    const updates = processEndOfDay(
      baseParams({
        buildingCompletions: ["2026-04-01"], // long dead
        streakFreezes: 2,
      }),
    );
    expect(updates.streak_freezes).toBe(2);
    expect(updates.frozen_dates).toEqual([]);
    expect(updates.streak).toBe(0);
  });

  it("a single missed day needs no freeze yet (yesterday anchor keeps it alive)", () => {
    const updates = processEndOfDay(
      baseParams({
        buildingCompletions: ["2026-05-02", "2026-05-03"],
        streakFreezes: 1,
      }),
    );
    expect(updates.streak).toBe(2);
    expect(updates.streak_freezes).toBe(1);
  });
});

describe("processEndOfDay — first-day grace", () => {
  it("keeps the build and fires no asteroid on a missed grace day", () => {
    const build = { type: "house", days_required: 1, days_completed: 0 };
    const updates = processEndOfDay(
      baseParams({
        currentBuild: build,
        cityMap: mapWithHouses(4),
        isGraceDay: true,
      }),
    );
    expect(updates.current_build).toBeUndefined(); // untouched
    expect(updates.pending_event).toBeUndefined();
    expect(updates.city_map).toBeUndefined();
  });

  it("still counts positive progress on a grace day", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: { type: "house", days_required: 1, days_completed: 0 },
        isGraceDay: true,
      }),
    );
    expect(updates.pending_event?.type).toBe("build_complete");
    expect(updates.streak).toBe(1);
  });
});

describe("processEndOfDay — missed build day (no asteroid)", () => {
  const build = { type: "apartment", days_required: 3, days_completed: 1 };

  it("stops the build without touching the city", () => {
    const updates = processEndOfDay(
      baseParams({ currentBuild: build, cityMap: mapWithHouses(5) }),
    );
    expect(updates.current_build).toBeNull();
    // The whole point of the card: nothing is destroyed.
    expect(updates.pending_event).toBeUndefined();
    expect(updates.city_map).toBeUndefined();
    expect(updates.tile_build_dates).toBeUndefined();
  });

  it("holds the build for rescue with its progress intact", () => {
    const updates = processEndOfDay(
      baseParams({ currentBuild: build, cityMap: mapWithHouses(5) }),
    );
    expect(updates.abandoned_build).toEqual({
      type: "apartment",
      days_required: 3,
      days_completed: 1,
      abandoned_on: TODAY,
    });
  });

  it("never fires a missed_day asteroid at any city size", () => {
    for (const n of [0, 1, 2, 5, 20]) {
      const updates = processEndOfDay(
        baseParams({ currentBuild: build, cityMap: mapWithHouses(n) }),
      );
      expect(updates.pending_event?.cause).not.toBe("missed_day");
    }
  });

  it("makes no rescue offer on a grace day (the build simply survives)", () => {
    const updates = processEndOfDay(
      baseParams({ currentBuild: build, cityMap: mapWithHouses(5), isGraceDay: true }),
    );
    expect(updates.current_build).toBeUndefined();
    expect(updates.abandoned_build).toBeUndefined();
  });

  it("makes no rescue offer when the 7-day meteor fires (that's abandonment)", () => {
    const updates = processEndOfDay(
      baseParams({
        currentBuild: build,
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-20",
      }),
    );
    expect(updates.current_build).toBeNull();
    expect(updates.abandoned_build ?? null).toBeNull(); // no offer made
    expect(updates.pending_event?.cause).toBe("inactivity");
  });

  it("expires an offer made on an earlier day", () => {
    const updates = processEndOfDay(
      baseParams({
        currentBuild: null,
        abandonedBuild: {
          type: "house",
          days_required: 1,
          days_completed: 0,
          abandoned_on: "2026-05-02",
        },
        cityMap: mapWithHouses(5),
      }),
    );
    expect(updates.abandoned_build).toBeNull();
  });

  it("leaves today's fresh offer alone", () => {
    const offer = {
      type: "house",
      days_required: 1,
      days_completed: 0,
      abandoned_on: TODAY,
    };
    const updates = processEndOfDay(
      baseParams({ currentBuild: null, abandonedBuild: offer, cityMap: mapWithHouses(5) }),
    );
    expect(updates.abandoned_build).toBeUndefined(); // untouched
  });
});

describe("isRescuableBuild / applyBuildRescue", () => {
  const offer = {
    type: "skyscraper",
    days_required: 7,
    days_completed: 4,
    abandoned_on: "2026-05-03", // yesterday relative to TODAY
  };

  it("is rescuable the day after the miss", () => {
    expect(isRescuableBuild(offer, null, TODAY)).toBe(true);
  });

  it("is not rescuable two days later", () => {
    expect(isRescuableBuild(offer, null, "2026-05-05")).toBe(false);
  });

  it("is not rescuable once another build is running", () => {
    const running = { type: "house", days_required: 1, days_completed: 0 };
    expect(isRescuableBuild(offer, running, TODAY)).toBe(false);
  });

  it("is not rescuable with no record", () => {
    expect(isRescuableBuild(null, null, TODAY)).toBe(false);
  });

  it("spends one freeze and restores the build at its stalled progress", () => {
    const result = applyBuildRescue({
      abandonedBuild: offer,
      currentBuild: null,
      streakFreezes: 2,
      todayStr: TODAY,
    });
    expect(result).toEqual({
      current_build: { type: "skyscraper", days_required: 7, days_completed: 4 },
      abandoned_build: null,
      streak_freezes: 1,
    });
  });

  it("refuses with zero freezes — the build is lost", () => {
    expect(
      applyBuildRescue({
        abandonedBuild: offer,
        currentBuild: null,
        streakFreezes: 0,
        todayStr: TODAY,
      }),
    ).toBeNull();
  });

  it("refuses outside the one-day window", () => {
    expect(
      applyBuildRescue({
        abandonedBuild: offer,
        currentBuild: null,
        streakFreezes: 3,
        todayStr: "2026-05-06",
      }),
    ).toBeNull();
  });

  it("rescued build then advances normally on a successful day", () => {
    const rescued = applyBuildRescue({
      abandonedBuild: offer,
      currentBuild: null,
      streakFreezes: 1,
      todayStr: TODAY,
    })!;
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: rescued.current_build,
        cityMap: mapWithHouses(5),
      }),
    );
    expect(updates.current_build).toEqual({
      type: "skyscraper",
      days_required: 7,
      days_completed: 5,
    });
  });
});

describe("processEndOfDay — tile build dates", () => {
  it("records the build date on the tile where a building lands", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        currentBuild: { type: "house", days_required: 1, days_completed: 0 },
        cityMap: emptyMap(),
        tileBuildDates: {},
      }),
    );
    const tile = updates.pending_event?.tile;
    expect(tile).toBeDefined();
    expect(updates.tile_build_dates?.[`${tile![0]},${tile![1]}`]).toBe(TODAY);
  });

  it("clears the date of a tile destroyed by the meteor, keeps survivors", () => {
    const cityMap = mapWithHouses(5);
    const seeded: Record<string, string> = {};
    for (const { row, col } of findOccupiedTiles(cityMap)) seeded[`${row},${col}`] = "2026-01-01";
    const updates = processEndOfDay(
      baseParams({
        cityMap,
        lastActivityDate: "2026-04-20",
        tileBuildDates: seeded,
      }),
    );
    const destroyed = updates.pending_event?.tiles_destroyed ?? [];
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    for (const { row, col } of destroyed) {
      expect(updates.tile_build_dates?.[`${row},${col}`]).toBeUndefined();
    }
    for (const { row, col } of findOccupiedTiles(updates.city_map!)) {
      expect(updates.tile_build_dates?.[`${row},${col}`]).toBe("2026-01-01");
    }
  });
});

describe("processEndOfDay — 7-day inactivity meteor", () => {
  it("fires after 7 idle days even with no active build", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-27", // 7 days before TODAY
      }),
    );
    expect(updates.pending_event?.type).toBe("asteroid");
    expect(updates.pending_event?.cause).toBe("inactivity");
    // ceil(9 * 0.2) = 2 tiles
    expect(updates.pending_event?.tiles_destroyed?.length).toBe(2);
    expect(updates.last_inactivity_meteor_date).toBe(TODAY);
    const remaining = findOccupiedTiles(updates.city_map!);
    expect(remaining.length).toBe(7);
  });

  it("destroys a city built with catalog ids, not just legacy ones", () => {
    // Guards the regression that made the consequence system inert: with
    // `findOccupiedTiles` keyed on the three v1.0 names, this city looked
    // empty to the server and nothing could be destroyed. The city LOOKS full
    // in the app either way, so the failure is invisible until someone misses
    // a week and nothing happens.
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithCatalogBuilds(9),
        lastActivityDate: "2026-04-27",
      }),
    );
    expect(updates.pending_event?.type).toBe("asteroid");
    expect(updates.pending_event?.tiles_destroyed?.length).toBe(2);
    expect(findOccupiedTiles(updates.city_map!).length).toBe(7);
  });

  it("counts every catalog id as occupied, tower or cottage", () => {
    // One id per tier, so a catalog entry added without teaching
    // `findOccupiedTiles` about it fails here rather than in production.
    for (const type of [
      "house_a", "apartment_c", "tenement_g", "highrise_h",
      "skyscraper_slim", "skyscraper_twin",
    ]) {
      expect(findOccupiedTiles(mapWithCatalogBuilds(4, type)).length).toBe(4);
    }
  });

  it("does not fire before 7 idle days", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-28", // 6 days
      }),
    );
    expect(updates.pending_event).toBeUndefined();
    expect(updates.last_inactivity_meteor_date).toBeUndefined();
  });

  it("throttles to one meteor per 7-day window", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-20",
        lastInactivityMeteorDate: "2026-05-01", // struck 3 days ago
      }),
    );
    expect(updates.pending_event).toBeUndefined();
  });

  it("fires again once the previous meteor is 7+ days old", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-01",
        lastInactivityMeteorDate: "2026-04-27",
      }),
    );
    expect(updates.pending_event?.cause).toBe("inactivity");
  });

  it("supersedes the standard asteroid when a build is active, and cancels the build", () => {
    const updates = processEndOfDay(
      baseParams({
        currentBuild: { type: "house", days_required: 1, days_completed: 0 },
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-20",
      }),
    );
    expect(updates.current_build).toBeNull();
    expect(updates.pending_event?.cause).toBe("inactivity");
  });

  it("destroys min 1 building (can raze a 1-building city)", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(1),
        lastActivityDate: "2026-04-20",
      }),
    );
    expect(updates.pending_event?.tiles_destroyed?.length).toBe(1);
    expect(findOccupiedTiles(updates.city_map!).length).toBe(0);
  });

  it("stamps the date without an event when the city is empty", () => {
    const updates = processEndOfDay(
      baseParams({ lastActivityDate: "2026-04-20" }),
    );
    expect(updates.pending_event).toBeUndefined();
    expect(updates.last_inactivity_meteor_date).toBe(TODAY);
  });

  it("does not fire on the first-day grace day", () => {
    const updates = processEndOfDay(
      baseParams({
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-20",
        isGraceDay: true,
      }),
    );
    expect(updates.pending_event).toBeUndefined();
  });

  it("does not fire when the processed day was successful", () => {
    const updates = processEndOfDay(
      baseParams({
        completionsToday: MEMBERS,
        cityMap: mapWithHouses(9),
        lastActivityDate: "2026-04-20",
      }),
    );
    expect(updates.pending_event).toBeUndefined();
  });
});

describe("applyStreakRepair", () => {
  const BROKEN = {
    value: 5,
    broken_on: "2026-05-02",
    last_active_date: "2026-04-30",
  };
  const COMPLETIONS = [
    "2026-04-26",
    "2026-04-27",
    "2026-04-28",
    "2026-04-29",
    "2026-04-30",
  ];

  it("restores the streak by freezing the gap through yesterday", () => {
    const result = applyStreakRepair({
      buildingCompletions: COMPLETIONS,
      frozenDates: [],
      brokenStreak: BROKEN,
      todayStr: TODAY, // 2026-05-04
    });
    expect(result).not.toBeNull();
    expect(result!.frozen_dates).toEqual(
      expect.arrayContaining(["2026-05-01", "2026-05-02", "2026-05-03"]),
    );
    expect(result!.streak).toBe(5);
    expect(result!.broken_streak).toBeNull();
  });

  it("returns null when there is no broken streak", () => {
    expect(
      applyStreakRepair({
        buildingCompletions: COMPLETIONS,
        frozenDates: [],
        brokenStreak: null,
        todayStr: TODAY,
      }),
    ).toBeNull();
  });

  it("returns null when the break is older than the repair window", () => {
    expect(
      applyStreakRepair({
        buildingCompletions: COMPLETIONS,
        frozenDates: [],
        brokenStreak: { ...BROKEN, broken_on: "2026-04-20" },
        todayStr: TODAY,
      }),
    ).toBeNull();
  });

  it("completing today after a repair extends the restored chain", () => {
    const repaired = applyStreakRepair({
      buildingCompletions: [...COMPLETIONS, TODAY],
      frozenDates: [],
      brokenStreak: BROKEN,
      todayStr: TODAY,
    });
    expect(repaired!.streak).toBe(6);
  });
});

describe("isFirstDayGrace", () => {
  it("graces a city founded minutes before the boundary", () => {
    // created 23:50 UTC on 05-04; day 05-04 ends 05-05T00:00 → 10 min later
    expect(
      isFirstDayGrace("2026-05-04T23:50:00Z", "2026-05-04", "00:00", "UTC"),
    ).toBe(true);
  });

  it("graces a nearly-full first day (still < 24h)", () => {
    // created 00:10 on 05-04; boundary 05-05T00:00 → 23h50m
    expect(
      isFirstDayGrace("2026-05-04T00:10:00Z", "2026-05-04", "00:00", "UTC"),
    ).toBe(true);
  });

  it("does not grace the second day", () => {
    // created 23:50 on 05-03; processing 05-04 ends 05-05T00:00 → 24h10m
    expect(
      isFirstDayGrace("2026-05-03T23:50:00Z", "2026-05-04", "00:00", "UTC"),
    ).toBe(false);
  });

  it("respects non-midnight reset times", () => {
    // reset 18:00; created 05-04T17:00; day 05-04 ends 05-05T18:00 → 25h
    expect(
      isFirstDayGrace("2026-05-04T17:00:00Z", "2026-05-04", "18:00", "UTC"),
    ).toBe(false);
    // created 05-04T19:00 → boundary 05-05T18:00 is 23h later
    expect(
      isFirstDayGrace("2026-05-04T19:00:00Z", "2026-05-04", "18:00", "UTC"),
    ).toBe(true);
  });

  it("returns false for invalid created_at", () => {
    expect(isFirstDayGrace("not-a-date", "2026-05-04", "00:00", "UTC")).toBe(
      false,
    );
  });
});

describe("needsDayProcessing", () => {
  it("returns false when already processed today", () => {
    // Force a UTC date that is 'today' for UTC
    const now = new Date();
    const todayUtc = now.toISOString().split("T")[0];
    // With UTC timezone and a reset time in the past (00:00), check_date
    // should be today — so passing todayUtc as lastProcessedDate means no
    // reprocessing needed.
    const result = needsDayProcessing("00:00", todayUtc, "UTC");
    expect(result).toBe(false);
  });

  it("returns true when last_processed_date is null", () => {
    expect(needsDayProcessing("00:00", null, "UTC")).toBe(true);
  });

  it("returns true when last_processed_date is a past date", () => {
    expect(needsDayProcessing("00:00", "2000-01-01", "UTC")).toBe(true);
  });
});

describe("getProcessingDate", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = getProcessingDate("00:00", "UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns today or yesterday relative to UTC reset time", () => {
    const result = getProcessingDate("00:00", "UTC");
    const now = new Date();
    const todayUtc = now.toISOString().split("T")[0];
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayUtc = yesterday.toISOString().split("T")[0];
    expect([todayUtc, yesterdayUtc]).toContain(result);
  });
});
