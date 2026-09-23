#!/usr/bin/env node
/**
 * One-off: seed `users/{uid}.last_seen_at` from Firebase Auth.
 *
 * The scheduler treats a MISSING stamp as "unknown, keep reminding" (a user
 * who predates the field must not be farewelled on a guess). That means the
 * per-person tiers do nothing for anyone until they open the app once — which
 * is exactly never, for the dormant users the tiers exist for. Auth's
 * `lastRefreshTime` is the closest thing to "last opened the app" that already
 * exists (the SDK refreshes the ID token whenever the app is used), so it
 * seeds the stamp once, for users who have none.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/bitty-city-deployer.json \
 *     node scripts/backfill-last-seen.mjs           # dry run: prints the plan
 *     node scripts/backfill-last-seen.mjs --apply   # writes
 *
 * Idempotent: a user who already has `last_seen_at` is never touched. Run it
 * from `functions/` so firebase-admin resolves.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "functions", "package.json"));
const admin = require("firebase-admin");

const apply = process.argv.includes("--apply");
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the deployer service-account key.");
  process.exit(2);
}
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "bitty-city" });
const db = admin.firestore();

const authUsers = [];
let pageToken;
do {
  const page = await admin.auth().listUsers(1000, pageToken);
  authUsers.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const profiles = await db.collection("users").get();
const byUid = new Map(profiles.docs.map((d) => [d.id, d.data()]));

let planned = 0;
let skipped = 0;
const batch = db.batch();
for (const u of authUsers) {
  const profile = byUid.get(u.uid);
  if (!profile) continue; // no profile doc → never in a city → never reminded
  if (profile.last_seen_at) {
    skipped++;
    continue;
  }
  const seen = new Date(u.metadata.lastRefreshTime ?? u.metadata.lastSignInTime ?? u.metadata.creationTime);
  if (isNaN(seen.getTime())) continue;
  const idleDays = Math.floor((Date.now() - seen.getTime()) / 86_400_000);
  console.log(`${apply ? "set " : "plan"} ${u.uid}  ${(profile.display_name ?? "").padEnd(22)} last_seen_at=${seen.toISOString()}  (${idleDays}d idle)`);
  batch.set(db.collection("users").doc(u.uid), { last_seen_at: admin.firestore.Timestamp.fromDate(seen) }, { merge: true });
  planned++;
}

if (apply && planned > 0) await batch.commit();
console.log(`${apply ? "wrote" : "would write"} ${planned}, already stamped ${skipped}, auth users ${authUsers.length}`);
if (!apply) console.log("Dry run. Re-run with --apply to write.");
