/**
 * The one policy every push passes through (notices.ts): tiers, daily
 * budgets per category, the important exemption, winback cooldown, once-only
 * keys, and quiet hours that soften rather than drop.
 */
import {
  DAILY_BUDGET,
  decideNotice,
  EMPTY_LEDGER,
  isQuietTime,
  ledgerOf,
  NoticeMeta,
  recordNotice,
  WINBACK_COOLDOWN_DAYS,
} from "../notices";

const TODAY = "2026-09-23";
const NOON = 12 * 60;
const meta = (over: Partial<NoticeMeta> = {}): NoticeMeta => ({
  type: "city_grew",
  category: "crew",
  priority: "normal",
  variant: "city_grew.v1",
  ...over,
});
const sent = (n: number, category: NoticeMeta["category"] = "crew") =>
  ({ date: TODAY, counts: { [category]: n }, keys: {} });

describe("decideNotice — tiers and budgets", () => {
  it("an active person gets crew news up to the daily budget", () => {
    const budget = DAILY_BUDGET.active.crew!;
    expect(decideNotice(meta(), "active", sent(budget - 1), TODAY, NOON)).toEqual({ deliver: true, quiet: false });
    expect(decideNotice(meta(), "active", sent(budget), TODAY, NOON)).toMatchObject({ deliver: false });
  });

  it("yesterday's count does not carry over", () => {
    expect(decideNotice(meta(), "active", { ...sent(99), date: "2026-09-22" }, TODAY, NOON).deliver).toBe(true);
  });

  it("a cooling person gets one crew notice a day", () => {
    expect(decideNotice(meta(), "cooling", EMPTY_LEDGER, TODAY, NOON).deliver).toBe(true);
    expect(decideNotice(meta(), "cooling", sent(1), TODAY, NOON).deliver).toBe(false);
  });

  it("something at stake today skips the budget — except for someone gone quiet", () => {
    const stall = meta({ type: "build_stalled", priority: "important" });
    expect(decideNotice(stall, "cooling", sent(5), TODAY, NOON).deliver).toBe(true);
    expect(decideNotice(stall, "dormant", EMPTY_LEDGER, TODAY, NOON).deliver).toBe(false);
  });

  it("keeps the dormant promise: no crew news, no quests, no reminders", () => {
    for (const category of ["crew", "quest", "reminder"] as const) {
      expect(decideNotice(meta({ category }), "dormant", EMPTY_LEDGER, TODAY, NOON).deliver).toBe(false);
    }
  });

  it("still lets one friend's message a day through to a dormant person", () => {
    const kudos = meta({ type: "kudos", category: "social", priority: "transactional" });
    expect(decideNotice(kudos, "dormant", EMPTY_LEDGER, TODAY, NOON).deliver).toBe(true);
    expect(decideNotice(kudos, "dormant", sent(1, "social"), TODAY, NOON).deliver).toBe(false);
  });
});

describe("decideNotice — winback", () => {
  const winback = meta({ type: "quest_offered", category: "winback" });

  it("reaches a dormant person once per cooldown", () => {
    expect(decideNotice(winback, "dormant", EMPTY_LEDGER, TODAY, NOON).deliver).toBe(true);
    const after = recordNotice(EMPTY_LEDGER, winback, TODAY);
    expect(decideNotice(winback, "dormant", after, "2026-09-30", NOON).deliver).toBe(false);
    const later = new Date(Date.parse(`${TODAY}T00:00:00Z`) + WINBACK_COOLDOWN_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(decideNotice(winback, "dormant", after, later, NOON).deliver).toBe(true);
  });
});

describe("decideNotice — once-only and quiet hours", () => {
  it("drops a notice whose key was already sent", () => {
    const m = meta({ dedupeKey: "quest:invite_bonus:g:2026-09-23:announce" });
    const after = recordNotice(EMPTY_LEDGER, m, TODAY);
    expect(decideNotice(m, "active", after, TODAY, NOON)).toEqual({ deliver: false, reason: "already sent" });
  });

  it("delivers quietly between 22:00 and 07:30, never drops for the hour", () => {
    expect(isQuietTime(22 * 60)).toBe(true);
    expect(isQuietTime(3 * 60)).toBe(true);
    expect(isQuietTime(7 * 60 + 29)).toBe(true);
    expect(isQuietTime(7 * 60 + 30)).toBe(false);
    expect(isQuietTime(21 * 60 + 59)).toBe(false);
    expect(decideNotice(meta(), "active", EMPTY_LEDGER, TODAY, 23 * 60)).toEqual({ deliver: true, quiet: true });
  });
});

describe("recordNotice / ledgerOf", () => {
  it("counts per category for the day and resets on a new day", () => {
    let l = recordNotice(EMPTY_LEDGER, meta(), TODAY);
    l = recordNotice(l, meta({ category: "quest" }), TODAY);
    expect(l).toEqual({ date: TODAY, counts: { crew: 1, quest: 1 }, keys: {} });
    expect(recordNotice(l, meta(), "2026-09-24").counts).toEqual({ crew: 1 });
  });

  it("forgets old once-only keys", () => {
    const l = { date: TODAY, counts: {}, keys: { old: "2026-06-01", recent: "2026-09-20" } };
    expect(Object.keys(recordNotice(l, meta(), TODAY).keys)).toEqual(["recent"]);
  });

  it("survives junk", () => {
    expect(ledgerOf(undefined)).toEqual(EMPTY_LEDGER);
    expect(ledgerOf({ counts: 3 })).toEqual({ date: null, counts: {}, keys: {} });
  });
});
