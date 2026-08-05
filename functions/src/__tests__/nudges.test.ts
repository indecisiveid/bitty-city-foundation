import {
  applyNudge,
  hasNudged,
  normalizeNudges,
  nudgeBody,
  nudgeCountFor,
} from "../nudges";

const TODAY = "2026-08-04";
const YESTERDAY = "2026-08-03";

describe("normalizeNudges", () => {
  it("returns an empty bucket for missing state", () => {
    expect(normalizeNudges(undefined, TODAY)).toEqual({ date: TODAY, pairs: [] });
    expect(normalizeNudges(null, TODAY)).toEqual({ date: TODAY, pairs: [] });
  });

  it("does not resurrect yesterday's nudges", () => {
    const stale = { date: YESTERDAY, pairs: [{ from: "Ana", to: "Bo" }] };
    expect(normalizeNudges(stale, TODAY)).toEqual({ date: TODAY, pairs: [] });
  });

  it("keeps today's pairs", () => {
    const state = { date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] };
    expect(normalizeNudges(state, TODAY)).toEqual(state);
  });

  it("drops malformed pairs rather than throwing", () => {
    const messy = {
      date: TODAY,
      pairs: [{ from: "Ana", to: "Bo" }, { from: 3 }, null, "nope"],
    };
    expect(normalizeNudges(messy, TODAY).pairs).toEqual([{ from: "Ana", to: "Bo" }]);
  });

  it("survives a bucket whose pairs field isn't an array", () => {
    expect(normalizeNudges({ date: TODAY, pairs: "x" }, TODAY)).toEqual({
      date: TODAY,
      pairs: [],
    });
  });
});

describe("hasNudged", () => {
  const state = { date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] };

  it("finds a recorded nudge", () => {
    expect(hasNudged(state, "Ana", "Bo")).toBe(true);
  });

  it("treats direction as significant (Ana→Bo is not Bo→Ana)", () => {
    expect(hasNudged(state, "Bo", "Ana")).toBe(false);
  });

  it("is false for an untouched pair", () => {
    expect(hasNudged(state, "Ana", "Cy")).toBe(false);
  });
});

describe("nudgeCountFor", () => {
  it("counts nudges received from anyone", () => {
    const state = {
      date: TODAY,
      pairs: [
        { from: "Ana", to: "Bo" },
        { from: "Cy", to: "Bo" },
        { from: "Bo", to: "Cy" },
      ],
    };
    expect(nudgeCountFor(state, "Bo")).toBe(2);
    expect(nudgeCountFor(state, "Cy")).toBe(1);
    expect(nudgeCountFor(state, "Ana")).toBe(0);
  });
});

describe("applyNudge", () => {
  it("records a first nudge as new", () => {
    const { state, isNew } = applyNudge(null, TODAY, "Ana", "Bo");
    expect(isNew).toBe(true);
    expect(state).toEqual({ date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] });
  });

  it("is idempotent for the same sender→recipient on the same day", () => {
    const first = applyNudge(null, TODAY, "Ana", "Bo");
    const second = applyNudge(first.state, TODAY, "Ana", "Bo");
    expect(second.isNew).toBe(false);
    expect(second.state.pairs).toHaveLength(1);
  });

  it("lets a different sender nudge the same person", () => {
    const first = applyNudge(null, TODAY, "Ana", "Bo");
    const second = applyNudge(first.state, TODAY, "Cy", "Bo");
    expect(second.isNew).toBe(true);
    expect(second.state.pairs).toHaveLength(2);
  });

  it("lets the same sender nudge a different person", () => {
    const first = applyNudge(null, TODAY, "Ana", "Bo");
    const second = applyNudge(first.state, TODAY, "Ana", "Cy");
    expect(second.isNew).toBe(true);
    expect(second.state.pairs).toHaveLength(2);
  });

  it("re-opens the button on a new day", () => {
    const yesterday = applyNudge(null, YESTERDAY, "Ana", "Bo");
    const today = applyNudge(yesterday.state, TODAY, "Ana", "Bo");
    expect(today.isNew).toBe(true);
    expect(today.state).toEqual({ date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] });
  });

  it("does not mutate the state it was given", () => {
    const before = { date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] };
    const snapshot = JSON.stringify(before);
    applyNudge(before, TODAY, "Cy", "Bo");
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("nudgeBody", () => {
  it("reads like the card's example", () => {
    expect(nudgeBody("Christian", "Exercise for 30 minutes")).toBe(
      "Christian is reminding you to Exercise for 30 minutes.",
    );
  });

  it("doesn't double up punctuation on a goal that already ends in one", () => {
    expect(nudgeBody("Ana", "Read 10 pages.")).toBe("Ana is reminding you to Read 10 pages.");
    expect(nudgeBody("Ana", "Run!")).toBe("Ana is reminding you to Run.");
  });

  it("falls back when the group somehow has no goal text", () => {
    expect(nudgeBody("Ana", "")).toBe("Ana is reminding you to complete today's goal.");
    expect(nudgeBody("Ana", "   ")).toBe("Ana is reminding you to complete today's goal.");
  });
});
