/**
 * Paid streak repair (1.2): one freeze restores the streak AND resumes the
 * build the break cost. The lost build rides on `broken_streak` for the whole
 * repair window so a crew with no freezes can land a new build, earn one, and
 * still come back for it.
 */
import {
  processEndOfDay,
  applyStreakRepair,
  applyBuildRescue,
  streakRepairBlocker,
  BrokenStreak,
  CurrentBuild,
  AbandonedBuild,
} from "../gameLogic";

const MEMBERS = ["A", "B"];
const emptyMap = () =>
  Object.fromEntries(Array.from({ length: 3 }, (_, r) => [String(r), [null, null, null]])) as Record<
    string,
    (string | null)[]
  >;

type State = {
  current_build: CurrentBuild | null;
  abandoned_build: AbandonedBuild | null;
  streak_freezes: number;
  frozen_dates: string[];
  building_completions: string[];
  broken_streak: BrokenStreak | null;
  streak: number;
  city_map: Record<string, (string | null)[]>;
};

const start = (over: Partial<State> = {}): State => ({
  current_build: { type: "apartment_c", days_required: 3, days_completed: 1 },
  abandoned_build: null,
  streak_freezes: 0,
  frozen_dates: [],
  building_completions: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
  broken_streak: null,
  streak: 5,
  city_map: emptyMap(),
  ...over,
});

function pass(s: State, date: string, completions: string[]): State {
  const u = processEndOfDay({
    groupMembers: MEMBERS,
    completionsToday: completions,
    currentBuild: s.current_build,
    abandonedBuild: s.abandoned_build,
    cityMap: s.city_map,
    streak: s.streak,
    buildingCompletions: s.building_completions,
    processingDate: date,
    lastActivityDate: "2026-09-05",
    streakFreezes: s.streak_freezes,
    frozenDates: s.frozen_dates,
    brokenStreak: s.broken_streak,
  });
  return { ...s, ...(u as Partial<State>) };
}

/** Stall on 09-06 with no freezes, then a completed day that records the break. */
function brokenWithLostBuild(over: Partial<State> = {}): State {
  let s = start(over);
  s = pass(s, "2026-09-06", []); // stall
  s = pass(s, "2026-09-07", MEMBERS); // break charged, rescue offer expires
  return s;
}

describe("the break remembers the build it cost", () => {
  it("attaches the expiring stalled build to the broken streak", () => {
    const s = brokenWithLostBuild();
    expect(s.abandoned_build).toBeNull();
    expect(s.broken_streak).toMatchObject({
      value: 5,
      lost_build: { type: "apartment_c", days_required: 3, days_completed: 1 },
    });
    expect(s.broken_streak!.lost_build).not.toHaveProperty("abandoned_on");
  });

  it("carries a restoration's target with it", () => {
    const s = brokenWithLostBuild({
      current_build: { type: "park_small", days_required: 2, days_completed: 1, target_park: "pk_1" },
    });
    expect(s.broken_streak?.lost_build?.target_park).toBe("pk_1");
  });

  it("records no lost build when nothing was in flight", () => {
    let s = start({ current_build: null });
    s = pass(s, "2026-09-06", []);
    s = pass(s, "2026-09-07", MEMBERS);
    expect(s.broken_streak).not.toBeNull();
    expect(s.broken_streak).not.toHaveProperty("lost_build");
  });

  it("keeps the lost build through a later landing (the way a crew earns the freeze)", () => {
    let s = brokenWithLostBuild();
    // The crew starts a one-day house (selectBuild leaves broken_streak alone)
    // and lands it at the next settlement.
    s = { ...s, current_build: { type: "house_a", days_required: 1, days_completed: 0 } };
    s = pass(s, "2026-09-08", MEMBERS);
    expect(s.current_build).toBeNull();
    expect(s.streak_freezes).toBe(1);
    expect(s.broken_streak?.lost_build?.type).toBe("apartment_c");
  });
});

describe("streakRepairBlocker", () => {
  const broken: BrokenStreak = {
    value: 5,
    broken_on: "2026-09-07",
    last_active_date: "2026-09-05",
    lost_build: { type: "apartment_c", days_required: 3, days_completed: 1 },
  };
  const ok = { brokenStreak: broken, todayStr: "2026-09-09", streakFreezes: 1, currentBuild: null, landedOn: null };

  it("allows a repair with a freeze and a free slot", () => {
    expect(streakRepairBlocker(ok)).toBeNull();
  });
  it("needs a freeze", () => {
    expect(streakRepairBlocker({ ...ok, streakFreezes: 0 })).toBe("no_freeze");
  });
  it("needs the slot free when it would resume a build", () => {
    expect(
      streakRepairBlocker({ ...ok, currentBuild: { type: "house_a", days_required: 1, days_completed: 0 } }),
    ).toBe("build_in_progress");
  });
  it("refuses on a day a build already landed", () => {
    expect(streakRepairBlocker({ ...ok, landedOn: "2026-09-09" })).toBe("landed_today");
  });
  it("ignores the slot when there is no build to resume", () => {
    const { lost_build: _, ...noBuild } = broken;
    expect(
      streakRepairBlocker({
        ...ok,
        brokenStreak: noBuild,
        currentBuild: { type: "house_a", days_required: 1, days_completed: 0 },
        landedOn: "2026-09-09",
      }),
    ).toBeNull();
  });
  it("has nothing to repair outside the window or without a break", () => {
    expect(streakRepairBlocker({ ...ok, todayStr: "2026-09-20" })).toBe("nothing_to_repair");
    expect(streakRepairBlocker({ ...ok, brokenStreak: null })).toBe("nothing_to_repair");
  });
});

describe("paid repair", () => {
  it("spends one freeze, restores the streak and resumes the lost build — the full payable path", () => {
    let s = brokenWithLostBuild();
    s = { ...s, current_build: { type: "house_a", days_required: 1, days_completed: 0 } };
    s = pass(s, "2026-09-08", MEMBERS); // house lands, freeze earned
    const repaired = applyStreakRepair({
      buildingCompletions: s.building_completions,
      frozenDates: s.frozen_dates,
      brokenStreak: s.broken_streak,
      todayStr: "2026-09-09",
      payment: { streakFreezes: s.streak_freezes, currentBuild: s.current_build, landedOn: "2026-09-08" },
    })!;
    expect(repaired).not.toBeNull();
    expect(repaired.streak_freezes).toBe(0);
    expect(repaired.broken_streak).toBeNull();
    expect(repaired.current_build).toEqual({ type: "apartment_c", days_required: 3, days_completed: 1 });
    expect(repaired.abandoned_build).toBeNull();
    expect(repaired.streak).toBe(7); // 5 before + 09-07 and 09-08 completed

    // …and the restored chain holds through the next settlement.
    s = { ...s, ...repaired } as State;
    s = pass(s, "2026-09-10", MEMBERS);
    expect(s.broken_streak).toBeNull();
    expect(s.current_build).toMatchObject({ type: "apartment_c", days_completed: 2 });
  });

  it("with no lost build, spends the freeze and touches no build", () => {
    const repaired = applyStreakRepair({
      buildingCompletions: ["2026-09-04", "2026-09-05"],
      frozenDates: [],
      brokenStreak: { value: 2, broken_on: "2026-09-07", last_active_date: "2026-09-05" },
      todayStr: "2026-09-07",
      payment: { streakFreezes: 2, currentBuild: null, landedOn: null },
    })!;
    expect(repaired.streak_freezes).toBe(1);
    expect(repaired).not.toHaveProperty("current_build");
    expect(repaired.streak).toBe(2);
  });

  it("returns null when blocked", () => {
    const s = brokenWithLostBuild();
    expect(
      applyStreakRepair({
        buildingCompletions: s.building_completions,
        frozenDates: s.frozen_dates,
        brokenStreak: s.broken_streak,
        todayStr: "2026-09-07",
        payment: { streakFreezes: 0, currentBuild: null, landedOn: null },
      }),
    ).toBeNull();
  });

  it("the legacy (unpaid) repair stays free and resumes nothing", () => {
    const s = brokenWithLostBuild();
    const repaired = applyStreakRepair({
      buildingCompletions: s.building_completions,
      frozenDates: s.frozen_dates,
      brokenStreak: s.broken_streak,
      todayStr: "2026-09-07",
    })!;
    expect(repaired).not.toHaveProperty("streak_freezes");
    expect(repaired).not.toHaveProperty("current_build");
    expect(repaired.broken_streak).toBeNull();
  });
});

describe("a rescue forgets the lost build", () => {
  it("drops lost_build so a later repair can't grant the build twice", () => {
    const broken: BrokenStreak = {
      value: 5,
      broken_on: "2026-09-07",
      last_active_date: "2026-09-05",
      lost_build: { type: "apartment_c", days_required: 3, days_completed: 1 },
    };
    const rescued = applyBuildRescue({
      abandonedBuild: { type: "apartment_c", days_required: 3, days_completed: 1, abandoned_on: "2026-09-07" },
      currentBuild: null,
      streakFreezes: 1,
      frozenDates: [],
      brokenStreak: broken,
      todayStr: "2026-09-07",
    })!;
    expect(rescued.broken_streak).toEqual({
      value: 5,
      broken_on: "2026-09-07",
      last_active_date: "2026-09-05",
    });
  });

  it("leaves the broken streak alone when it carries no build", () => {
    const rescued = applyBuildRescue({
      abandonedBuild: { type: "apartment_c", days_required: 3, days_completed: 1, abandoned_on: "2026-09-07" },
      currentBuild: null,
      streakFreezes: 1,
      frozenDates: [],
      brokenStreak: { value: 5, broken_on: "2026-09-07", last_active_date: "2026-09-05" },
      todayStr: "2026-09-07",
    })!;
    expect(rescued).not.toHaveProperty("broken_streak");
  });
});
