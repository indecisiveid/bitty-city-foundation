/**
 * Health proof callables.
 *
 *   stopHealthSharing {} → { groups, entries }
 *
 * A member who stops sharing their Health numbers takes back the ones
 * already shared: in every city they belong to, the `health` reading is
 * removed from their entry in today's `proofs_today` and in every
 * `groups/{id}/days/{date}` ledger doc where they checked in with Health.
 * The check-in itself stands — status stays "health", so the day still
 * counts and the crew still sees a checkmark, just no numbers.
 *
 * Idempotent: a second call finds nothing to strip. `groups` is how many of
 * the caller's cities were checked (they're a member of), `entries` how many
 * readings were removed. Mirrors `eraseMemberProofs` in groupHandlers.ts.
 */
import { onCall } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { requireAuth } from "./auth";

const db = () => getFirestore();

const hasSharedReading = (entry: unknown): boolean =>
  !!entry &&
  typeof entry === "object" &&
  (entry as { status?: unknown }).status === "health" &&
  (entry as { health?: unknown }).health !== undefined;

/** Today's bucket — in a transaction, so a racing check-in or rollover can't be clobbered. */
async function stripToday(groupRef: FirebaseFirestore.DocumentReference, uid: string): Promise<{ member: string | null; stripped: number }> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(groupRef);
    if (!snap.exists) return { member: null, stripped: 0 };
    const data = snap.data()!;
    const idx = ((data.member_uids as string[]) ?? []).indexOf(uid);
    if (idx === -1) return { member: null, stripped: 0 };
    const name: string = data.group_members[idx];
    const entry = data.proofs_today?.entries?.[name];
    if (!hasSharedReading(entry)) return { member: name, stripped: 0 };
    // FieldPath, not a dotted string: display names can contain dots.
    tx.update(groupRef, new FieldPath("proofs_today", "entries", name, "health"), FieldValue.delete());
    return { member: name, stripped: 1 };
  });
}

/** Every day-ledger doc where this member checked in with Health. */
async function stripLedger(groupRef: FirebaseFirestore.DocumentReference, name: string): Promise<number> {
  const days = await groupRef
    .collection("days")
    .where(new FieldPath("proofs", name, "status"), "==", "health")
    .get();
  let stripped = 0;
  let batch = db().batch();
  let ops = 0;
  for (const day of days.docs) {
    const proofs = (day.data().proofs ?? {}) as Record<string, unknown>;
    if (!hasSharedReading(proofs[name])) continue;
    batch.update(day.ref, new FieldPath("proofs", name, "health"), FieldValue.delete());
    stripped++;
    if (++ops === 450) {
      await batch.commit();
      batch = db().batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return stripped;
}

export const stopHealthSharing = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const userSnap = await db().collection("users").doc(uid).get();
  const groupIds: string[] = userSnap.data()?.group_ids ?? [];

  let groups = 0;
  let entries = 0;
  for (const groupId of groupIds) {
    const groupRef = db().collection("groups").doc(groupId);
    const { member, stripped } = await stripToday(groupRef, uid);
    if (!member) continue;
    groups++;
    entries += stripped + (await stripLedger(groupRef, member));
  }
  return { groups, entries };
});
