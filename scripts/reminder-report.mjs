#!/usr/bin/env node
/**
 * Read-only: who is on which reminder tier right now, what they've been sent
 * today, and which slots each city claimed. The post-deploy check for the
 * per-person tiers (and a handy "is anyone being over-pushed?" report).
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/bitty-city-deployer.json \
 *     node scripts/reminder-report.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "functions", "package.json"));
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "bitty-city" });
const db = admin.firestore();

const COOLING = 7, DORMANT = 14;
const now = Date.now();
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const tierFor = (d) => (d === null ? "active(unknown)" : d >= DORMANT ? "dormant" : d >= COOLING ? "cooling" : "active");

const [users, groups] = await Promise.all([db.collection("users").get(), db.collection("groups").get()]);
const nameByUid = new Map(users.docs.map((d) => [d.id, d.data().display_name ?? d.id]));
const citiesOf = new Map();
for (const g of groups.docs) for (const uid of g.data().member_uids ?? []) (citiesOf.get(uid) ?? citiesOf.set(uid, []).get(uid)).push(g.data().group_name);

console.log("USERS (in ≥1 city)");
const rows = [];
for (const d of users.docs) {
  const u = d.data();
  if (!(citiesOf.get(d.id)?.length)) continue;
  const seen = toDate(u.last_seen_at);
  const idle = seen ? Math.floor((now - seen.getTime()) / 86_400_000) : null;
  const r = u.reminders ?? {};
  rows.push({ tier: tierFor(idle), idle, name: nameByUid.get(d.id), tokens: (u.push_tokens ?? []).length, date: r.date ?? "-", sent: r.sent ?? 0, farewell: toDate(r.farewell_sent_at)?.toISOString().slice(0, 16) ?? "-", cities: citiesOf.get(d.id).join(", ") });
}
const order = { dormant: 0, cooling: 1, active: 2, "active(unknown)": 3 };
rows.sort((a, b) => order[a.tier] - order[b.tier] || (b.idle ?? -1) - (a.idle ?? -1));
console.log("tier            idle  tok  sent(date)        farewell          name                   cities");
for (const r of rows) console.log(`${r.tier.padEnd(15)} ${String(r.idle ?? "?").padStart(4)}  ${String(r.tokens).padStart(3)}  ${String(r.sent).padStart(2)} (${r.date.padEnd(10)})  ${r.farewell.padEnd(17)} ${String(r.name).slice(0, 22).padEnd(22)} ${r.cities}`);
const counts = rows.reduce((m, r) => ((m[r.tier] = (m[r.tier] ?? 0) + 1), m), {});
console.log("tiers:", counts);

console.log("\nCITIES — slots claimed");
for (const g of groups.docs) {
  const x = g.data();
  console.log(`${String(x.group_name).slice(0, 22).padEnd(22)} n=${(x.member_uids ?? []).length} tz=${x.goal_reset_timezone} streak=${x.streak ?? 0} sent=${x.reminders_sent_date ?? "-"} ${JSON.stringify(x.reminders_sent_slots ?? [])}`);
}
