/**
 * The one rule that keeps purchases honest: Xcode's local StoreKit testing
 * is not signed by Apple, and Apple's library does not check it — so it is
 * accepted in the emulator and nowhere else. A forged "Xcode" transaction
 * sent to production must fail verification.
 */
import { Environment } from "@apple/app-store-server-library";
import { acceptedEnvironments, verifySignedTransaction } from "../storeVerify";
import { accountTokenFor, BUNDLE_ID } from "../store";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function forgedXcodeJws(): string {
  const now = Date.now();
  return [
    b64({ alg: "ES256", x5c: ["AAAA"] }),
    b64({
      transactionId: "0",
      originalTransactionId: "0",
      bundleId: BUNDLE_ID,
      productId: "com.sidejawn.bittycity.hardhats.3",
      type: "Consumable",
      purchaseDate: now,
      signedDate: now,
      quantity: 1,
      appAccountToken: accountTokenFor("u1"),
      environment: "Xcode",
      inAppOwnershipType: "PURCHASED",
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

describe("storeVerify", () => {
  const saved = process.env.FUNCTIONS_EMULATOR;
  afterEach(() => {
    if (saved === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = saved;
  });

  it("production accepts the App Store and its sandbox, never Xcode", () => {
    expect(acceptedEnvironments(false)).toEqual([Environment.PRODUCTION, Environment.SANDBOX]);
    expect(acceptedEnvironments(true)).toContain(Environment.XCODE);
  });

  it("a forged local-test transaction is refused outside the emulator", async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    expect(await verifySignedTransaction(forgedXcodeJws())).toBeNull();
  });

  it("…and decoded inside it, so the smoke can buy packs", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    const t = await verifySignedTransaction(forgedXcodeJws());
    expect(t).toMatchObject({ productId: "com.sidejawn.bittycity.hardhats.3", environment: "Xcode" });
  });
});
