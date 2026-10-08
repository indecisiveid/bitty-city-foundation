/**
 * Goal-completion proof — pure logic.
 *
 * A proof is what a member attached when they marked today's goal done: a
 * photo (an object in the Storage bucket), a Health reading (Apple Health
 * counted the goal — see healthGoal.ts), or an explicit skip. State lives on
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
 *
 * One photo checked into several cities at once (`completeGoals`, the Home
 * screen's "Today's goals") is ONE object at `proofs/shared/{uid}/{random}.jpg`.
 * Only its owner can read it through the rules — crewmates in every city load
 * it from the entry's `url` (a Firebase download URL the server stamps on the
 * entry), and the object's `cities` metadata lists who still references it so
 * deleting one city never takes the photo from another.
 */

import {
  HealthGoal,
  HealthMetric,
  METRIC_BOUNDS,
  effectiveHealthGoal,
  isActivity,
  isHealthMetric,
  isIntIn,
} from "./healthGoal";

export type ProofStatus = "photo" | "health" | "skipped";

export interface HealthReading {
  metric: HealthMetric;
  /** Integer; for "workout" it is minutes. */
  value: number;
  /** The CITY's target — set by the server, never taken from the client. */
  target: number;
  /** 0..3 names of where the data came from, e.g. ["Apple Watch"], ["Strava"]. */
  sources: string[];
  workout?: { activity: string; minutes: number; km?: number };
}

export interface ProofEntry {
  status: ProofStatus;
  /** Storage object key — present iff status === "photo". */
  key?: string;
  /** Download URL for a photo, stamped by the server so viewers skip the
   *  getDownloadURL round-trip. The only way crewmates can load a shared
   *  (multi-city) photo. Absent on entries written before 2026-10. */
  url?: string;
  /** Only for status "health" when the member shares numbers with the crew. */
  health?: HealthReading;
  /** A health check-in the app made automatically. */
  auto?: true;
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

/** Where one photo checked into several cities lives. Group ids are 20-char
 *  Firestore auto ids, so "shared" can never be one. */
export const SHARED_PROOFS_PREFIX = `${PROOFS_PREFIX}shared/`;

export function isSharedProofKeyFor(key: unknown, uid: string): key is string {
  if (typeof key !== "string") return false;
  const prefix = `${SHARED_PROOFS_PREFIX}${uid}/`;
  if (!key.startsWith(prefix)) return false;
  return FILE_RE.test(key.slice(prefix.length));
}

export function isSharedProofKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(SHARED_PROOFS_PREFIX);
}

/** Most cities one `completeGoals` call checks into — the per-account cap. */
export const MAX_BATCH_CITIES = 100;

/**
 * `completeGoals`' `group_ids`: a non-empty list of distinct non-empty
 * strings, at most MAX_BATCH_CITIES. Duplicates are dropped, order kept.
 * Null when the argument can't be used.
 */
export function parseGroupIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128 && !id.includes("/"))) return null;
  const ids = [...new Set(raw as string[])];
  return ids.length <= MAX_BATCH_CITIES ? ids : null;
}

/** The `cities` metadata on a shared photo: comma-joined group ids. */
export function parseCities(raw: unknown): string[] {
  return typeof raw === "string" ? raw.split(",").filter(Boolean) : [];
}

export const MAX_HEALTH_SOURCES = 3;
export const MAX_SOURCE_LENGTH = 40;
export const MAX_WORKOUT_MINUTES = 1440;
export const MAX_WORKOUT_KM = 500;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isSources = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= MAX_HEALTH_SOURCES &&
  v.every((s) => typeof s === "string" && s.length >= 1 && s.length <= MAX_SOURCE_LENGTH);

/** 0..500 km, at most two decimals. */
const isKm = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= MAX_WORKOUT_KM &&
  Math.round(v * 100) / 100 === v;

const isWorkout = (v: unknown): v is NonNullable<HealthReading["workout"]> =>
  isPlainObject(v) &&
  isActivity(v.activity) &&
  isIntIn(v.minutes, 1, MAX_WORKOUT_MINUTES) &&
  (v.km === undefined || isKm(v.km));

/**
 * The reading's shape, ignoring the city: known metric, integer value within
 * the metric's bounds, sane sources and workout. `target` must be a valid
 * target for the metric (on a stored entry it is the city's).
 */
export function isHealthReading(v: unknown): v is HealthReading {
  if (!isPlainObject(v)) return false;
  if (!isHealthMetric(v.metric)) return false;
  const max = METRIC_BOUNDS[v.metric];
  if (!isIntIn(v.value, 0, max)) return false;
  if (!isIntIn(v.target, 1, max)) return false;
  if (!isSources(v.sources)) return false;
  if (v.workout !== undefined && !isWorkout(v.workout)) return false;
  return true;
}

const isEntry = (v: unknown): v is ProofEntry => {
  if (!v || typeof v !== "object") return false;
  const e = v as ProofEntry;
  if (e.status === "skipped") return e.key === undefined;
  if (e.status === "photo") {
    return typeof e.key === "string" && e.key.startsWith(PROOFS_PREFIX) && (e.url === undefined || typeof e.url === "string");
  }
  if (e.status === "health") {
    return (
      e.key === undefined &&
      (e.health === undefined || isHealthReading(e.health)) &&
      (e.auto === undefined || e.auto === true)
    );
  }
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

/**
 * How many of `today`'s proofs the crew can actually look at: photos, plus
 * Health check-ins that shared their numbers. A Health check-in kept private
 * is just a checkmark.
 */
export function sharedProofCount(raw: unknown, today: string): number {
  return Object.values(normalizeProofs(raw, today).entries).filter(
    (e) => e.status === "photo" || (e.status === "health" && e.health !== undefined),
  ).length;
}

// --- Health check-ins -------------------------------------------------------

/**
 * `completeGoal`'s `proof` for a Health check-in:
 *   { health: { metric, value, target, sources, workout? }, share: boolean, auto?: boolean }
 */
export interface HealthProofArg {
  health: unknown;
  share?: unknown;
  auto?: unknown;
}

export function isHealthProofArg(raw: unknown): raw is HealthProofArg {
  return isPlainObject(raw) && raw.health !== undefined;
}

export type HealthProofResult =
  | { ok: true; entry: ProofEntry; goal: HealthGoal }
  | { ok: false; code: "failed-precondition" | "invalid-argument"; message: string };

export const NOT_A_HEALTH_CITY = "This city's goal isn't counted with Apple Health";
export const NOT_THERE_YET = "Not there yet — keep going, or check in with a photo";

/**
 * Judge a Health check-in against the city. PURE — the caller turns a
 * refusal into an HttpsError. The client's `target` is ignored: the city's
 * effective goal sets the bar and is what gets stored. Numbers are stored
 * only when `share === true` (anything else keeps them private), and `auto`
 * only when it is exactly `true`.
 */
export function resolveHealthProof(
  raw: HealthProofArg,
  group: { health_goal?: unknown; daily_goal?: unknown },
): HealthProofResult {
  const goal = effectiveHealthGoal(group);
  if (!goal) return { ok: false, code: "failed-precondition", message: NOT_A_HEALTH_CITY };

  const h = raw.health;
  if (!isPlainObject(h)) return { ok: false, code: "invalid-argument", message: "proof.health must be an object" };
  if (h.metric !== goal.metric) {
    return { ok: false, code: "invalid-argument", message: "proof.health.metric doesn't match this city's goal" };
  }
  if (!isIntIn(h.value, 0, METRIC_BOUNDS[goal.metric])) {
    return { ok: false, code: "invalid-argument", message: "proof.health.value is out of range" };
  }
  if (!isSources(h.sources)) {
    return { ok: false, code: "invalid-argument", message: "proof.health.sources is malformed" };
  }
  if (h.workout !== undefined && !isWorkout(h.workout)) {
    return { ok: false, code: "invalid-argument", message: "proof.health.workout is malformed" };
  }
  if (h.value < goal.target) return { ok: false, code: "failed-precondition", message: NOT_THERE_YET };

  const entry: ProofEntry = { status: "health" };
  if (raw.share === true) {
    const reading: HealthReading = {
      metric: goal.metric,
      value: h.value,
      target: goal.target,
      sources: [...(h.sources as string[])],
    };
    if (h.workout !== undefined) {
      const w = h.workout as NonNullable<HealthReading["workout"]>;
      reading.workout = w.km !== undefined
        ? { activity: w.activity, minutes: w.minutes, km: w.km }
        : { activity: w.activity, minutes: w.minutes };
    }
    entry.health = reading;
  }
  if (raw.auto === true) entry.auto = true;
  return { ok: true, entry, goal };
}
