import { readFileSync } from "fs";
import { join } from "path";
import { applyProof, normalizeProofs, isProofKeyFor, photoCount, MAX_PROOF_BYTES } from "../proofs";

const TODAY = "2026-09-03";
const YESTERDAY = "2026-09-02";

describe("isProofKeyFor", () => {
  it("accepts a jpg under the caller's own slot in this group", () => {
    expect(isProofKeyFor("proofs/g1/u1/abcdefgh.jpg", "g1", "u1")).toBe(true);
    expect(isProofKeyFor("proofs/g1/u1/0f3e9c2a-7b1d-4e55-9a10-1234567890ab.jpg", "g1", "u1")).toBe(true);
  });
  it("rejects other users, other groups, other extensions, and path tricks", () => {
    expect(isProofKeyFor("proofs/g1/u2/abcdefgh.jpg", "g1", "u1")).toBe(false);
    expect(isProofKeyFor("proofs/g2/u1/abcdefgh.jpg", "g1", "u1")).toBe(false);
    expect(isProofKeyFor("proofs/g1/u1/abcdefgh.png", "g1", "u1")).toBe(false);
    expect(isProofKeyFor("proofs/g1/u1/../u2/abcdefgh.jpg", "g1", "u1")).toBe(false);
    expect(isProofKeyFor("proofs/g1/u1/short.jpg", "g1", "u1")).toBe(false);
    expect(isProofKeyFor(42, "g1", "u1")).toBe(false);
  });
});

describe("normalizeProofs", () => {
  it("returns an empty bucket for missing state", () => {
    expect(normalizeProofs(undefined, TODAY)).toEqual({ date: TODAY, entries: {} });
    expect(normalizeProofs(null, TODAY)).toEqual({ date: TODAY, entries: {} });
  });
  it("drops a bucket stamped with another day", () => {
    const stale = { date: YESTERDAY, entries: { Ana: { status: "photo", key: "proofs/g/u/abcdefgh.jpg" } } };
    expect(normalizeProofs(stale, TODAY)).toEqual({ date: TODAY, entries: {} });
  });
  it("keeps today's entries and filters malformed ones", () => {
    const raw = {
      date: TODAY,
      entries: {
        Ana: { status: "photo", key: "proofs/g/u/abcdefgh.jpg" },
        Bo: { status: "skipped" },
        Cy: { status: "banana" },
        Di: "nope",
      },
    };
    expect(normalizeProofs(raw, TODAY)).toEqual({
      date: TODAY,
      entries: { Ana: { status: "photo", key: "proofs/g/u/abcdefgh.jpg" }, Bo: { status: "skipped" } },
    });
  });
});

describe("applyProof", () => {
  it("adds an entry and reports isNew", () => {
    const { state, isNew } = applyProof(null, TODAY, "Ana", { status: "skipped" });
    expect(isNew).toBe(true);
    expect(state).toEqual({ date: TODAY, entries: { Ana: { status: "skipped" } } });
  });
  it("is idempotent — the first proof of the day wins", () => {
    const first = applyProof(null, TODAY, "Ana", { status: "photo", key: "proofs/g/u/k1k1k1k1.jpg" }).state;
    const { state, isNew } = applyProof(first, TODAY, "Ana", { status: "photo", key: "proofs/g/u/k2k2k2k2.jpg" });
    expect(isNew).toBe(false);
    expect(state.entries.Ana).toEqual({ status: "photo", key: "proofs/g/u/k1k1k1k1.jpg" });
  });
});

it("caps uploads at 5 MiB, matching storage.rules", () => {
  expect(MAX_PROOF_BYTES).toBe(5 * 1024 * 1024);
});

it("day rollover clears proofs_today alongside kudos_today", () => {
  const src = readFileSync(join(__dirname, "..", "groupHandlers.ts"), "utf8");
  const at = src.indexOf("last_processed_date: processingDate");
  const block = src.slice(at, at + 600);
  expect(block).toMatch(/kudos_today: null/);
  expect(block).toMatch(/proofs_today: null/);
});

describe("photoCount", () => {
  it("counts today's photos, not skips or another day's", () => {
    const raw = {
      date: TODAY,
      entries: { Tom: { status: "photo", key: "proofs/g1/u1/a.jpg" }, Amit: { status: "skipped" } },
    };
    expect(photoCount(raw, TODAY)).toBe(1);
    expect(photoCount(raw, YESTERDAY)).toBe(0);
    expect(photoCount(null, TODAY)).toBe(0);
  });
});

// --- Health proofs ---------------------------------------------------------

import { sharedProofCount, isHealthReading, resolveHealthProof, NOT_A_HEALTH_CITY, NOT_THERE_YET } from "../proofs";

const READING = { metric: "steps", value: 12000, target: 10000, sources: ["Apple Watch"] };

describe("isHealthReading", () => {
  it("accepts a well-formed reading", () => {
    expect(isHealthReading(READING)).toBe(true);
    expect(isHealthReading({ ...READING, sources: [] })).toBe(true);
    expect(
      isHealthReading({ metric: "workout", value: 45, target: 30, sources: ["Strava"], workout: { activity: "Running", minutes: 45, km: 8.25 } }),
    ).toBe(true);
  });
  it("rejects bad values, targets, sources and workouts", () => {
    expect(isHealthReading({ ...READING, value: -1 })).toBe(false);
    expect(isHealthReading({ ...READING, value: 200001 })).toBe(false);
    expect(isHealthReading({ ...READING, value: 1.5 })).toBe(false);
    expect(isHealthReading({ ...READING, target: 0 })).toBe(false);
    expect(isHealthReading({ ...READING, metric: "sleep" })).toBe(false);
    expect(isHealthReading({ ...READING, sources: ["a", "b", "c", "d"] })).toBe(false);
    expect(isHealthReading({ ...READING, sources: [""] })).toBe(false);
    expect(isHealthReading({ ...READING, sources: ["x".repeat(41)] })).toBe(false);
    expect(isHealthReading({ ...READING, sources: undefined })).toBe(false);
    const w = { metric: "workout", value: 45, target: 30, sources: [] };
    expect(isHealthReading({ ...w, workout: { activity: "Run", minutes: 0 } })).toBe(false);
    expect(isHealthReading({ ...w, workout: { activity: "Run", minutes: 1441 } })).toBe(false);
    expect(isHealthReading({ ...w, workout: { activity: "", minutes: 45 } })).toBe(false);
    expect(isHealthReading({ ...w, workout: { activity: "Run", minutes: 45, km: 501 } })).toBe(false);
    expect(isHealthReading({ ...w, workout: { activity: "Run", minutes: 45, km: 5.123 } })).toBe(false);
    expect(isHealthReading({ ...w, workout: { activity: "Run", minutes: 45, km: -1 } })).toBe(false);
  });
});

describe("health entries in proofs_today", () => {
  it("keeps valid health entries, with or without numbers, and drops malformed ones", () => {
    const raw = {
      date: TODAY,
      entries: {
        Ana: { status: "health", health: READING },
        Bo: { status: "health" },
        Cy: { status: "health", auto: true },
        Di: { status: "health", health: { ...READING, value: "lots" } },
        Ed: { status: "health", key: "proofs/g/u/abcdefgh.jpg" },
        Fi: { status: "health", auto: false },
      },
    };
    expect(Object.keys(normalizeProofs(raw, TODAY).entries)).toEqual(["Ana", "Bo", "Cy"]);
  });
  it("photoCount ignores health; sharedProofCount counts photos + shared readings", () => {
    const raw = {
      date: TODAY,
      entries: {
        Tom: { status: "photo", key: "proofs/g1/u1/abcdefgh.jpg" },
        Ana: { status: "health", health: READING },
        Bo: { status: "health" },
        Cy: { status: "skipped" },
      },
    };
    expect(photoCount(raw, TODAY)).toBe(1);
    expect(sharedProofCount(raw, TODAY)).toBe(2);
    expect(sharedProofCount(raw, YESTERDAY)).toBe(0);
    expect(sharedProofCount({ date: TODAY, entries: { Bo: { status: "health" } } }, TODAY)).toBe(0);
  });
});

describe("resolveHealthProof", () => {
  const STEPS_CITY = { daily_goal: "Walk 10,000 steps" };

  it("a shared reading stores the numbers, with the CITY's target", () => {
    const r = resolveHealthProof({ health: { ...READING, target: 1 }, share: true }, STEPS_CITY);
    expect(r).toEqual({
      ok: true,
      goal: { metric: "steps", target: 10000 },
      entry: { status: "health", health: { metric: "steps", value: 12000, target: 10000, sources: ["Apple Watch"] } },
    });
  });
  it("not shared → no numbers at all", () => {
    for (const share of [false, undefined, "yes", 1]) {
      const r = resolveHealthProof({ health: READING, share }, STEPS_CITY);
      expect(r).toMatchObject({ ok: true, entry: { status: "health" } });
      if (r.ok) expect(r.entry).toEqual({ status: "health" });
    }
  });
  it("stores auto only when it is exactly true", () => {
    const yes = resolveHealthProof({ health: READING, share: false, auto: true }, STEPS_CITY);
    expect(yes.ok && yes.entry).toEqual({ status: "health", auto: true });
    const no = resolveHealthProof({ health: READING, share: true, auto: "true" }, STEPS_CITY);
    expect(no.ok && no.entry.auto).toBeUndefined();
  });
  it("drops fields the client tacked on", () => {
    const r = resolveHealthProof(
      { health: { ...READING, extra: "x", workout: undefined }, share: true },
      STEPS_CITY,
    );
    expect(r.ok && r.entry.health).toEqual({ metric: "steps", value: 12000, target: 10000, sources: ["Apple Watch"] });
  });
  it("keeps a workout's details when shared", () => {
    const city = { health_goal: { metric: "workout", target: 30 } };
    const r = resolveHealthProof(
      { health: { metric: "workout", value: 45, target: 30, sources: ["Strava"], workout: { activity: "Running", minutes: 45, km: 8.2, pace: 1 } }, share: true },
      city,
    );
    expect(r.ok && r.entry.health?.workout).toEqual({ activity: "Running", minutes: 45, km: 8.2 });
  });
  it("refuses a city Health can't count", () => {
    expect(resolveHealthProof({ health: READING, share: true }, { daily_goal: "Read 10 pages" })).toEqual({
      ok: false,
      code: "failed-precondition",
      message: NOT_A_HEALTH_CITY,
    });
    expect(resolveHealthProof({ health: READING, share: true }, { daily_goal: "Walk 10,000 steps", health_goal: null })).toMatchObject({
      ok: false,
      code: "failed-precondition",
    });
  });
  it("refuses a metric that isn't the city's", () => {
    expect(resolveHealthProof({ health: { ...READING, metric: "mindful_minutes", value: 20 }, share: true }, STEPS_CITY)).toMatchObject({
      ok: false,
      code: "invalid-argument",
    });
  });
  it("refuses malformed readings", () => {
    const bad = [
      "steps",
      { ...READING, value: 1.5 },
      { ...READING, value: 200001 },
      { ...READING, value: -5 },
      { ...READING, sources: "Apple Watch" },
      { ...READING, sources: ["a", "b", "c", "d"] },
      { ...READING, workout: { activity: "Run" } },
    ];
    for (const health of bad) {
      expect(resolveHealthProof({ health, share: true }, STEPS_CITY)).toMatchObject({ ok: false, code: "invalid-argument" });
    }
  });
  it("refuses below the city's target, whatever target the client claims", () => {
    expect(resolveHealthProof({ health: { ...READING, value: 9999, target: 5000 }, share: true }, STEPS_CITY)).toEqual({
      ok: false,
      code: "failed-precondition",
      message: NOT_THERE_YET,
    });
    expect(resolveHealthProof({ health: { ...READING, value: 10000 }, share: true }, STEPS_CITY).ok).toBe(true);
  });
});
