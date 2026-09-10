/**
 * Vacation mode helpers. Mirrored on mobile in utils/pauses.ts — that suite
 * copies these cases, so a rule change here must land there too.
 */
import {
  MAX_PAUSE_DAYS,
  addDays,
  isPauseActive,
  pausedMembersOn,
  activeMembersOn,
  isDayPaused,
  bridgeDates,
  endPauseEarly,
  pruneExpired,
  pauseUntilProblem,
  maxPauseUntil,
  Roster,
  pausedDaysThrough,
} from "../pauses";

const TODAY = "2026-05-04";

function roster(over: Partial<Roster> = {}): Roster {
  return {
    members: ["alice", "bob", "cara"],
    memberUids: ["u-alice", "u-bob", "u-cara"],
    memberPauses: {},
    cityPause: null,
    ...over,
  };
}

describe("isPauseActive", () => {
  const p = { from: "2026-05-04", until: "2026-05-06" };
  it("is inclusive at both ends", () => {
    expect(isPauseActive(p, "2026-05-03")).toBe(false);
    expect(isPauseActive(p, "2026-05-04")).toBe(true);
    expect(isPauseActive(p, "2026-05-06")).toBe(true);
    expect(isPauseActive(p, "2026-05-07")).toBe(false);
  });
  it("treats a missing pause as inactive", () => {
    expect(isPauseActive(null, TODAY)).toBe(false);
    expect(isPauseActive(undefined, TODAY)).toBe(false);
  });
});

describe("roster on a date", () => {
  it("drops a paused member from the active roster, by uid", () => {
    const r = roster({ memberPauses: { "u-bob": { from: TODAY, until: TODAY } } });
    expect(pausedMembersOn(r, TODAY)).toEqual(["bob"]);
    expect(activeMembersOn(r, TODAY)).toEqual(["alice", "cara"]);
    // Tomorrow the pause is over.
    expect(activeMembersOn(r, addDays(TODAY, 1))).toEqual(["alice", "bob", "cara"]);
  });

  it("ignores a pause for a uid no longer in the crew", () => {
    const r = roster({ memberPauses: { "u-gone": { from: TODAY, until: TODAY } } });
    expect(pausedMembersOn(r, TODAY)).toEqual([]);
  });

  it("is not a paused day while anyone is still active", () => {
    const r = roster({
      memberPauses: {
        "u-alice": { from: TODAY, until: TODAY },
        "u-bob": { from: TODAY, until: TODAY },
      },
    });
    expect(isDayPaused(r, TODAY)).toBe(false);
  });

  it("is a paused day once EVERY member is away — the crew-of-one case", () => {
    const r = roster({
      members: ["alice"],
      memberUids: ["u-alice"],
      memberPauses: { "u-alice": { from: TODAY, until: TODAY } },
    });
    expect(isDayPaused(r, TODAY)).toBe(true);
  });

  it("is a paused day under a city pause regardless of members", () => {
    const r = roster({ cityPause: { from: "2026-05-01", until: "2026-05-10" } });
    expect(isDayPaused(r, TODAY)).toBe(true);
    expect(activeMembersOn(r, TODAY)).toEqual(["alice", "bob", "cara"]);
  });

  it("never calls an empty crew paused", () => {
    expect(isDayPaused(roster({ members: [], memberUids: [] }), TODAY)).toBe(false);
  });
});

describe("bridgeDates", () => {
  it("unions frozen and paused days without duplicates", () => {
    expect(bridgeDates(["2026-05-01", "2026-05-02"], ["2026-05-02", "2026-05-03"])).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });
  it("tolerates missing arrays", () => {
    expect(bridgeDates(null, undefined)).toEqual([]);
  });
});

describe("endPauseEarly", () => {
  it("keeps the days already covered and ends yesterday", () => {
    const p = { from: "2026-05-01", until: "2026-05-10" };
    expect(endPauseEarly(p, TODAY)).toEqual({ from: "2026-05-01", until: "2026-05-03" });
  });
  it("drops a pause that hasn't reached a day yet", () => {
    expect(endPauseEarly({ from: TODAY, until: "2026-05-10" }, TODAY)).toBeNull();
    expect(endPauseEarly({ from: "2026-05-06", until: "2026-05-10" }, TODAY)).toBeNull();
  });
  it("leaves an already-finished pause alone", () => {
    const p = { from: "2026-05-01", until: "2026-05-02" };
    expect(endPauseEarly(p, TODAY)).toBe(p);
  });
});

describe("pruneExpired", () => {
  it("keeps pauses ending today or later, drops the rest", () => {
    const out = pruneExpired(
      {
        a: { from: "2026-05-01", until: "2026-05-03" },
        b: { from: "2026-05-01", until: TODAY },
        c: { from: "2026-05-08", until: "2026-05-09" },
      },
      TODAY,
    );
    expect(Object.keys(out)).toEqual(["b", "c"]);
  });
});

describe("pauseUntilProblem", () => {
  it("accepts today through the cap", () => {
    expect(pauseUntilProblem(TODAY, TODAY)).toBeNull();
    expect(pauseUntilProblem(maxPauseUntil(TODAY), TODAY)).toBeNull();
    expect(maxPauseUntil(TODAY)).toBe(addDays(TODAY, MAX_PAUSE_DAYS - 1));
  });
  it("rejects the past, the day past the cap, and junk", () => {
    expect(pauseUntilProblem(addDays(TODAY, -1), TODAY)).toBe("past");
    expect(pauseUntilProblem(addDays(TODAY, MAX_PAUSE_DAYS), TODAY)).toBe("too_long");
    expect(pauseUntilProblem("next tuesday", TODAY)).toBe("malformed");
    expect(pauseUntilProblem(undefined, TODAY)).toBe("malformed");
  });
});

describe("pausedDaysThrough", () => {
  it("lists every city-paused day up to the processing day", () => {
    const r = roster({ cityPause: { from: "2026-05-01", until: "2026-05-10" } });
    expect(pausedDaysThrough(r, TODAY)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
    ]);
  });
  it("finds the days when every member's vacations overlap, and only those", () => {
    const r = roster({
      members: ["alice", "bob"],
      memberUids: ["u-alice", "u-bob"],
      memberPauses: {
        "u-alice": { from: "2026-05-01", until: "2026-05-03" },
        "u-bob": { from: "2026-05-02", until: "2026-05-06" },
      },
    });
    expect(pausedDaysThrough(r, "2026-05-10")).toEqual(["2026-05-02", "2026-05-03"]);
  });
  it("is empty with nothing paused", () => {
    expect(pausedDaysThrough(roster(), TODAY)).toEqual([]);
  });
});
