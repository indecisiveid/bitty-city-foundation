/**
 * Notification glue: turn "notify these members of this group" into "send to
 * these FCM tokens, then prune the dead ones".
 *
 * Push tokens live on `users/{uid}.push_tokens` (an array — a person can be
 * signed in on several devices). Group state is name-keyed
 * (`group_members`/`completions_today`), and `member_uids` is index-aligned
 * with `group_members`, so we map names → uids → tokens here.
 *
 * Everything is best-effort: a push failure is logged and swallowed so it can
 * never break the game action (completing a goal, day processing, …) that
 * triggered it.
 */
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { sendPush, PushPayload, isValidPushToken } from "./push";
import { NoticeMeta, decideNotice, ledgerOf, recordNotice } from "./notices";
import { tierFor } from "./reminderTiers";
import { idleDaysFor, localMinutesOf } from "./presence";
import { getProcessingDate } from "./gameLogic";
import type { Notice } from "./eventMessages";

const db = () => getFirestore();

/** Map member display names to uids using the index-aligned arrays. */
export function uidsForNames(
  data: FirebaseFirestore.DocumentData,
  names: string[],
): string[] {
  const members: string[] = data.group_members ?? [];
  const uids: string[] = data.member_uids ?? [];
  const want = new Set(names);
  const out: string[] = [];
  members.forEach((name, i) => {
    if (want.has(name) && uids[i]) out.push(uids[i]);
  });
  return out;
}

export type UserSnap = FirebaseFirestore.DocumentSnapshot;

/** Load `users/{uid}` docs in one round-trip, keyed by uid (missing docs included, `exists` false). */
export async function loadUsers(uids: string[]): Promise<Map<string, UserSnap>> {
  const out = new Map<string, UserSnap>();
  const unique = [...new Set(uids)];
  if (unique.length === 0) return out;
  const snaps = await db().getAll(...unique.map((uid) => db().collection("users").doc(uid)));
  for (const snap of snaps) out.set(snap.id, snap);
  return out;
}

/** Push tokens across a set of user docs, as token→uid so we can prune. */
function tokensFromSnaps(snaps: Iterable<UserSnap>): Map<string, string> {
  const tokenToUid = new Map<string, string>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const tokens: string[] = snap.data()?.push_tokens ?? [];
    for (const t of tokens) {
      if (isValidPushToken(t)) tokenToUid.set(t, snap.id);
    }
  }
  return tokenToUid;
}

/** Remove tokens FCM rejected (not registered / invalid) from their user docs. */
async function pruneTokens(
  invalid: string[],
  tokenToUid: Map<string, string>,
): Promise<void> {
  if (invalid.length === 0) return;
  // Group the dead tokens by owner so it's one write per affected user.
  const byUid = new Map<string, string[]>();
  for (const token of invalid) {
    const uid = tokenToUid.get(token);
    if (!uid) continue;
    (byUid.get(uid) ?? byUid.set(uid, []).get(uid)!).push(token);
  }
  await Promise.all(
    [...byUid.entries()].map(([uid, tokens]) =>
      db()
        .collection("users")
        .doc(uid)
        .set({ push_tokens: FieldValue.arrayRemove(...tokens) }, { merge: true })
        .catch((err) => console.error("[notify] prune failed", uid, err)),
    ),
  );
}

/** Send a payload to already-loaded user docs (dedup across devices), then prune. */
export async function notifySnaps(snaps: UserSnap[], payload: PushPayload): Promise<void> {
  try {
    const tokenToUid = tokensFromSnaps(snaps);
    if (tokenToUid.size === 0) return;
    const invalid = await sendPush([...tokenToUid.keys()], payload);
    await pruneTokens(invalid, tokenToUid);
  } catch (err) {
    console.error("[notify] notifySnaps failed", err);
  }
}

/**
 * The one way a notice reaches people: per recipient, the policy in
 * notices.ts decides send / send quietly / drop (presence tier, daily budget
 * per category, winback cooldown, once-only keys, quiet hours in the city's
 * clock); what goes out carries `data.type` + `data.variant`, and the
 * person's ledger (`users/{uid}.notices`) records it. Best-effort: a failure
 * is logged and never breaks the game action that triggered it.
 */
export async function deliverNotice(
  uids: string[],
  n: Notice,
  ctx: { timezone: string; resetTime?: string; now?: Date },
): Promise<string[]> {
  const delivered: string[] = [];
  try {
    const now = ctx.now ?? new Date();
    const today = getProcessingDate(ctx.resetTime ?? "00:00", ctx.timezone, now);
    const localMinutes = localMinutesOf(now, ctx.timezone);
    const users = await loadUsers(uids);
    const { meta, ...payload } = n;
    for (const snap of users.values()) {
      if (!snap.exists) continue;
      const user = snap.data() ?? {};
      const ledger = ledgerOf(user.notices);
      const decision = decideNotice(meta, tierFor(idleDaysFor(user, now)), ledger, today, localMinutes);
      if (!decision.deliver) continue;
      await notifySnaps([snap], {
        ...payload,
        quiet: decision.quiet,
        data: { ...(payload.data ?? {}), type: meta.type, variant: meta.variant },
      });
      delivered.push(snap.id);
      // update(), not set-merge: a new day's counts must REPLACE yesterday's.
      await snap.ref
        .update({ notices: recordNotice(ledger, meta, today) })
        .catch((err) => console.error("[notify] ledger write failed", snap.id, err));
    }
  } catch (err) {
    console.error("[notify] deliverNotice failed", err);
  }
  return delivered;
}

/** Record something sent outside deliverNotice (the scheduled reminders) on the same ledger. */
export async function recordSent(
  snap: UserSnap,
  meta: NoticeMeta,
  today: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!snap.exists) return;
  try {
    await snap.ref.update({ notices: recordNotice(ledgerOf(snap.data()?.notices), meta, today), ...extra });
  } catch (err) {
    console.error("[notify] recordSent failed", snap.id, err);
  }
}

/** Send a notice to specific uids (not tied to a city — e.g. the test push). */
export async function notifyUids(uids: string[], n: Notice): Promise<string[]> {
  return deliverNotice([...new Set(uids)], n, { timezone: "UTC" });
}

/** Attach the city context every notification carries for deep-linking. */
export function withGroupData(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  payload: PushPayload,
): PushPayload {
  return {
    ...payload,
    // One notification stack per city on iOS (see PushPayload.threadId).
    threadId: payload.threadId ?? groupId,
    data: {
      group_id: groupId,
      group_name: data.group_name ?? "",
      ...(payload.data ?? {}),
    },
  };
}

/** Notify specific members of a group by display name. */
export async function notifyMembers(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  names: string[],
  n: Notice,
): Promise<string[]> {
  const uids = uidsForNames(data, names);
  if (uids.length === 0) return [];
  const { meta, ...payload } = n;
  return deliverNotice(uids, { ...withGroupData(groupId, data, payload), meta }, {
    timezone: data.goal_reset_timezone ?? "UTC",
    resetTime: data.goal_reset_time ?? "00:00",
  });
}

/** Notify everyone in a group, optionally excluding one member by name. */
export async function notifyAllMembers(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  n: Notice,
  exceptName?: string | null,
): Promise<string[]> {
  const names: string[] = (data.group_members ?? []).filter(
    (m: string) => m !== exceptName,
  );
  return notifyMembers(groupId, data, names, n);
}
