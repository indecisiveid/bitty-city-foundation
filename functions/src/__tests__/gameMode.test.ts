/**
 * Game modes: how a day counts (gameMode.ts) and how that lands in the
 * settlement pass (processEndOfDay). The invariants this suite guards:
 *
 *   - a doc with no `game_mode` plays the v1.0 rules to the letter
 *   - easy mode can never outpace hard mode; a full crew banks exactly 1 day
 *   - every completion in easy mode is worth the same share
 *   - three thirds land as exactly one day (no float drift into "Day 1 of 3"
 *     after a banked day)
 *   - a day with NO completions is a miss in both modes
 *   - the near-miss ledger only counts hard-mode days someone finished
 */
import {
  dayShare,
  isBuildFinished,
  normalizeGameMode,
  pruneNearMisses,
  recentNearMisses,
  shouldSuggestEasyMode,
  snapProgress,
  NEAR_MISS_THRESHOLD,
  MODE_SUGGESTION_COOLDOWN_DAYS,
} from "../gameMode";
import { processEndOfDay, CityMap } from "../gameLogic";
import { buildProgressOf } from "../buildings";
import { decideNudge, NudgeInput, REMINDER_SLOTS } from "../reminderLogic";
import { modeChangedMessage, easyModeSuggestionMessage } from "../crewMessages";

const MEMBERS = ["alice", "bob", "carol", "dave"];
const TODAY = "2026-05-04";

function emptyMap(): CityMap {
  return Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [String(i), Array(10).fill(null)]),
  );
}

function base(overrides: Record<string, unknown> = {}) {
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

describe("normalizeGameMode", () => {
  it("absent or junk → hard (the rules every existing city runs)", () => {
    expect(normalizeGameMode(undefined)).toBe("hard");
    expect(normalizeGameMode(null)).toBe("hard");
    expect(normalizeGameMode("medium")).toBe("hard");
    expect(normalizeGameMode("easy")).toBe("easy");
    expect(normalizeGameMode("hard")).toBe("hard");
  });
});

describe("dayShare", () => {
  it("hard: all or nothing", () => {
    expect(dayShare("hard", 4, 4)).toBe(1);
    expect(dayShare("hard", 3, 4)).toBe(0);
    expect(dayShare("hard", 0, 4)).toBe(0);
  });

  it("easy: each completion is one share; a full crew is exactly one day", () => {
    expect(dayShare("easy", 1, 4)).toBe(0.25);
    expect(dayShare("easy", 2, 4)).toBe(0.5);
    expect(dayShare("easy", 4, 4)).toBe(1);
    expect(dayShare("easy", 0, 4)).toBe(0);
  });

  it("easy never outpaces hard", () => {
    for (let n = 1; n <= 8; n++) {
      for (let c = 0; c <= n; c++) {
        expect(dayShare("easy", c, n)).toBeLessThanOrEqual(1);
        expect(dayShare("easy", c, n)).toBeLessThanOrEqual(dayShare("hard", n, n));
      }
    }
  });

  it("nobody on the roster → no share", () => {
    expect(dayShare("easy", 0, 0)).toBe(0);
    expect(dayShare("hard", 0, 0)).toBe(0);
  });
});

describe("snapProgress / isBuildFinished", () => {
  it("three thirds are one whole day", () => {
    let p = 0;
    for (let i = 0; i < 3; i++) p = snapProgress(p + dayShare("easy", 1, 3));
    expect(p).toBe(1);
  });

  it("seven sevenths finish a 1-day build exactly once", () => {
    let p = 0;
    for (let i = 0; i < 6; i++) {
      p = snapProgress(p + dayShare("easy", 1, 7));
      expect(isBuildFinished(p, 1)).toBe(false);
    }
    p = snapProgress(p + dayShare("easy", 1, 7));
    expect(isBuildFinished(p, 1)).toBe(true);
  });

  it("whole numbers pass through untouched", () => {
    expect(snapProgress(2)).toBe(2);
    expect(isBuildFinished(3, 3)).toBe(true);
    expect(isBuildFinished(2, 3)).toBe(false);
  });
});

describe("processEndOfDay — hard mode (default) is unchanged", () => {
  it("a doc with no gameMode banks a whole day only when everyone completes", () => {
    const partial = processEndOfDay(
      base({
        completionsToday: ["alice", "bob"],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 1 },
      }),
    );
    expect(partial.current_build).toBeNull();
    expect(partial.abandoned_build?.days_completed).toBe(1);
    expect(partial.building_completions).not.toContain(TODAY);

    const full = processEndOfDay(
      base({
        completionsToday: MEMBERS,
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 1 },
      }),
    );
    expect(full.current_build?.days_completed).toBe(2);
    expect(full.building_completions).toContain(TODAY);
  });
});

describe("processEndOfDay — easy mode", () => {
  it("one of four banks a quarter day and the streak counts it", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: ["alice"],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 0 },
      }),
    );
    expect(u.current_build?.days_completed).toBe(0.25);
    expect(u.abandoned_build).toBeUndefined();
    expect(u.building_completions).toContain(TODAY);
    expect(u.streak).toBe(1);
  });

  it("a full crew banks exactly one day — same pace as hard mode", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: MEMBERS,
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 1 },
      }),
    );
    expect(u.current_build?.days_completed).toBe(2);
  });

  it("nobody finishing is still a missed day: the build stalls", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: [],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 1.5 },
      }),
    );
    expect(u.current_build).toBeNull();
    expect(u.abandoned_build?.days_completed).toBe(1.5);
    expect(u.building_completions).not.toContain(TODAY);
  });

  it("lands when the fractions reach the requirement", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: ["alice", "bob"],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 2.5 },
      }),
    );
    expect(u.current_build).toBeNull();
    expect(u.pending_event?.type).toBe("build_complete");
    expect(u.pending_event?.building).toBe("apartment_c");
  });

  it("a 3-day build with a crew of three lands on the ninth solo day, not the tenth", () => {
    let build = { type: "apartment_c", days_required: 3, days_completed: 0 };
    let landed = false;
    for (let day = 1; day <= 9; day++) {
      const u = processEndOfDay(
        base({
          gameMode: "easy",
          groupMembers: ["alice", "bob", "carol"],
          completionsToday: ["alice"],
          currentBuild: build,
          processingDate: `2026-05-${String(day).padStart(2, "0")}`,
        }),
      );
      if (u.current_build === null) {
        landed = true;
        expect(day).toBe(9);
        break;
      }
      build = u.current_build!;
    }
    expect(landed).toBe(true);
  });

  it("a paused day banks nothing in either mode", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: ["alice"],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 1 },
        memberUids: ["u1", "u2", "u3", "u4"],
        cityPause: { from: "2026-05-01", until: "2026-05-10", set_by: "u1" },
      }),
    );
    // Untouched: a paused pass writes no build field at all.
    expect(u.current_build).toBeUndefined();
    expect(u.abandoned_build).toBeUndefined();
    expect(u.building_completions).not.toContain(TODAY);
  });

  it("vacation shrinks the roster: two of two active is a whole day", () => {
    const u = processEndOfDay(
      base({
        gameMode: "easy",
        completionsToday: ["alice", "bob"],
        currentBuild: { type: "apartment_c", days_required: 3, days_completed: 0 },
        memberUids: ["u1", "u2", "u3", "u4"],
        memberPauses: {
          u3: { from: "2026-05-01", until: "2026-05-10", set_by: "u3" },
          u4: { from: "2026-05-01", until: "2026-05-10", set_by: "u4" },
        },
      }),
    );
    expect(u.current_build?.days_completed).toBe(1);
  });

  it("never records a near miss", () => {
    const u = processEndOfDay(base({ gameMode: "easy", completionsToday: ["alice"] }));
    expect(u.near_miss_dates).toBeUndefined();
  });
});

describe("processEndOfDay — near-miss ledger (hard mode)", () => {
  it("someone-but-not-everyone appends the settlement label", () => {
    const u = processEndOfDay(base({ completionsToday: ["alice"] }));
    expect(u.near_miss_dates).toEqual([TODAY]);
  });

  it("nobody finishing is not a near miss", () => {
    const u = processEndOfDay(base({ completionsToday: [] }));
    expect(u.near_miss_dates).toBeUndefined();
  });

  it("everyone finishing is not a near miss", () => {
    const u = processEndOfDay(base({ completionsToday: MEMBERS }));
    expect(u.near_miss_dates).toBeUndefined();
  });

  it("grace and paused days don't count", () => {
    expect(
      processEndOfDay(base({ completionsToday: ["alice"], isGraceDay: true })).near_miss_dates,
    ).toBeUndefined();
    expect(
      processEndOfDay(
        base({
          completionsToday: ["alice"],
          memberUids: ["u1", "u2", "u3", "u4"],
          cityPause: { from: "2026-05-01", until: "2026-05-10", set_by: "u1" },
        }),
      ).near_miss_dates,
    ).toBeUndefined();
  });

  it("prunes entries older than the keep window", () => {
    const u = processEndOfDay(
      base({ completionsToday: ["alice"], nearMissDates: ["2026-04-01", "2026-05-01"] }),
    );
    expect(u.near_miss_dates).toEqual(["2026-05-01", TODAY]);
  });
});

describe("shouldSuggestEasyMode", () => {
  const window = ["2026-05-01", "2026-05-02", "2026-05-03"];

  it("fires at the threshold, in hard mode, with no prior suggestion", () => {
    expect(
      shouldSuggestEasyMode({ mode: "hard", nearMissDates: window, processingDate: TODAY, suggestion: null }),
    ).toBe(true);
    expect(NEAR_MISS_THRESHOLD).toBe(3);
  });

  it("never in easy mode", () => {
    expect(
      shouldSuggestEasyMode({ mode: "easy", nearMissDates: window, processingDate: TODAY, suggestion: null }),
    ).toBe(false);
  });

  it("only counts the trailing week", () => {
    const stale = ["2026-04-20", "2026-04-21", "2026-05-03"];
    expect(recentNearMisses(stale, TODAY)).toBe(1);
    expect(
      shouldSuggestEasyMode({ mode: "hard", nearMissDates: stale, processingDate: TODAY, suggestion: null }),
    ).toBe(false);
  });

  it("respects the cooldown after a suggestion", () => {
    const recent = { suggested_on: "2026-05-01", near_misses: 3, dismissed_by: [] };
    expect(
      shouldSuggestEasyMode({ mode: "hard", nearMissDates: window, processingDate: TODAY, suggestion: recent }),
    ).toBe(false);
    const old = { suggested_on: "2026-04-01", near_misses: 3, dismissed_by: [] };
    expect(
      shouldSuggestEasyMode({ mode: "hard", nearMissDates: window, processingDate: TODAY, suggestion: old }),
    ).toBe(true);
    expect(MODE_SUGGESTION_COOLDOWN_DAYS).toBe(14);
  });

  it("pruneNearMisses dedupes and drops the future", () => {
    expect(pruneNearMisses(["2026-05-01", "2026-05-01", "2026-06-01"], TODAY)).toEqual(["2026-05-01"]);
  });
});

describe("buildProgressOf — fractional days", () => {
  it("floors banked days for the day number", () => {
    const p = buildProgressOf({ type: "apartment_c", days_required: 3, days_completed: 1.75 });
    expect(p?.dayNumber).toBe(2);
    const q = buildProgressOf({ type: "apartment_c", days_required: 3, days_completed: 2 });
    expect(q?.dayNumber).toBe(3);
  });
});

describe("decideNudge — easy mode streak rule", () => {
  const at = (id: string) => REMINDER_SLOTS.find((s) => s.id === id)!.minutes;
  const input: NudgeInput = {
    localMinutes: at("evening"),
    todayGameDate: TODAY,
    remindersSentDate: null,
    remindersSentSlots: [],
    memberCount: 3,
    completedCount: 1,
    streak: 4,
    idleDays: 0,
    daysSinceMeteor: null,
  };

  it("hard: the streak is on the line while anyone is missing", () => {
    expect(decideNudge({ ...input, gameMode: "hard" })?.kind).toBe("streak");
    expect(decideNudge(input)?.kind).toBe("streak");
  });

  it("easy: one completion already keeps the streak, so it's a plain reminder", () => {
    expect(decideNudge({ ...input, gameMode: "easy" })?.kind).toBe("reminder");
    expect(decideNudge({ ...input, gameMode: "easy", completedCount: 0 })?.kind).toBe("streak");
  });
});

describe("mode copy", () => {
  it("states the new rule as a number of people", () => {
    expect(modeChangedMessage("Riley", "Riverside", "easy", 4).body).toContain("at least 1 of 4");
    expect(modeChangedMessage("Riley", "Riverside", "hard", 4).body).toContain("all 4 of you");
  });

  it("the suggestion explains easy mode in the agreed words", () => {
    const m = easyModeSuggestionMessage("Riverside", 3, 7);
    expect(m.body).toContain("3 of the last 7 days");
    expect(m.body).toContain("at least 1 person needs to complete your goal to make progress");
  });
});
