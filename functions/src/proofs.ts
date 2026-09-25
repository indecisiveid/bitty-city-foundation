/**
 * Goal-completion proof — pure logic.
 *
 * A proof is what a member attached when they marked today's goal done: a
 * photo (an object in the Storage bucket) or an explicit skip. State lives on
 * the group doc as a single-day bucket, exactly like `kudos.ts`:
 *
 *   proofs_today: { date: "YYYY-MM-DD", entries: { [memberName]: ProofEntry } }
 *
 * and, durably, as `groups/{id}/days/{date}.proofs[memberName]` so a
 * building tapped months later can still say who showed their work.
 *
 * The object key is `proofs/{groupId}/{uid}/{random}.jpg`. storage.rules
 * only let a member create under their own uid; `completeGoal` re-checks the
 * shape and owner here so a caller can't attach someone else's photo.
 */

export type ProofStatus = "photo" | "skipped";

export interface ProofEntry {
  status: ProofStatus;
  /** Storage object key — present iff status === "photo". */
  key?: string;
}

export interface ProofsState {
  date: string; // "YYYY-MM-DD" — the game day this bucket belongs to
  entries: Record<string, ProofEntry>;
}

/** Mirrors `request.resource.size <= 5 * 1024 * 1024` in storage.rules. */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export const PROOFS_PREFIX = "proofs/";

/** Mirrors the `file.matches(...)` clause in storage.rules. */
const FILE_RE = /^[A-Za-z0-9-]{8,64}\.jpg$/;

export function isProofKeyFor(key: unknown, groupId: string, uid: string): key is string {
  if (typeof key !== "string") return false;
  const prefix = `${PROOFS_PREFIX}${groupId}/${uid}/`;
  if (!key.startsWith(prefix)) return false;
  return FILE_RE.test(key.slice(prefix.length));
}

const isEntry = (v: unknown): v is ProofEntry => {
  if (!v || typeof v !== "object") return false;
  const e = v as ProofEntry;
  if (e.status === "skipped") return e.key === undefined;
  if (e.status === "photo") return typeof e.key === "string" && e.key.startsWith(PROOFS_PREFIX);
  return false;
};

/**
 * Coerce whatever is on the doc into a usable bucket for `today`. Anything
 * missing, malformed, or stamped with a different day comes back empty.
 */
export function normalizeProofs(raw: unknown, today: string): ProofsState {
  const candidate = raw as Partial<ProofsState> | null | undefined;
  if (!candidate || candidate.date !== today || !candidate.entries || typeof candidate.entries !== "object") {
    return { date: today, entries: {} };
  }
  const entries: Record<string, ProofEntry> = {};
  for (const [name, entry] of Object.entries(candidate.entries)) {
    if (isEntry(entry)) entries[name] = entry;
  }
  return { date: today, entries };
}

/**
 * Record a member's proof. Idempotent: the first proof of the day wins,
 * which matches `completeGoal` being a no-op on the re-tap.
 */
export function applyProof(
  raw: unknown,
  today: string,
  member: string,
  entry: ProofEntry,
): { state: ProofsState; isNew: boolean } {
  const state = normalizeProofs(raw, today);
  if (state.entries[member]) return { state, isNew: false };
  return { state: { date: today, entries: { ...state.entries, [member]: entry } }, isNew: true };
}

/** How many of `today`'s proofs are photos (skips don't count). */
export function photoCount(raw: unknown, today: string): number {
  return Object.values(normalizeProofs(raw, today).entries).filter((e) => e.status === "photo").length;
}
