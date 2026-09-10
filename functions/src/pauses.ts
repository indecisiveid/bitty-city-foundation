/**
 * Vacation mode — PURE helpers, jest-tested, mirrored in
 * `../../bitty-city/mobile/src/utils/pauses.ts` (parity-tested there). Change
 * both sides together.
 *
 * Two kinds of pause, both inclusive ranges of game days ("YYYY-MM-DD" in the
 * group's reset timezone):
 *
 *   - a MEMBER pause: that person drops out of the roster for those days. The
 *     bar for "everyone's in" is the ACTIVE members only, so the build keeps
 *     going without them.
 *   - a CITY pause: those days are neither won nor lost. Nothing advances,
 *     nothing stalls, nothing falls, and the streak carries across the gap.
 *
 * A day on which EVERY member is paused behaves like a city pause — the one
 * rule that makes "pause myself" safe in a crew of one or two.
 *
 * Member pauses are keyed by uid, not display name, so a rename can't orphan
 * one. Game logic works in names, which is why the roster helpers take both
 * index-aligned arrays.
 */

/** Longest single pause. Longer than this means leave (or delete) the city. */
export const MAX_PAUSE_DAYS = 30;

export interface PauseRange {
  /** First paused game day, inclusive. */
  from: string;
  /** Last paused game day, inclusive. */
  until: string;
  /** uid that set it — the founder can pause a member, so this isn't
   *  necessarily the paused person. */
  set_by?: string;
}

/** uid → range. Absent / null on docs that predate the feature. */
export type MemberPauses = Record<string, PauseRange>;

export interface Roster {
  /** Display names, index-aligned with `memberUids`. */
  members: string[];
  memberUids: string[];
  memberPauses?: MemberPauses | null;
  cityPause?: PauseRange | null;
}

// "YYYY-MM-DD" ↔ days-since-epoch, integer math so no timezone drift.
function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function formatYmd(dayNum: number): string {
  return new Date(dayNum * 86400000).toISOString().slice(0, 10);
}

export function addDays(ymd: string, n: number): string {
  return formatYmd(parseYmd(ymd) + n);
}

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(parseYmd(value));
}

/** Is this range in effect on `date`? Inclusive at both ends. */
export function isPauseActive(
  pause: PauseRange | null | undefined,
  date: string,
): boolean {
  if (!pause) return false;
  // ISO dates sort lexically, so plain string comparison is exact.
  return pause.from <= date && date <= pause.until;
}

/** Display names of the members on vacation on `date`. */
export function pausedMembersOn(roster: Roster, date: string): string[] {
  const pauses = roster.memberPauses ?? {};
  const out: string[] = [];
  roster.members.forEach((name, i) => {
    const uid = roster.memberUids[i];
    if (uid && isPauseActive(pauses[uid], date)) out.push(name);
  });
  return out;
}

/** The complement: who has to complete the goal on `date`. */
export function activeMembersOn(roster: Roster, date: string): string[] {
  const paused = new Set(pausedMembersOn(roster, date));
  return roster.members.filter((m) => !paused.has(m));
}

/**
 * Is `date` a paused day for the whole city — an explicit city pause, or
 * every member away at once? An empty crew is NOT paused (nothing to pause).
 */
export function isDayPaused(roster: Roster, date: string): boolean {
  if (isPauseActive(roster.cityPause, date)) return true;
  if (roster.members.length === 0) return false;
  return activeMembersOn(roster, date).length === 0;
}

/**
 * Every game day the streak may bridge over: spent freezes AND paused days.
 * Frozen first, then any paused day not already there — order only matters
 * for stable output.
 */
export function bridgeDates(
  frozen: string[] | null | undefined,
  paused: string[] | null | undefined,
): string[] {
  const out = [...(frozen ?? [])];
  const seen = new Set(out);
  for (const d of paused ?? []) {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/**
 * "I'm back" / "Resume": end a pause as of `today`. Keeps the days it already
 * covered by pulling `until` back to yesterday; a pause that never reached a
 * day yet (starts today or later) is simply dropped. Returns what to store.
 */
export function endPauseEarly(
  pause: PauseRange | null | undefined,
  today: string,
): PauseRange | null {
  if (!pause) return null;
  if (pause.from >= today) return null;
  const yesterday = addDays(today, -1);
  return pause.until <= yesterday ? pause : { ...pause, until: yesterday };
}

/** Drop member pauses that have already run out — keeps the doc tidy. */
export function pruneExpired(
  pauses: MemberPauses | null | undefined,
  today: string,
): MemberPauses {
  const out: MemberPauses = {};
  for (const [uid, p] of Object.entries(pauses ?? {})) {
    if (p && p.until >= today) out[uid] = p;
  }
  return out;
}

export type PauseUntilProblem = "malformed" | "past" | "too_long";

/**
 * Validate a requested end date for a pause starting `today`. A pause is at
 * most MAX_PAUSE_DAYS long INCLUDING today, so `today + MAX_PAUSE_DAYS - 1`
 * is the latest allowed `until`.
 */
export function pauseUntilProblem(until: unknown, today: string): PauseUntilProblem | null {
  if (!isYmd(until)) return "malformed";
  if (until < today) return "past";
  if (parseYmd(until) - parseYmd(today) > MAX_PAUSE_DAYS - 1) return "too_long";
  return null;
}

/** The latest `until` a pause starting `today` may have. */
export function maxPauseUntil(today: string): string {
  return addDays(today, MAX_PAUSE_DAYS - 1);
}

/**
 * Every game day up to and including `through` on which the city was paused
 * (`isDayPaused`), derived from the ranges themselves. Day processing is
 * lazy and can settle a two-week absence in one pass, so the settling pass
 * needs the WHOLE run of paused days in the gap, not just the day it's
 * processing — otherwise a ten-day city pause nobody opened the app during
 * would burn freezes or break the streak on day eleven.
 *
 * Only the ranges' own spans are scanned, so the cost is bounded by pause
 * length, never by how long the city has existed.
 */
export function pausedDaysThrough(roster: Roster, through: string): string[] {
  const ranges: PauseRange[] = [];
  if (roster.cityPause) ranges.push(roster.cityPause);
  for (const p of Object.values(roster.memberPauses ?? {})) if (p) ranges.push(p);
  if (ranges.length === 0) return [];

  const throughNum = parseYmd(through);
  const start = Math.min(...ranges.map((r) => parseYmd(r.from)));
  const end = Math.min(throughNum, Math.max(...ranges.map((r) => parseYmd(r.until))));
  const out: string[] = [];
  for (let d = start; d <= end; d++) {
    const ds = formatYmd(d);
    if (isDayPaused(roster, ds)) out.push(ds);
  }
  return out;
}

/** Build a Roster straight off a group document (or a response shape). */
export function rosterOf(data: {
  group_members?: string[] | null;
  member_uids?: string[] | null;
  member_pauses?: MemberPauses | null;
  city_pause?: PauseRange | null;
}): Roster {
  return {
    members: data.group_members ?? [],
    memberUids: data.member_uids ?? [],
    memberPauses: data.member_pauses ?? null,
    cityPause: data.city_pause ?? null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-12" → "Sep 12" — the way a pause's end reads in copy. */
export function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${d}`;
}
