/**
 * Verifying an App Store purchase: the app sends the StoreKit 2 signed
 * transaction (a JWS); Apple's own library checks its certificate chain up
 * to Apple's root CA (functions/certs), the bundle id and the environment.
 *
 * Production and Sandbox (TestFlight, App Review) are always accepted.
 * Xcode's local StoreKit testing signs with a local certificate that the
 * library does NOT verify — so it is accepted ONLY inside the emulator.
 * Accepting it in production would let anyone mint purchases.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { APP_APPLE_ID, BUNDLE_ID, VerifiedTransaction } from "./store";

let roots: Buffer[] | null = null;
function appleRoots(): Buffer[] {
  if (!roots) {
    const dir = join(__dirname, "..", "certs");
    roots = ["AppleRootCA-G3.cer", "AppleRootCA-G2.cer"].map((f) => readFileSync(join(dir, f)));
  }
  return roots;
}

export function inEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

const verifiers = new Map<Environment, SignedDataVerifier>();
function verifierFor(env: Environment): SignedDataVerifier {
  let v = verifiers.get(env);
  if (!v) {
    v = new SignedDataVerifier(
      appleRoots(),
      env !== Environment.XCODE, // online revocation checks for real App Store data
      env,
      BUNDLE_ID,
      env === Environment.PRODUCTION ? APP_APPLE_ID : undefined,
    );
    verifiers.set(env, v);
  }
  return v;
}

/** The environments this deployment accepts, in the order they're tried. */
export function acceptedEnvironments(emulator = inEmulator()): Environment[] {
  const envs = [Environment.PRODUCTION, Environment.SANDBOX];
  if (emulator) envs.push(Environment.XCODE);
  return envs;
}

/**
 * Verify and decode a signed transaction, or null when no accepted
 * environment vouches for it.
 */
export async function verifySignedTransaction(jws: string): Promise<VerifiedTransaction | null> {
  for (const env of acceptedEnvironments()) {
    try {
      const t = await verifierFor(env).verifyAndDecodeTransaction(jws);
      return { ...t, environment: String(t.environment ?? env) } as VerifiedTransaction;
    } catch {
      // Wrong environment or bad signature — try the next one.
    }
  }
  return null;
}
