/**
 * App Store packs: what each product grants, the account binding, and how a
 * verified purchase lands in the buyer's inventory — once.
 */
import {
  STORE_PRODUCTS,
  accountTokenFor,
  applyPurchase,
  grantFor,
  hatTransferQuote,
  refuseTransaction,
  BUNDLE_ID,
  STORE_LEDGER_MAX,
} from "../store";

const UID = "NnkQBaOtdJRtvNT7TGVNwGJZvIw2";
const txn = (over: Record<string, unknown> = {}) => ({
  transactionId: "2000000123",
  productId: "com.sidejawn.bittycity.hardhats.3",
  bundleId: BUNDLE_ID,
  appAccountToken: accountTokenFor(UID),
  type: "Consumable",
  environment: "Sandbox",
  ...over,
});

describe("catalog", () => {
  it("every product grants hard hats or bricks, never both, never zero", () => {
    for (const [id, g] of Object.entries(STORE_PRODUCTS)) {
      expect(id.startsWith(`${BUNDLE_ID}.`)).toBe(true);
      const kinds = [g.hard_hats, g.bricks].filter((n) => (n ?? 0) > 0);
      expect(kinds).toHaveLength(1);
    }
    expect(grantFor("com.other.app.coins")).toBeNull();
    expect(grantFor(undefined)).toBeNull();
  });
});

describe("accountTokenFor", () => {
  it("is a stable UUID per account", () => {
    expect(accountTokenFor(UID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(accountTokenFor(UID)).toBe(accountTokenFor(UID));
    expect(accountTokenFor("someone-else")).not.toBe(accountTokenFor(UID));
  });
  it("matches the app's value (mobile/src/store/__tests__/accountToken.test.ts pins the same pair)", () => {
    expect(accountTokenFor("parity-uid-1")).toBe("fd8f21bd-9b76-5874-b9a7-0ed535f85db7");
  });
});

describe("refuseTransaction", () => {
  it("accepts this app's consumable, bought by this account", () => {
    expect(refuseTransaction(txn(), UID)).toBeNull();
    expect(refuseTransaction(txn({ appAccountToken: accountTokenFor(UID).toUpperCase() }), UID)).toBeNull();
  });
  it("refuses another account's purchase — e.g. an unfinished one on a shared phone", () => {
    expect(refuseTransaction(txn(), "someone-else")).toBe("wrong_account");
    expect(refuseTransaction(txn({ appAccountToken: undefined }), UID)).toBe("wrong_account");
  });
  it("refuses other apps, unknown products, non-consumables, refunds, and a missing id", () => {
    expect(refuseTransaction(txn({ bundleId: "com.other.app" }), UID)).toBe("wrong_app");
    expect(refuseTransaction(txn({ productId: "com.sidejawn.bittycity.gold" }), UID)).toBe("unknown_product");
    expect(refuseTransaction(txn({ type: "Non-Consumable" }), UID)).toBe("not_consumable");
    expect(refuseTransaction(txn({ revocationDate: 1700000000000 }), UID)).toBe("revoked");
    expect(refuseTransaction(txn({ transactionId: undefined }), UID)).toBe("no_transaction");
  });
});

describe("applyPurchase", () => {
  const AT = "2026-09-24T12:00:00.000Z";
  it("adds a hard-hat pack to the inventory", () => {
    const out = applyPurchase({ hard_hats: 1, bricks: 30 }, { transactionId: "t1", productId: "com.sidejawn.bittycity.hardhats.3" }, AT)!;
    expect(out.hard_hats).toBe(4);
    expect(out.bricks).toBe(30);
    expect(out.brick_ledger).toBeUndefined();
    expect(out.store_ledger).toEqual([
      expect.objectContaining({ transaction_id: "t1", grant: { hard_hats: 3 }, environment: "Production" }),
    ]);
  });
  it("adds a brick pack through the brick ledger", () => {
    const out = applyPurchase(null, { transactionId: "t2", productId: "com.sidejawn.bittycity.bricks.medium", environment: "Sandbox" }, AT)!;
    expect(out.bricks).toBe(400);
    expect(out.hard_hats).toBe(0);
    expect(out.brick_ledger).toEqual([expect.objectContaining({ event_id: "purchase-t2", amount: 400, reason: "purchase" })]);
  });
  it("credits a transaction once", () => {
    const first = applyPurchase(null, { transactionId: "t3", productId: "com.sidejawn.bittycity.hardhats.1" }, AT)!;
    expect(applyPurchase(first, { transactionId: "t3", productId: "com.sidejawn.bittycity.hardhats.1" }, AT)).toBeNull();
  });
  it("keeps the ledger bounded", () => {
    let inv: any = null;
    for (let i = 0; i < STORE_LEDGER_MAX + 5; i++) {
      inv = { ...inv, ...applyPurchase(inv, { transactionId: `t${i}`, productId: "com.sidejawn.bittycity.hardhats.1" }, AT) };
    }
    expect(inv.store_ledger).toHaveLength(STORE_LEDGER_MAX);
    expect(inv.hard_hats).toBe(STORE_LEDGER_MAX + 5);
  });
});

describe("hatTransferQuote", () => {
  it("moves what you have, up to the city's empty slots", () => {
    expect(hatTransferQuote({ held: 5, streakFreezes: 1, cap: 3, count: 3 })).toBe(2);
    expect(hatTransferQuote({ held: 1, streakFreezes: 0, cap: 3, count: 3 })).toBe(1);
    expect(hatTransferQuote({ held: 5, streakFreezes: 0, cap: 3, count: 1 })).toBe(1);
  });
  it("nothing to move when you have none or the city is full", () => {
    expect(hatTransferQuote({ held: 0, streakFreezes: 0, cap: 3, count: 1 })).toBeNull();
    expect(hatTransferQuote({ held: 4, streakFreezes: 3, cap: 3, count: 1 })).toBeNull();
  });
});
