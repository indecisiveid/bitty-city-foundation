/**
 * Vacation mode callables — setMemberPause / setCityPause.
 *
 * Server-authoritative like every other write: who may pause whom is decided
 * here (the client only hides what it can't do), every date is validated
 * against the group's OWN game day, and the pending day is settled before a
 * pause is recorded so it can never apply to a day already decided.
 *
 *   setMemberPause { group_id, member_uid?, until | null }
 *     - member_uid omitted → yourself. Anyone may pause themselves.
 *     - another member     → founder only.
 *     - until: "YYYY-MM-DD" starts (or extends) a pause; null ends it as of
 *       today ("I'm back").
 *   setCityPause   { group_id, until | null }   founder only.
 *
 * Both notify the rest of the crew, because a pause moves the bar
 * (see crewMessages).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getProcessingDate } from "./gameLogic";
import { memberNameForUid, maybeProcessDay } from "./groupHandlers";
import {
  MAX_PAUSE_DAYS,
  MemberPauses,
  PauseRange,
  activeMembersOn,
  dayLabel,
  endPauseEarly,
  isPauseActive,
  pauseUntilProblem,
  pruneExpired,
  rosterOf,
} from "./pauses";
import {
  backMessage,
  cityPausedMessage,
  cityResumedMessage,
  onVacationMessage,
} from "./crewMessages";
import { notifyAllMembers } from "./notify";
import { groupToResponse } from "./utils";
import { requireAuth } from "./auth";

const db = () => getFirestore();

/** The failed-precondition detail the app duck-types on. */
export const PAUSED_REASON = { reason: "paused" } as const;

function requireUntil(until: unknown, today: string): string {
  switch (pauseUntilProblem(until, today)) {
    case "malformed":
      throw new HttpsError("invalid-argument", "until must be a YYYY-MM-DD date");
    case "past":
      throw new HttpsError("invalid-argument", "A pause can't end before today");
    case "too_long":
      throw new HttpsError(
        "invalid-argument",
        `A pause can last at most ${MAX_PAUSE_DAYS} days`,
      );
    default:
      return until as string;
  }
}

/**
 * The range to store for a request. Extending an ACTIVE pause keeps its
 * original start — the days already covered must stay covered even when
 * they haven't been processed yet (nobody opened the app during them).
 */
function nextRange(
  existing: PauseRange | null | undefined,
  until: unknown,
  today: string,
  uid: string,
): PauseRange | null {
  if (until === null || until === undefined) return endPauseEarly(existing, today);
  const end = requireUntil(until, today);
  const from = existing && isPauseActive(existing, today) ? existing.from : today;
  return { from, until: end, set_by: uid };
}

async function loadSettled(group_id: string) {
  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Group not found");
  // maybeProcessDay is a no-op when the day is already settled.
  const data = await maybeProcessDay(group_id, snap.data()!);
  const today = getProcessingDate(data.goal_reset_time, data.goal_reset_timezone ?? "UTC");
  return { groupRef, data, today };
}

export const setMemberPause = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, member_uid, until } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");

  const targetUid: string =
    typeof member_uid === "string" && member_uid.trim() ? member_uid : uid;

  const { groupRef, data, today } = await loadSettled(group_id);
  const callerName = memberNameForUid(data, uid);
  if (targetUid !== uid && data.owner_uid !== uid) {
    throw new HttpsError("permission-denied", "Only the founder can pause another member");
  }
  if (!((data.member_uids as string[] | undefined) ?? []).includes(targetUid)) {
    throw new HttpsError("not-found", "That member isn't in this city");
  }
  const targetName = memberNameForUid(data, targetUid);

  const before: MemberPauses = pruneExpired(data.member_pauses, today);
  const wasPaused = isPauseActive(before[targetUid], today);
  const range = nextRange(before[targetUid], until, today, uid);
  const pauses: MemberPauses = { ...before };
  if (range) pauses[targetUid] = range;
  else delete pauses[targetUid];

  await groupRef.update({ member_pauses: pauses });
  const after: FirebaseFirestore.DocumentData = { ...data, member_pauses: pauses };
  const nowPaused = isPauseActive(range, today);
  const activeCount = activeMembersOn(rosterOf(after), today).length;
  const cityName = after.group_name ?? "your city";

  // Tell the rest of the crew the bar moved. The caller already knows; the
  // paused person is told too when the founder did it on their behalf.
  if (nowPaused && (!wasPaused || range?.until !== before[targetUid]?.until)) {
    await notifyAllMembers(
      group_id,
      after,
      onVacationMessage(targetName, cityName, dayLabel(range!.until), activeCount),
      callerName,
    );
  } else if (wasPaused && !nowPaused) {
    await notifyAllMembers(group_id, after, backMessage(targetName, cityName, activeCount), callerName);
  }

  return groupToResponse(group_id, after);
});

export const setCityPause = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, until } = request.data ?? {};
  if (!group_id) throw new HttpsError("invalid-argument", "group_id is required");

  const { groupRef, data, today } = await loadSettled(group_id);
  const callerName = memberNameForUid(data, uid);
  if (data.owner_uid !== uid) {
    throw new HttpsError("permission-denied", "Only the founder can pause the whole city");
  }

  const existing: PauseRange | null = data.city_pause ?? null;
  const wasPaused = isPauseActive(existing, today);
  const range = nextRange(existing, until, today, uid);

  await groupRef.update({ city_pause: range });
  const after: FirebaseFirestore.DocumentData = { ...data, city_pause: range };
  const nowPaused = isPauseActive(range, today);
  const cityName = after.group_name ?? "your city";
  const memberCount = (after.group_members ?? []).length;

  if (nowPaused && (!wasPaused || range?.until !== existing?.until)) {
    await notifyAllMembers(
      group_id,
      after,
      cityPausedMessage(cityName, callerName, dayLabel(range!.until)),
      callerName,
    );
  } else if (wasPaused && !nowPaused) {
    await notifyAllMembers(
      group_id,
      after,
      cityResumedMessage(cityName, callerName, memberCount),
      callerName,
    );
  }

  return groupToResponse(group_id, after);
});
