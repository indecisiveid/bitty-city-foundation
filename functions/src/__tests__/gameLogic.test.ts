/**
 * Unit tests for the TS port of `compute_streak` (and related helpers).
 *
 * The four docstring examples from Python's `compute_streak` are covered
 * first, then edge-case gaps and the two timezone-aware helpers.
 */

import { computeStreak, needsDayProcessing, getProcessingDate } from "../gameLogic";

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
