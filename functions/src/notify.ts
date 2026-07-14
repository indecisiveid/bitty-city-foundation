/**
 * Notification glue: turn "notify these members of this group" into "send to
 * these Expo tokens, then prune the dead ones".
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
import { sendPush, PushPayload, isExpoPushToken } from "./push";

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

/** Read push tokens for a set of uids, returning token→uid so we can prune. */
async function tokensForUids(uids: string[]): Promise<Map<string, string>> {
  const tokenToUid = new Map<string, string>();
  if (uids.length === 0) return tokenToUid;

  const snaps = await db().getAll(
    ...uids.map((uid) => db().collection("users").doc(uid)),
  );
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const tokens: string[] = snap.data()?.push_tokens ?? [];
    for (const t of tokens) {
      if (isExpoPushToken(t)) tokenToUid.set(t, snap.id);
    }
  }
  return tokenToUid;
}

/** Remove tokens Expo rejected (DeviceNotRegistered) from their user docs. */
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

/** Send a payload to a set of uids (dedup across their devices), then prune. */
export async function notifyUids(
  uids: string[],
  payload: PushPayload,
): Promise<void> {
  try {
    const tokenToUid = await tokensForUids([...new Set(uids)]);
    if (tokenToUid.size === 0) return;
    const invalid = await sendPush([...tokenToUid.keys()], payload);
    await pruneTokens(invalid, tokenToUid);
  } catch (err) {
    console.error("[notify] notifyUids failed", err);
  }
}

/** Attach the city context every notification carries for deep-linking. */
function withGroupData(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  payload: PushPayload,
): PushPayload {
  return {
    ...payload,
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
  payload: PushPayload,
): Promise<void> {
  const uids = uidsForNames(data, names);
  if (uids.length === 0) return;
  await notifyUids(uids, withGroupData(groupId, data, payload));
}

/** Notify everyone in a group, optionally excluding one member by name. */
export async function notifyAllMembers(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  payload: PushPayload,
  exceptName?: string,
): Promise<void> {
  const names: string[] = (data.group_members ?? []).filter(
    (n: string) => n !== exceptName,
  );
  await notifyMembers(groupId, data, names, payload);
}
