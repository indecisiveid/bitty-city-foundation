import {
  applyKudos,
  hasKudos,
  kudosCountFor,
  normalizeKudos,
} from "../kudos";

const TODAY = "2026-07-27";
const YESTERDAY = "2026-07-26";

describe("normalizeKudos", () => {
  it("returns an empty bucket for missing state", () => {
    expect(normalizeKudos(undefined, TODAY)).toEqual({ date: TODAY, pairs: [] });
    expect(normalizeKudos(null, TODAY)).toEqual({ date: TODAY, pairs: [] });
  });

  it("drops a bucket stamped with another day", () => {
    const stale = { date: YESTERDAY, pairs: [{ from: "Ana", to: "Bo" }] };
    expect(normalizeKudos(stale, TODAY)).toEqual({ date: TODAY, pairs: [] });
  });

  it("keeps today's pairs and filters malformed entries", () => {
    const raw = {
      date: TODAY,
      pairs: [{ from: "Ana", to: "Bo" }, { from: "Ana" }, null, "nope"],
    };
    expect(normalizeKudos(raw, TODAY)).toEqual({
      date: TODAY,
      pairs: [{ from: "Ana", to: "Bo" }],
    });
  });

  it("survives a non-array pairs field", () => {
    expect(normalizeKudos({ date: TODAY, pairs: "x" }, TODAY)).toEqual({
      date: TODAY,
      pairs: [],
    });
  });
});

describe("applyKudos", () => {
  it("records a first kudo as new", () => {
    const { state, isNew } = applyKudos(null, TODAY, "Ana", "Bo");
    expect(isNew).toBe(true);
    expect(state).toEqual({ date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] });
  });

  it("is idempotent for the same sender→recipient on the same day", () => {
    const first = applyKudos(null, TODAY, "Ana", "Bo");
    const second = applyKudos(first.state, TODAY, "Ana", "Bo");
    expect(second.isNew).toBe(false);
    expect(second.state.pairs).toHaveLength(1);
  });

  it("lets different senders cheer the same person", () => {
    const first = applyKudos(null, TODAY, "Ana", "Bo");
    const second = applyKudos(first.state, TODAY, "Cy", "Bo");
    expect(second.isNew).toBe(true);
    expect(kudosCountFor(second.state, "Bo")).toBe(2);
  });

  it("lets one sender cheer several people", () => {
    const first = applyKudos(null, TODAY, "Ana", "Bo");
    const second = applyKudos(first.state, TODAY, "Ana", "Cy");
    expect(second.state.pairs).toHaveLength(2);
    expect(hasKudos(second.state, "Ana", "Cy")).toBe(true);
  });

  it("does not resurrect yesterday's kudos", () => {
    const yesterday = { date: YESTERDAY, pairs: [{ from: "Ana", to: "Bo" }] };
    const { state, isNew } = applyKudos(yesterday, TODAY, "Ana", "Bo");
    expect(isNew).toBe(true);
    expect(state).toEqual({ date: TODAY, pairs: [{ from: "Ana", to: "Bo" }] });
  });

  it("treats direction as significant (Ana→Bo is not Bo→Ana)", () => {
    const { state } = applyKudos(null, TODAY, "Ana", "Bo");
    expect(hasKudos(state, "Bo", "Ana")).toBe(false);
    const back = applyKudos(state, TODAY, "Bo", "Ana");
    expect(back.isNew).toBe(true);
    expect(back.state.pairs).toHaveLength(2);
  });

  it("does not mutate the state it was given", () => {
    const first = applyKudos(null, TODAY, "Ana", "Bo");
    applyKudos(first.state, TODAY, "Cy", "Bo");
    expect(first.state.pairs).toHaveLength(1);
  });
});

describe("kudosCountFor", () => {
  it("counts only kudos received, not sent", () => {
    let state = applyKudos(null, TODAY, "Ana", "Bo").state;
    state = applyKudos(state, TODAY, "Cy", "Bo").state;
    state = applyKudos(state, TODAY, "Bo", "Ana").state;
    expect(kudosCountFor(state, "Bo")).toBe(2);
    expect(kudosCountFor(state, "Ana")).toBe(1);
    expect(kudosCountFor(state, "Cy")).toBe(0);
  });
});
