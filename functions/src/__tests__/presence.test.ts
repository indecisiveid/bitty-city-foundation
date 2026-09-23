/**
 * presence.ts — the pure half. The Firestore write is exercised by
 * runNudges.test.ts through the fake, and by the emulator smoke.
 */
import {
  idleDaysFor,
  localMinutesOf,
  pushCapped,
  shouldTouch,
  toDate,
  TOUCH_MIN_INTERVAL_MS,
  COMPLETION_MINUTES_KEPT,
} from "../presence";

const NOW = new Date("2026-09-22T21:35:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("shouldTouch", () => {
  it("always stamps a user who has never been seen", () => {
    expect(shouldTouch(null, NOW)).toBe(true);
  });

  it("skips a fresh stamp and rewrites a stale one at the 6h boundary", () => {
    expect(shouldTouch(hoursAgo(5.99), NOW)).toBe(false);
    expect(shouldTouch(new Date(NOW.getTime() - TOUCH_MIN_INTERVAL_MS), NOW)).toBe(true);
    expect(shouldTouch(hoursAgo(6.01), NOW)).toBe(true);
  });
});

describe("toDate", () => {
  it("accepts Firestore Timestamps, Dates and ISO strings; rejects junk", () => {
    const ts = { toDate: () => NOW };
    expect(toDate(ts)).toEqual(NOW);
    expect(toDate(NOW)).toEqual(NOW);
    expect(toDate(NOW.toISOString())).toEqual(NOW);
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("not a date")).toBeNull();
    expect(toDate(42)).toBeNull();
  });
});

describe("idleDaysFor", () => {
  it("is null — unknown, not forever — when the stamp is missing", () => {
    // A user who predates the field must never be farewelled on a guess.
    expect(idleDaysFor(undefined, NOW)).toBeNull();
    expect(idleDaysFor({}, NOW)).toBeNull();
    expect(idleDaysFor({ last_seen_at: null }, NOW)).toBeNull();
  });

  it("floors to whole days from the stamp", () => {
    expect(idleDaysFor({ last_seen_at: hoursAgo(2) }, NOW)).toBe(0);
    expect(idleDaysFor({ last_seen_at: daysAgo(6.9) }, NOW)).toBe(6);
    expect(idleDaysFor({ last_seen_at: daysAgo(7) }, NOW)).toBe(7);
    expect(idleDaysFor({ last_seen_at: { toDate: () => daysAgo(20) } }, NOW)).toBe(20);
  });

  it("never goes negative for a stamp from the future (clock skew)", () => {
    expect(idleDaysFor({ last_seen_at: hoursAgo(-3) }, NOW)).toBe(0);
  });
});

describe("pushCapped", () => {
  it("appends and keeps only the newest N", () => {
    expect(pushCapped([], 5, 3)).toEqual([5]);
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    const many = Array.from({ length: COMPLETION_MINUTES_KEPT }, (_, i) => i);
    const out = pushCapped(many, 99, COMPLETION_MINUTES_KEPT);
    expect(out).toHaveLength(COMPLETION_MINUTES_KEPT);
    expect(out[out.length - 1]).toBe(99);
    expect(out[0]).toBe(1);
  });
});

describe("localMinutesOf", () => {
  it("converts to the city's clock, not the server's", () => {
    // 21:35Z is 17:35 in New York (EDT), 18:35 in São Paulo, 21:35 in UTC.
    expect(localMinutesOf(NOW, "America/New_York")).toBe(17 * 60 + 35);
    expect(localMinutesOf(NOW, "America/Sao_Paulo")).toBe(18 * 60 + 35);
    expect(localMinutesOf(NOW, "UTC")).toBe(21 * 60 + 35);
  });

  it("falls back to UTC for a zone Firestore should never hold but might", () => {
    expect(localMinutesOf(NOW, "Not/AZone")).toBe(21 * 60 + 35);
  });
});
