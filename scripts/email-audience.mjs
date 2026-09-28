#!/usr/bin/env node
/**
 * Read-only: who has asked for product-update email, as a CSV to import into
 * the mailing tool. Only people with an explicit, recorded yes
 * (`users/{uid}.email_updates.enabled === true`, see functions/src/preferences.ts)
 * are listed — everyone else is counted, never exported.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/bitty-city-deployer.json \
 *     node scripts/email-audience.mjs [out.csv]
 *
 * Without a path it prints counts only. Hide My Email addresses
 * (@privaterelay.appleid.com) are marked: they deliver ONLY from a sender
 * registered in Apple Developer → Sign in with Apple for Email Communication.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "functions", "package.json"));
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "bitty-city" });

const out = process.argv[2] ?? null;
const users = await admin.firestore().collection("users").get();

const rows = [];
let optedOut = 0, neverAsked = 0, noEmail = 0;
for (const doc of users.docs) {
  const pref = doc.data().email_updates;
  if (!pref) { neverAsked++; continue; }
  if (pref.enabled !== true) { optedOut++; continue; }
  const auth = await admin.auth().getUser(doc.id).catch(() => null);
  if (!auth?.email) { noEmail++; continue; }
  rows.push({
    email: auth.email,
    first_name: doc.data().display_name ?? "",
    relay: auth.email.endsWith("@privaterelay.appleid.com"),
    opted_in_at: pref.at ?? "",
    source: pref.source ?? "",
  });
}

console.log(`opted in: ${rows.length} (${rows.filter((r) => r.relay).length} Hide My Email)`);
console.log(`opted out: ${optedOut} · never asked: ${neverAsked} · opted in but no email on the account: ${noEmail}`);

if (out) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = ["email,first_name,hide_my_email,opted_in_at,source", ...rows.map((r) => [r.email, r.first_name, r.relay, r.opted_in_at, r.source].map(esc).join(","))].join("\n");
  writeFileSync(out, csv + "\n");
  console.log(`wrote ${out}`);
}
