import { consolidate, cityList, NudgeEntry, messageFor } from "../nudgeMessages";
import { Nudge } from "../reminderLogic";

/**
 * Consolidation exists to stop one person being pushed once per city.
 *
 * The scheduler decides city by city — correctly, since timezone, streak and
 * crew are all per-city. But a person is not a city, and three cities used to
 * mean three near-identical pushes seconds apart. That is how an app gets its
 * notifications switched off for good, and there is no second permission
 * prompt.
 *
 * The load-bearing guarantee is the FIRST test: one city must produce exactly
 * the copy it always did. Everything else here is new behaviour; that one is a
 * promise not to have broken the common case on the way.
 */

const nudge = (over: Partial<Nudge> = {}): Nudge => ({
  kind: "reminder",
  recipients: "incomplete",
  slot: "midday",
  ...over,
});

const entry = (
  cityName: string,
  over: Partial<NudgeEntry> = {},
  ctxOver: Partial<NudgeEntry["ctx"]> = {},
): NudgeEntry => ({
  groupId: `g-${cityName}`,
  cityName,
  nudge: nudge(),
  role: "pending",
  ctx: { cityName, streak: 0, build: null, pendingNames: ["Sam"], ...ctxOver },
  ...over,
});

describe("consolidate — one city is untouched", () => {
  it("returns the per-city copy byte for byte", () => {
    // The whole point of the guarantee: someone with a single city must not be
    // able to tell that consolidation was ever added.
    const e = entry("Riverside");
    const out = consolidate([e])!;
    const direct = messageFor(e.nudge, e.ctx, e.role);
    expect(out.title).toBe(direct.title);
    expect(out.body).toBe(direct.body);
  });

  it("keeps group_id so the tap still opens that city", () => {
    expect(consolidate([entry("Riverside")])!.data).toEqual({
      group_id: "g-Riverside",
    });
  });

  it("holds for every slot and kind, not just the one I happened to try", () => {
    const slots = ["morning", "midday", "evening", "lastCall"] as const;
    const kinds = ["reminder", "streak", "meteor"] as const;
    for (const slot of slots) {
      for (const kind of kinds) {
        const e = entry("Riverside", { nudge: nudge({ slot, kind }) }, { streak: 4 });
        expect(consolidate([e])!.body).toBe(messageFor(e.nudge, e.ctx, e.role).body);
      }
    }
  });

  it("returns nothing at all when there is nothing owed", () => {
    expect(consolidate([])).toBeNull();
  });
});

describe("consolidate — several cities become one push", () => {
  it("names the cities instead of sending one push each", () => {
    const out = consolidate([entry("Riverside"), entry("Test")])!;
    expect(out.body).toContain("Riverside and Test");
  });

  it("drops group_id, because there is no one city to open", () => {
    // openFromData early-returns without it and lands on Home, which is the
    // right destination for a message about several cities.
    expect(consolidate([entry("A"), entry("B")])!.data).toBeUndefined();
  });

  it("lets the meteor take the whole message", () => {
    // A meteor is the only nudge that costs buildings. It outranks nagging.
    const out = consolidate([
      entry("Riverside"),
      entry("Doomed", { nudge: nudge({ kind: "meteor", recipients: "all" }) }),
    ])!;
    expect(out.title).toContain("Meteor");
    expect(out.body).toContain("Doomed");
    expect(out.body).toContain("1 other city");
  });

  it("counts the streaks actually at stake", () => {
    const out = consolidate([
      entry("A", { nudge: nudge({ kind: "streak" }) }),
      entry("B", { nudge: nudge({ kind: "streak" }) }),
      entry("C"),
    ])!;
    expect(out.title).toBe("🔥 2 streaks on the line");
  });

  it("uses the singular for a single streak", () => {
    const out = consolidate([
      entry("A", { nudge: nudge({ kind: "streak" }) }),
      entry("B"),
    ])!;
    expect(out.title).toBe("🔥 1 streak on the line");
    expect(out.body).toContain("streak is riding on it");
  });

  it("stays quiet about streaks when none are at stake", () => {
    const out = consolidate([entry("A"), entry("B")])!;
    expect(out.body).not.toContain("streak");
  });
});

describe("consolidate — the last-call chaser across cities", () => {
  const done = (city: string) =>
    entry(city, { role: "done", nudge: nudge({ slot: "lastCall", recipients: "all" }) });

  it("asks someone who is done everywhere to chase their crews", () => {
    const out = consolidate([done("A"), done("B")])!;
    expect(out.title).toContain("Last call");
    expect(out.body).toContain("You're done in A and B");
    expect(out.body).toContain("2 crews");
  });

  it("leads with what the person must DO when they owe a goal somewhere", () => {
    // Mixed: pending in one city, merely chasing in another. Their own
    // outstanding goal is the actionable half, so it leads.
    const out = consolidate([entry("Owed"), done("Waiting")])!;
    expect(out.body).toContain("still open in Owed");
    expect(out.body).toContain("1 other crew is waiting");
    expect(out.body).not.toContain("You're done");
  });
});

describe("cityList", () => {
  it("reads like a person listing them", () => {
    expect(cityList(["A"])).toBe("A");
    expect(cityList(["A", "B"])).toBe("A and B");
  });

  it("stops listing past two, because the count is the useful fact", () => {
    expect(cityList(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });

  it("degrades to something sayable rather than empty", () => {
    expect(cityList([])).toBe("your cities");
  });
});
