import {
  applyBrickEntry,
  bricksForLanding,
  hatRefillQuote,
  HAT_PRICE_BRICKS,
  BRICK_LEDGER_MAX,
} from "../bricks";

const entry = (id: string, amount: number) => ({
  event_id: id,
  amount,
  reason: "landing" as const,
  at: "2026-09-23T00:00:00.000Z",
});

describe("bricksForLanding", () => {
  it("pays by the build's day cost", () => {
    expect(bricksForLanding(1)).toBe(10);
    expect(bricksForLanding(3)).toBe(40);
    expect(bricksForLanding(5)).toBe(75);
    expect(bricksForLanding(7)).toBe(120);
  });

  it("pays the one-day rate for a restoration or an unknown build", () => {
    expect(bricksForLanding(undefined)).toBe(10);
    expect(bricksForLanding(0)).toBe(10);
  });

  it("rounds an odd day cost down to the nearest tier", () => {
    expect(bricksForLanding(4)).toBe(40);
    expect(bricksForLanding(9)).toBe(120);
  });
});

describe("applyBrickEntry", () => {
  it("credits a fresh wallet and starts the ledger", () => {
    expect(applyBrickEntry(null, entry("e1", 40))).toEqual({
      bricks: 40,
      brick_ledger: [entry("e1", 40)],
    });
  });

  it("pays a landing once, however many times it is processed", () => {
    const once = applyBrickEntry(null, entry("e1", 40))!;
    expect(applyBrickEntry(once, entry("e1", 40))).toBeNull();
    expect(applyBrickEntry(once, entry("e2", 10))?.bricks).toBe(50);
  });

  it("refuses a spend that would go negative", () => {
    const w = applyBrickEntry(null, entry("e1", 40))!;
    expect(applyBrickEntry(w, { ...entry("s1", -60), reason: "hats" })).toBeNull();
    expect(applyBrickEntry(w, { ...entry("s1", -40), reason: "hats" })?.bricks).toBe(0);
  });

  it("caps the ledger", () => {
    let w = applyBrickEntry(null, entry("e0", 1))!;
    for (let i = 1; i <= BRICK_LEDGER_MAX + 5; i++) w = applyBrickEntry(w, entry(`e${i}`, 1))!;
    expect(w.brick_ledger).toHaveLength(BRICK_LEDGER_MAX);
    expect(w.bricks).toBe(BRICK_LEDGER_MAX + 6);
  });
});

describe("hatRefillQuote", () => {
  it("prices the empty slots at the hat price", () => {
    expect(hatRefillQuote({ streakFreezes: 1, cap: 3, count: 2 })).toEqual({ count: 2, cost: 2 * HAT_PRICE_BRICKS });
  });

  it("never sells past the cap", () => {
    expect(hatRefillQuote({ streakFreezes: 2, cap: 3, count: 5 })).toEqual({ count: 1, cost: HAT_PRICE_BRICKS });
    expect(hatRefillQuote({ streakFreezes: 3, cap: 3, count: 1 })).toBeNull();
  });
});
