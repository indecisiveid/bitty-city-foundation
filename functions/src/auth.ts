import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";

// Comma-separated list of emails allowed to call the demo/dev callables in
// any environment (they stay deployed in prod but are dev-gated, spec §4.3).
// Override via functions config: DEMO_ALLOWLIST env/param.
export const demoAllowlist = defineString("DEMO_ALLOWLIST", {
  default: "iosif.christian@sidejawn.io,iosif.christian@gmail.com,ccrimi75@gmail.com",
});

/**
 * Every game callable requires a signed-in user (anonymous auth was removed
 * with the accounts launch). Returns the caller's uid.
 */
export function requireAuth(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  return uid;
}

/**
 * Demo callables additionally require the caller's email to be on the
 * allowlist. AppCheck alone isn't enough — any legit app install passes it.
 */
export function requireDemoAccess(request: CallableRequest): void {
  requireAuth(request);
  const email = request.auth?.token?.email?.toLowerCase();
  const allowed = demoAllowlist
    .value()
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allowed.includes(email)) {
    throw new HttpsError(
      "permission-denied",
      "Demo tools are restricted to developer accounts.",
    );
  }
}
