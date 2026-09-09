import { readFileSync } from "fs";
import { join } from "path";
import { applyProof, normalizeProofs, isProofKeyFor, MAX_PROOF_BYTES } from "../proofs";

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
