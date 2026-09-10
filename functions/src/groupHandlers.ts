import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";
import { normalizeParks } from "./parks";
import {
  needsDayProcessing,
  getProcessingDate,
  processEndOfDay,
  applyStreakRepair,
  applyBuildRescue,
  isFirstDayGrace,
  findEmptyTiles,
  landBuild,
  STARTING_FREEZES,
  rowMajorBuildOrder,
} from "./gameLogic";
import {
  generateGroupCode,
  groupToResponse,
  requireTrimmed,
  requireResetTime,
  EMPTY_CITY,
  MAX_MEMBERS_PER_GROUP,
  MAX_GROUPS_PER_USER,
} from "./utils";
import { requireAuth } from "./auth";
import { notifyMembers, notifyAllMembers } from "./notify";
import { joinedMessage, leftMessage } from "./crewMessages";
import { activeMembersOn, isDayPaused, pausedMembersOn, rosterOf, MemberPauses } from "./pauses";
import { NotificationCategory } from "./push";
import { buildProgressOf, withArticle } from "./buildings";
import { isBuildable, buildableIds, daysFor, labelFor } from "./buildCatalog";
import { isProofKeyFor, applyProof, ProofEntry, MAX_PROOF_BYTES } from "./proofs";
import {
  GameMode,
  LEGACY_GAME_MODE,
  ModeSuggestion,
  NEAR_MISS_WINDOW_DAYS,
  dayShare,
  isBuildFinished,
  isGameMode,
  normalizeGameMode,
  recentNearMisses,
  shouldSuggestEasyMode,
  snapProgress,
} from "./gameMode";
import { easyModeSuggestionMessage } from "./crewMessages";
import { proofsBucket, proofObjectSize, deleteProofObject } from "./proofStorage";

const db = () => getFirestore();

/** A member's pause leaves with them. */
function withoutPause(pauses: MemberPauses | null | undefined, uid: string): MemberPauses {
  const out = { ...(pauses ?? {}) };
  delete out[uid];
  return out;
}

/**
 * Resolve the caller's display name inside a group. Membership is
 * uid-based (`member_uids`, index-aligned with the display names in
 * `group_members`); the name remains the currency of the game state
 * (completions_today etc.) so the UI stays name-driven.
 */
export function memberNameForUid(
  data: FirebaseFirestore.DocumentData,
  uid: string,
): string {
  const uids: string[] = data.member_uids ?? [];
  const idx = uids.indexOf(uid);
  if (idx === -1) {
    throw new HttpsError("failed-precondition", "Not a member of this group");
  }
  return data.group_members[idx];
}

/**
 * `completeGoal` proof argument. Absent (old binaries) or `{skipped:true}`
 * → "skipped". `{key}` → must be under this caller's own slot in this group,
 * and the object must already be in the bucket and within the size cap.
 */
async function resolveProof(raw: unknown, groupId: string, uid: string): Promise<ProofEntry> {
  const proof = raw as { key?: unknown; skipped?: unknown } | undefined;
  if (!proof || proof.skipped === true) return { status: "skipped" };
  if (!isProofKeyFor(proof.key, groupId, uid)) {
    throw new HttpsError("invalid-argument", "proof.key is not one of your uploads for this group");
  }
  const bucket = proofsBucket.value();
  const size = await proofObjectSize(proof.key, bucket);
  if (size == null) {
    throw new HttpsError("failed-precondition", "Photo upload didn't finish — try again or skip");
  }
  if (size > MAX_PROOF_BYTES) {
    await deleteProofObject(proof.key, bucket);
    throw new HttpsError("failed-precondition", "Photo is too large — try again or skip");
  }
  return { status: "photo", key: proof.key };
}

function createdAtIso(data: FirebaseFirestore.DocumentData): string | null {
  return data.created_at?.toDate?.()?.toISOString?.() ?? null;
}

/** Legacy groups predate last_activity_date — fall back to creation day. */
function lastActivityFallback(
  data: FirebaseFirestore.DocumentData,
  tz: string,
): string | null {
  if (data.last_activity_date) return data.last_activity_date;
  const iso = createdAtIso(data);
  if (!iso) return null;
  const dt = DateTime.fromISO(iso).setZone(tz);
  return dt.isValid ? dt.toISODate() : iso.slice(0, 10);
}

/**
 * Stamp the city's plan anchor exactly once.
 *
 * Compact block growth replaced a rule that grew the city as eight rays, and
 * block positions are DERIVED from index — so switching rules would relocate
 * buildings that are already standing. This records how many buildings existed
 * at the moment of the switch; the client keeps every block up to that point
 * exactly where it was and only places new ones by the new rule.
 *
 * Written once and never again. A city founded after this ships gets 0 at
 * creation, so it is compact from its first procedural block.
 */
async function ensurePlanAnchor(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
): Promise<FirebaseFirestore.DocumentData> {
  const updates = planAnchorUpdates(data);
  if (!updates) return data;
  await db().collection("groups").doc(groupId).update(updates);
  return { ...data, ...updates };
}

/**
 * Anchor version. Bumped once, on 2026-09-09: the app had never actually read
 * `plan_frozen_at_buildings` (its snapshot mapper dropped the field), so every
 * city — including ones stamped 0 at creation — has only ever rendered with
 * the legacy ray plan. The first client that DOES read the anchor would have
 * relocated everything built after the original stamp. Re-stamping every city
 * at its current size before that client ships keeps every standing building
 * where it is; only blocks built from here on grow compactly.
 */
export const PLAN_ANCHOR_VERSION = 2;

/**
 * What `ensurePlanAnchor` should write for this doc, or null if nothing.
 * Pure, so the re-stamp rule is unit-testable.
 *
 * The anchor is in SLOT units — every built cell, levelled lots included —
 * because that is the count the client feeds `blocksVisibleCount` when it
 * decides how many blocks stay legacy. Counting only standing buildings
 * would run one block short on any city with rubble, and that block would
 * move.
 */
export function planAnchorUpdates(
  data: FirebaseFirestore.DocumentData,
): { plan_frozen_at_buildings: number; plan_anchor_version: number } | null {
  if (
    typeof data.plan_frozen_at_buildings === "number" &&
    data.plan_anchor_version === PLAN_ANCHOR_VERSION
  ) {
    return null;
  }
  const slots: string[] = Array.isArray(data.build_order)
    ? data.build_order
    : rowMajorBuildOrder(data.city_map ?? {});
  return {
    plan_frozen_at_buildings: slots.length,
    plan_anchor_version: PLAN_ANCHOR_VERSION,
  };
}

/**
 * Stamp `build_order` onto a doc written before it existed. Row-major is the
 * order those cities already rendered in, so this moves nothing on screen —
 * it only stops the NEXT landing from moving everything. Runs from every
 * day-processing entry point (every callable the app nudges), so one open
 * of the app is enough.
 */
async function ensureBuildOrder(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
): Promise<FirebaseFirestore.DocumentData> {
  if (Array.isArray(data.build_order)) return data;
  const order = rowMajorBuildOrder(data.city_map ?? {});
  await db().collection("groups").doc(groupId).update({ build_order: order });
  return { ...data, build_order: order };
}

export async function maybeProcessDay(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
): Promise<FirebaseFirestore.DocumentData> {
  data = await ensureBuildOrder(groupId, data);
  data = await ensurePlanAnchor(groupId, data);
  const goalResetTimezone: string = data.goal_reset_timezone ?? "UTC";
  if (!needsDayProcessing(data.goal_reset_time, data.last_processed_date, goalResetTimezone)) {
    return data;
  }

  const processingDate = getProcessingDate(data.goal_reset_time, goalResetTimezone);
  const createdIso = createdAtIso(data);
  const updates = processEndOfDay({
    groupMembers: data.group_members,
    completionsToday: data.completions_today,
    currentBuild: data.current_build ?? null,
    abandonedBuild: data.abandoned_build ?? null,
    cityMap: data.city_map,
    parks: normalizeParks(data.parks),
    streak: data.streak,
    buildingCompletions: data.building_completions ?? [],
    processingDate,
    lastActivityDate: lastActivityFallback(data, goalResetTimezone),
    streakFreezes: data.streak_freezes ?? 0,
    frozenDates: data.frozen_dates ?? [],
    brokenStreak: data.broken_streak ?? null,
    lastInactivityMeteorDate: data.last_inactivity_meteor_date ?? null,
    isGraceDay: createdIso
      ? isFirstDayGrace(createdIso, processingDate, data.goal_reset_time, goalResetTimezone)
      : false,
    tileBuildDates: data.tile_build_dates ?? {},
    rubbleOrigins: data.rubble_origins ?? {},
    buildOrder: data.build_order ?? null,
    memberUids: data.member_uids ?? [],
    memberPauses: data.member_pauses ?? null,
    cityPause: data.city_pause ?? null,
    pausedDates: data.paused_dates ?? [],
    gameMode: normalizeGameMode(data.game_mode),
    nearMissDates: data.near_miss_dates ?? [],
  });

  const writeUpdates: Record<string, unknown> = {
    ...updates,
    last_processed_date: processingDate,
    // Kudos are a today-only thing: the day rolled over, so yesterday's
    // hearts go with `completions_today`. (`kudos.ts` also date-stamps the
    // bucket, which covers the window before lazy processing runs.)
    kudos_today: null,
    // Same for peer nudges — "you already reminded Sam" must not survive
    // into a day where Sam is late again. See `nudges.ts`.
    nudges_today: null,
    // Proofs are recorded durably in days/{date}; the today bucket goes
    // with completions_today. See proofs.ts.
    proofs_today: null,
    // The day the build landed on is over; the next pick is allowed again.
    landed_on: null,
  };

  await db().collection("groups").doc(groupId).update(writeUpdates);

  const merged = { ...data, ...writeUpdates };

  // "City grew" push: a build landed during this end-of-day pass. Whichever
  // caller triggered processing sends it; last_processed_date has advanced so
  // it won't re-fire. Best-effort — notify never throws.
  const event = writeUpdates.pending_event as { type?: string; building?: string } | undefined;
  if (event?.type === "build_complete") {
    const label = labelFor(event.building ?? "");
    await notifyAllMembers(groupId, merged, {
      title: `🏙️ ${merged.group_name ?? "Your city"} grew!`,
      body: `Your crew finished ${withArticle(label)}. Come see it in the city.`,
    });
  }

  // "Build stalled" push: a multi-day build lost a day. Nothing was
  // destroyed, but the crew has only today to spend a freeze and resume it.
  const stalled = writeUpdates.abandoned_build as
    | { type?: string; days_completed?: number; days_required?: number }
    | null
    | undefined;
  if (stalled) {
    const label = labelFor(stalled.type ?? "");
    const freezes = (writeUpdates.streak_freezes as number | undefined) ?? 0;
    // What a miss IS depends on the mode: hard stalls when anyone is missing,
    // easy only when nobody finished at all.
    const why =
      normalizeGameMode(merged.game_mode) === "easy"
        ? "Nobody finished yesterday's goal."
        : "Yesterday's goal wasn't finished by everyone.";
    await notifyAllMembers(groupId, merged, {
      title: `🚧 Your ${label} build stalled`,
      body:
        freezes > 0
          ? `${why} Open the app today to spend a streak freeze and pick it back up — after today it's gone.`
          : `${why} There are no streak freezes left, so you'll need to start a new build.`,
    });
  }

  return maybeSuggestEasyMode(groupId, merged, processingDate);
}

/**
 * Hard mode's been rough → suggest easy mode, once per cooldown.
 *
 * Runs after every settlement pass (and from the dev control that stages a
 * ledger). Pure decision in gameMode.ts; this is the write and the push. The
 * app opens the suggestion sheet off `mode_suggestion` on the next snapshot.
 */
export async function maybeSuggestEasyMode(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  processingDate: string,
): Promise<FirebaseFirestore.DocumentData> {
  const nearMissDates: string[] = data.near_miss_dates ?? [];
  const existing: ModeSuggestion | null = data.mode_suggestion ?? null;
  const mode: GameMode = normalizeGameMode(data.game_mode);
  if (!shouldSuggestEasyMode({ mode, nearMissDates, processingDate, suggestion: existing })) {
    return data;
  }
  const suggestion: ModeSuggestion = {
    suggested_on: processingDate,
    near_misses: recentNearMisses(nearMissDates, processingDate),
    dismissed_by: [],
  };
  await db().collection("groups").doc(groupId).update({ mode_suggestion: suggestion });
  const merged: FirebaseFirestore.DocumentData = { ...data, mode_suggestion: suggestion };
  await notifyAllMembers(
    groupId,
    merged,
    {
      ...easyModeSuggestionMessage(
        merged.group_name ?? "your city",
        suggestion.near_misses,
        NEAR_MISS_WINDOW_DAYS,
      ),
      data: { type: "mode_suggestion" },
    },
  );
  return merged;
}

// --- createGroup ---

export const createGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);

  const groupName = requireTrimmed(request.data.group_name, "group_name", 3, 40);
  const member = requireTrimmed(request.data.member, "member", 1, 30);
  const dailyGoal = requireTrimmed(request.data.daily_goal, "daily_goal", 1, 200);
  const goalResetTime = requireResetTime(request.data.goal_reset_time ?? "00:00");
  const goalResetTimezone =
    typeof request.data.goal_reset_timezone === "string" && request.data.goal_reset_timezone
      ? request.data.goal_reset_timezone
      : "UTC";
  // Absent → hard. An old binary never sends one, and hard is the only game
  // it knows how to show; the current app always sends its choice.
  const rawMode = request.data.game_mode;
  if (rawMode !== undefined && rawMode !== null && !isGameMode(rawMode)) {
    throw new HttpsError("invalid-argument", "game_mode must be 'easy' or 'hard'");
  }
  const gameMode: GameMode = isGameMode(rawMode) ? rawMode : LEGACY_GAME_MODE;

  const groupId = uuidv4();
  const userRef = db().collection("users").doc(uid);

  // Retry up to 5 times on code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateGroupCode();

    try {
      await db().runTransaction(async (tx) => {
        const codeRef = db().collection("group_codes").doc(code);
        const [codeSnap, userSnap] = await Promise.all([
          tx.get(codeRef),
          tx.get(userRef),
        ]);

        if (codeSnap.exists) {
          throw new Error("CODE_COLLISION");
        }

        const groupIds: string[] = userSnap.data()?.group_ids ?? [];
        if (groupIds.length >= MAX_GROUPS_PER_USER) {
          throw new HttpsError(
            "failed-precondition",
            `You can be in at most ${MAX_GROUPS_PER_USER} cities`,
          );
        }

        const groupRef = db().collection("groups").doc(groupId);
        const groupData = {
          group_code: code,
          group_name: groupName,
          group_members: [member],
          owner_uid: uid,
          member_uids: [uid],
          daily_goal: dailyGoal,
          goal_reset_time: goalResetTime,
          goal_reset_timezone: goalResetTimezone,
          game_mode: gameMode,
          game_mode_set_by: uid,
          near_miss_dates: [],
          mode_suggestion: null,
          completions_today: [],
          streak: 0,
          streak_freezes: STARTING_FREEZES,
          frozen_dates: [],
          broken_streak: null,
          last_activity_date: getProcessingDate(goalResetTime, goalResetTimezone),
          last_inactivity_meteor_date: null,
          current_build: null,
          abandoned_build: null,
          city_map: EMPTY_CITY,
          build_order: [],
          parks: [],
          // Founded after compact growth shipped, so nothing to freeze.
          plan_frozen_at_buildings: 0,
          plan_anchor_version: PLAN_ANCHOR_VERSION,
          last_processed_date: null,
          pending_event: null,
          building_completions: [],
          tile_build_dates: {},
          created_at: FieldValue.serverTimestamp(),
        };

        tx.set(codeRef, { group_id: groupId });
        tx.set(groupRef, groupData);
        tx.set(
          userRef,
          {
            display_name: member,
            group_ids: FieldValue.arrayUnion(groupId),
            created_at: userSnap.exists ? userSnap.data()!.created_at ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });

      // Read back with server timestamp resolved
      const snap = await db().collection("groups").doc(groupId).get();
      return groupToResponse(groupId, snap.data()!);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === "CODE_COLLISION") {
        continue;
      }
      throw e;
    }
  }

  throw new HttpsError("internal", "Failed to generate unique group code");
});

// --- joinGroup ---

export const joinGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const rawCode = requireTrimmed(request.data.group_code, "group_code", 6, 6);
  const member = requireTrimmed(request.data.member, "member", 1, 30);

  const code = rawCode.toUpperCase();
  const codeSnap = await db().collection("group_codes").doc(code).get();

  if (!codeSnap.exists) {
    throw new HttpsError("not-found", "Invalid group code");
  }

  const groupId = codeSnap.data()!.group_id;
  const groupRef = db().collection("groups").doc(groupId);
  const userRef = db().collection("users").doc(uid);

  let finalData: FirebaseFirestore.DocumentData;
  let joinedName: string | null = null;

  await db().runTransaction(async (tx) => {
    const [groupSnap, userSnap] = await Promise.all([
      tx.get(groupRef),
      tx.get(userRef),
    ]);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "Group not found");
    }

    const data = groupSnap.data()!;
    const members: string[] = data.group_members;
    const memberUids: string[] = data.member_uids ?? [];

    // Idempotent — already a member
    if (memberUids.includes(uid)) {
      finalData = data;
      return;
    }

    if (members.length >= MAX_MEMBERS_PER_GROUP) {
      throw new HttpsError(
        "failed-precondition",
        `Group is full (max ${MAX_MEMBERS_PER_GROUP} members)`,
      );
    }

    const groupIds: string[] = userSnap.data()?.group_ids ?? [];
    if (groupIds.length >= MAX_GROUPS_PER_USER) {
      throw new HttpsError(
        "failed-precondition",
        `You can be in at most ${MAX_GROUPS_PER_USER} cities`,
      );
    }

    // Display names are the game-state currency (completions etc.), so
    // they must be unique within a group — suffix on collision.
    let name = member;
    for (let i = 2; members.includes(name); i++) {
      name = `${member} ${i}`;
    }

    tx.update(groupRef, {
      group_members: [...members, name],
      member_uids: [...memberUids, uid],
    });
    tx.set(
      userRef,
      {
        display_name: member,
        group_ids: FieldValue.arrayUnion(groupId),
        created_at: userSnap.exists ? userSnap.data()!.created_at ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    joinedName = name;
    finalData = {
      ...data,
      group_members: [...members, name],
      member_uids: [...memberUids, uid],
    };
  });

  finalData = await maybeProcessDay(groupId, finalData!);

  // Tell the crew the bar just moved. Everyone except the person who joined —
  // they already know, and they're looking at the city right now.
  if (joinedName) {
    const others = (finalData.group_members ?? []).filter(
      (m: string) => m !== joinedName,
    );
    await notifyMembers(
      groupId,
      finalData,
      others,
      joinedMessage(
        joinedName,
        finalData.group_name ?? "your city",
        (finalData.group_members ?? []).length,
      ),
    );
  }

  return groupToResponse(groupId, finalData);
});

// --- getGroup ---

export const getGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const snap = await db().collection("groups").doc(group_id).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  // Membership check (throws failed-precondition for non-members)
  memberNameForUid(snap.data()!, uid);

  const data = await maybeProcessDay(group_id, snap.data()!);
  return groupToResponse(group_id, data);
});

// --- completeGoal ---

/**
 * Copy for "everyone finished today". Three flavours, because the moment
 * means different things depending on where the build is:
 *   - final day of a multi-day build → the building is done, enjoy it
 *   - mid multi-day build            → day banked, next commitment day incoming
 *   - single-day build or no build   → plain crew congratulations
 */
export function dayCompleteMessage(data: FirebaseFirestore.DocumentData) {
  const cityName = data.group_name ?? "your city";
  const build = buildProgressOf(data.current_build);

  if (build) {
    const { dayNumber, daysRequired, label } = build;
    if (dayNumber >= daysRequired) {
      return {
        title: "🎉 Everyone's in — build complete!",
        body: `That's all ${daysRequired} days. Your ${label} is finished — enjoy the new addition to ${cityName}.`,
      };
    }
    return {
      title: "🎉 Everyone's in!",
      body: `Day ${dayNumber} of ${daysRequired} banked toward your ${label}. Next commitment day is tomorrow — keep it going.`,
    };
  }

  return {
    title: "🎉 Everyone's in!",
    body: `The whole crew completed today's goal in ${cityName}. Next commitment day is tomorrow.`,
  };
}

export const completeGoal = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, proof } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  let finalData: FirebaseFirestore.DocumentData;

  // First, run day processing if needed (outside transaction for simplicity)
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  data = await ensurePlanAnchor(group_id, data);

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  // Verify the proof OUTSIDE the transaction — it's a network round-trip to
  // Storage and Firestore transactions may retry.
  const proofEntry = await resolveProof(proof, group_id, uid);

  // Set only when THIS call is the one that records a new completion (not the
  // idempotent re-tap), so we notify teammates exactly once.
  let completedName: string | null = null;
  // The build as it stood before this call landed it (null if nothing landed).
  let landedBuild: FirebaseFirestore.DocumentData | null = null;

  // Now mark completion in a transaction
  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const member = memberNameForUid(freshData, uid);
    const completions: string[] = freshData.completions_today;

    // The current game-day label in the group's timezone — completing the
    // goal is "activity" for the 7-day inactivity meteor.
    const activityDate = getProcessingDate(
      freshData.goal_reset_time,
      freshData.goal_reset_timezone ?? "UTC",
    );

    // Vacation mode: a paused city has no day to complete, and a paused
    // member isn't on today's roster. Refused here rather than merely hidden
    // in the app — a stale client would otherwise record a completion that
    // day processing then ignores, which is a lie the UI can't explain. The
    // detail lets the app say why in its own words.
    const roster = rosterOf(freshData);
    if (isDayPaused(roster, activityDate)) {
      throw new HttpsError(
        "failed-precondition",
        "This city is paused — nothing counts today",
        { reason: "paused" },
      );
    }
    if (pausedMembersOn(roster, activityDate).includes(member)) {
      throw new HttpsError(
        "failed-precondition",
        "You're on vacation in this city — tap I'm back first",
        { reason: "paused" },
      );
    }

    // Idempotent
    if (completions.includes(member)) {
      completedName = null;
      finalData = freshData;
      return;
    }

    const newCompletions = [...completions, member];
    completedName = member;
    const { state: proofsToday } = applyProof(freshData.proofs_today, activityDate, member, proofEntry);

    // Land the build the moment the last ACTIVE member finishes its final
    // day — no waiting for tonight's day processing. Same roster rule the
    // processor uses (someone on vacation is not waited for). `landed_on`
    // keeps `selectBuild` from starting a second build off today's
    // completions; day processing then finds no build and only logs the day.
    //
    // Game mode (gameMode.ts): the question is whether today's SHARE closes
    // the build — a whole day in hard mode once everyone's in, whatever
    // fraction reaches the requirement in easy mode. Same arithmetic the
    // settlement fallback uses, so the two can never disagree.
    const crewRoster = rosterOf(freshData);
    const active = activeMembersOn(crewRoster, activityDate);
    const completedActive = active.filter((m: string) => newCompletions.includes(m)).length;
    const shareNow = isDayPaused(crewRoster, activityDate)
      ? 0
      : dayShare(normalizeGameMode(freshData.game_mode), completedActive, active.length);
    const build = freshData.current_build ?? null;
    const landing =
      shareNow > 0 &&
      build &&
      isBuildFinished(snapProgress(build.days_completed + shareNow), build.days_required)
        ? landBuild({
            currentBuild: build,
            cityMap: freshData.city_map,
            parks: normalizeParks(freshData.parks),
            buildOrder: freshData.build_order ?? null,
            tileBuildDates: freshData.tile_build_dates ?? {},
            rubbleOrigins: freshData.rubble_origins ?? {},
            streakFreezes: freshData.streak_freezes ?? 0,
            landedOn: activityDate,
            nowIso: new Date().toISOString(),
          })
        : null;
    landedBuild = landing ? build : null;
    const landingUpdates: Record<string, unknown> = landing
      ? { ...landing, landed_on: activityDate }
      : {};

    tx.update(groupRef, {
      completions_today: newCompletions,
      last_activity_date: activityDate,
      proofs_today: proofsToday,
      ...landingUpdates,
    });
    // Durable per-day ledger — what "See proof" on a building reads.
    tx.set(
      groupRef.collection("days").doc(activityDate),
      { proofs: { [member]: { ...proofEntry, at: new Date().toISOString() } } },
      { merge: true },
    );
    finalData = {
      ...freshData,
      completions_today: newCompletions,
      last_activity_date: activityDate,
      proofs_today: proofsToday,
      ...landingUpdates,
    };
  });

  // "Teammate completed" push → nudge the crew members who still haven't
  // finished today (the pressure's on them). Best-effort, after the write.
  if (completedName) {
    const done: string[] = finalData!.completions_today ?? [];
    // The roster for today is the ACTIVE members — someone on vacation is
    // neither nudged nor waited for.
    const today = getProcessingDate(
      finalData!.goal_reset_time,
      finalData!.goal_reset_timezone ?? "UTC",
    );
    const stillPending: string[] = activeMembersOn(rosterOf(finalData!), today).filter(
      (m: string) => !done.includes(m),
    );
    if (stillPending.length > 0) {
      await notifyMembers(group_id, finalData!, stillPending, {
        title: finalData!.group_name ?? "Bitty City",
        body: `${completedName} completed today's goal. Your turn!`,
        // Everyone on this list has NOT completed yet, and `completedName`
        // has — exactly the precondition `sendKudos` enforces — so the
        // notification can carry a one-tap **Send kudos** button. The name
        // travels in the data payload; the app never guesses the recipient.
        categoryId: NotificationCategory.TEAMMATE_COMPLETED,
        data: { type: "teammate_completed", completed_by: completedName },
      });
    } else {
      // That was the last one — the whole crew is in. Celebrate the day and
      // point at what's next. If this completion landed the build, the copy
      // already says so (dayCompleteMessage reads the build before it was
      // cleared? — no: it reads `finalData`, so pass the pre-landing build).
      await notifyAllMembers(
        group_id,
        finalData!,
        dayCompleteMessage(landedBuild ? { ...finalData!, current_build: landedBuild } : finalData!),
      );
    }
  }

  return groupToResponse(group_id, finalData!);
});

// --- selectBuild ---

export const selectBuild = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, type } = request.data;

  if (!group_id || !type) {
    throw new HttpsError("invalid-argument", "group_id and type are required");
  }

  // Only catalog ids may be STARTED. Legacy values ('house' etc.) stay
  // readable everywhere else so in-flight builds and standing cities keep
  // working, but a new build always uses the current vocabulary.
  if (!isBuildable(type)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid build. Must be one of: ${buildableIds().join(", ")}`,
    );
  }

  const groupRef = db().collection("groups").doc(group_id);
  let finalData: FirebaseFirestore.DocumentData;

  // Run day processing first
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  // Who picked, so the rest of the crew can be told. Set inside the
  // transaction so a losing racer (build already in progress) never notifies.
  let pickerName: string | null = null;

  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const member = memberNameForUid(freshData, uid);

    if (freshData.current_build !== null) {
      throw new HttpsError("failed-precondition", "A build is already in progress");
    }

    // A build that landed today already used today's completions; a second
    // one would land off the same check-ins at day processing. One per day.
    const today = getProcessingDate(freshData.goal_reset_time, freshData.goal_reset_timezone ?? "UTC");
    if (freshData.landed_on === today) {
      throw new HttpsError("failed-precondition", "Your city grew today — pick the next build tomorrow");
    }

    // Check if city is full
    const hasEmpty = findEmptyTiles(freshData.city_map).length > 0;
    if (!hasEmpty) {
      throw new HttpsError("failed-precondition", "City is full — no empty tiles");
    }

    const newBuild = {
      type,
      days_required: daysFor(type)!,
      days_completed: 0,
    };

    // Choosing a new build gives up any stalled one still on offer.
    tx.update(groupRef, { current_build: newBuild, abandoned_build: null });
    finalData = { ...freshData, current_build: newBuild, abandoned_build: null };
    pickerName = member;
  });

  // "Someone picked the next build" push → tell the rest of the crew what
  // they're working toward. Best-effort, after the write.
  if (pickerName) {
    const label = labelFor(type);
    const days: number = daysFor(type)!;
    const span = days === 1 ? "Today's goal builds it." : `It takes ${days} days of everyone completing their goal.`;
    await notifyAllMembers(
      group_id,
      finalData!,
      {
        title: `🏗️ Next up: ${withArticle(label)}`,
        body: `${pickerName} picked ${withArticle(label)} for ${finalData!.group_name ?? "your city"}. ${span}`,
      },
      pickerName,
    );
  }

  return groupToResponse(group_id, finalData!);
});

// --- repairTile ---
//
// Rebuild what a meteor levelled, on the lot where it stood.
//
// The rules are the ordinary build rules, deliberately: a repair costs the
// same days the original type costs, occupies the single build slot, and
// lands when the crew completes those days. Rebuilding is not a discount for
// having been hit — it is the same work, aimed at a specific ruin.
//
// Transactional for the same reason `selectBuild` is: two members tapping two
// different ruins at once must not both open a build.

export const repairTile = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id, row, col } = request.data;

  if (!group_id || typeof row !== "number" || typeof col !== "number") {
    throw new HttpsError(
      "invalid-argument",
      "group_id, row and col are required",
    );
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  // Settle any outstanding days first: a ruin might be about to be rebuilt by
  // a build that is already landing, and the repair must see that.
  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  let finalData: FirebaseFirestore.DocumentData;
  let repairerName: string | null = null;
  let repairedType = "";

  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const member = memberNameForUid(freshData, uid);

    if (freshData.current_build != null) {
      throw new HttpsError("failed-precondition", "A build is already in progress");
    }

    const cell = freshData.city_map?.[String(row)]?.[col];
    if (cell !== "rubble") {
      throw new HttpsError("failed-precondition", "That lot is not rubble");
    }

    // The ledger is the only record of what stood here — the cell itself was
    // overwritten when it was destroyed. A city levelled before the ledger
    // existed has no entry, so there is nothing to restore.
    const origins: Record<string, string> = freshData.rubble_origins ?? {};
    const type = origins[`${row},${col}`];
    if (!type || !daysFor(type)) {
      throw new HttpsError(
        "failed-precondition",
        "No record of what stood here, so it can't be rebuilt",
      );
    }

    const newBuild = {
      type,
      days_required: daysFor(type)!,
      days_completed: 0,
      target_tile: { row, col },
    };

    // A repair gives up any stalled build still on offer, exactly as picking
    // a new build does — there is only ever one build slot.
    tx.update(groupRef, { current_build: newBuild, abandoned_build: null });
    finalData = { ...freshData, current_build: newBuild, abandoned_build: null };
    repairerName = member;
    repairedType = type;
  });

  if (repairerName) {
    const label = labelFor(repairedType);
    const days: number = daysFor(repairedType)!;
    const span = days === 1
      ? "Today's goal rebuilds it."
      : `It takes ${days} days of everyone completing their goal.`;
    await notifyAllMembers(
      group_id,
      finalData!,
      {
        title: `🧱 Rebuilding ${withArticle(label)}`,
        body: `${repairerName} is putting ${withArticle(label)} back up in ${finalData!.group_name ?? "your city"}. ${span}`,
      },
      repairerName,
    );
  }

  return groupToResponse(group_id, finalData!);
});

// --- rescueBuild ---
//
// Spend one streak freeze to resume a build that stalled on a missed day.
// Runs in a transaction so two members tapping at once can't burn two
// freezes for one rescue — the loser finds `abandoned_build` already null
// and gets a failed-precondition.

export const rescueBuild = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  // Settle any pending day first so `abandoned_build` is current.
  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  const today = getProcessingDate(
    data.goal_reset_time,
    data.goal_reset_timezone ?? "UTC",
  );

  let rescuerName: string | null = null;
  let buildType = "";
  let finalData: FirebaseFirestore.DocumentData;

  await db().runTransaction(async (tx) => {
    const freshSnap = await tx.get(groupRef);
    const freshData = freshSnap.data()!;
    const member = memberNameForUid(freshData, uid);

    const rescued = applyBuildRescue({
      abandonedBuild: freshData.abandoned_build ?? null,
      currentBuild: freshData.current_build ?? null,
      streakFreezes: freshData.streak_freezes ?? 0,
      todayStr: today,
    });

    if (!rescued) {
      throw new HttpsError(
        "failed-precondition",
        "There's no stalled build to rescue, or no streak freeze to spend",
      );
    }

    tx.update(groupRef, rescued);
    finalData = { ...freshData, ...rescued };
    rescuerName = member;
    buildType = rescued.current_build.type;
  });

  if (rescuerName) {
    const label = labelFor(buildType);
    await notifyAllMembers(
      group_id,
      finalData!,
      {
        title: `🧊 The ${label} build is back on`,
        body: `${rescuerName} spent a streak freeze to save it. Finish today's goal to keep it moving.`,
      },
      rescuerName,
    );
  }

  return groupToResponse(group_id, finalData!);
});

// --- repairStreak ---

export const repairStreak = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  let data = snap.data()!;
  memberNameForUid(data, uid);

  // Settle any pending day first so broken_streak is current
  if (needsDayProcessing(data.goal_reset_time, data.last_processed_date, data.goal_reset_timezone ?? "UTC")) {
    data = await maybeProcessDay(group_id, data);
  }

  const today = getProcessingDate(
    data.goal_reset_time,
    data.goal_reset_timezone ?? "UTC",
  );
  const repaired = applyStreakRepair({
    buildingCompletions: data.building_completions ?? [],
    frozenDates: data.frozen_dates ?? [],
    pausedDates: data.paused_dates ?? [],
    brokenStreak: data.broken_streak ?? null,
    todayStr: today,
  });

  if (!repaired) {
    throw new HttpsError(
      "failed-precondition",
      "There's no recently broken streak to repair",
    );
  }

  await groupRef.update({
    frozen_dates: repaired.frozen_dates,
    streak: repaired.streak,
    broken_streak: null,
  });

  const updatedSnap = await groupRef.get();
  return groupToResponse(group_id, updatedSnap.data()!);
});

// --- leaveGroup ---

export const leaveGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const userRef = db().collection("users").doc(uid);

  let leftName: string | null = null;
  let remaining: FirebaseFirestore.DocumentData | null = null;
  await db().runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      // Already gone — just clean up the membership pointer.
      tx.set(userRef, { group_ids: FieldValue.arrayRemove(group_id) }, { merge: true });
      return;
    }

    const data = groupSnap.data()!;
    const name = memberNameForUid(data, uid);

    if (data.owner_uid === uid) {
      throw new HttpsError(
        "failed-precondition",
        "The founder can't leave their city — delete it instead",
      );
    }

    const idx = (data.member_uids as string[]).indexOf(uid);
    const newMembers = (data.group_members as string[]).filter((_, i) => i !== idx);
    const newUids = (data.member_uids as string[]).filter((_, i) => i !== idx);
    const newCompletions = (data.completions_today as string[]).filter(
      (m) => m !== name,
    );

    tx.update(groupRef, {
      group_members: newMembers,
      member_uids: newUids,
      completions_today: newCompletions,
      member_pauses: withoutPause(data.member_pauses, uid),
    });
    tx.set(userRef, { group_ids: FieldValue.arrayRemove(group_id) }, { merge: true });

    leftName = name;
    remaining = {
      ...data,
      group_members: newMembers,
      member_uids: newUids,
      completions_today: newCompletions,
    };
  });

  // Tell whoever is left that the bar moved. Notified with the POST-leave
  // arrays, so the person who left is already out of the mapping and can't be
  // sent a note about their own departure.
  // Read through a const: TypeScript doesn't track assignments made inside the
  // transaction callback, so `remaining` narrows to null without this.
  const after = remaining as FirebaseFirestore.DocumentData | null;
  if (leftName && after && (after.group_members ?? []).length > 0) {
    await notifyMembers(
      group_id,
      after,
      after.group_members,
      leftMessage(
        leftName,
        after.group_name ?? "your city",
        after.group_members.length,
      ),
    );
  }

  return { success: true };
});

// --- deleteGroup ---

export const deleteGroup = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { group_id } = request.data;

  if (!group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }

  const groupRef = db().collection("groups").doc(group_id);
  const snap = await groupRef.get();

  if (!snap.exists) {
    throw new HttpsError("not-found", "Group not found");
  }

  const data = snap.data()!;
  // Server-enforced ownership: only the founder can delete a city.
  if (data.owner_uid !== uid) {
    throw new HttpsError(
      "permission-denied",
      "Only the city's founder can delete it",
    );
  }

  const code = data.group_code;
  const memberUids: string[] = data.member_uids ?? [];
  const batch = db().batch();
  batch.delete(groupRef);
  batch.delete(db().collection("group_codes").doc(code));
  for (const memberUid of memberUids) {
    batch.set(
      db().collection("users").doc(memberUid),
      { group_ids: FieldValue.arrayRemove(group_id) },
      { merge: true },
    );
  }
  await batch.commit();

  return { success: true };
});

// --- deleteAccount ---
// App Store guideline 5.1.1(v): apps with account creation must offer
// in-app account deletion. Removes the caller from every city they're in
// (cities they founded are deleted for everyone — the app warns first),
// deletes users/{uid}, then the Auth user itself.

export const deleteAccount = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const userRef = db().collection("users").doc(uid);
  const userSnap = await userRef.get();
  const groupIds: string[] = userSnap.data()?.group_ids ?? [];

  for (const groupId of groupIds) {
    const groupRef = db().collection("groups").doc(groupId);
    const snap = await groupRef.get();
    if (!snap.exists) continue;
    const data = snap.data()!;

    if (data.owner_uid === uid) {
      // Founder: the city goes with them.
      const batch = db().batch();
      batch.delete(groupRef);
      batch.delete(db().collection("group_codes").doc(data.group_code));
      for (const memberUid of (data.member_uids as string[]) ?? []) {
        if (memberUid === uid) continue;
        batch.set(
          db().collection("users").doc(memberUid),
          { group_ids: FieldValue.arrayRemove(groupId) },
          { merge: true },
        );
      }
      await batch.commit();
    } else {
      const idx = ((data.member_uids as string[]) ?? []).indexOf(uid);
      if (idx === -1) continue;
      const name = data.group_members[idx];
      await groupRef.update({
        group_members: (data.group_members as string[]).filter((_, i) => i !== idx),
        member_uids: (data.member_uids as string[]).filter((_, i) => i !== idx),
        completions_today: (data.completions_today as string[]).filter((m) => m !== name),
        member_pauses: withoutPause(data.member_pauses, uid),
      });
    }
  }

  await userRef.delete();
  await getAuth().deleteUser(uid);

  return { success: true };
});

// --- upsertProfile ---
// Creates/updates the caller's users/{uid} doc. Called after sign-up (and
// harmlessly after sign-in) so the display name persists across groups and
// devices. Writes stay server-only; clients read the doc via Firestore rules.

export const upsertProfile = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const displayName = requireTrimmed(request.data.display_name, "display_name", 1, 30);

  const userRef = db().collection("users").doc(uid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    tx.set(
      userRef,
      {
        display_name: displayName,
        group_ids: snap.data()?.group_ids ?? [],
        created_at: snap.exists
          ? snap.data()!.created_at ?? FieldValue.serverTimestamp()
          : FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return { display_name: displayName };
});
