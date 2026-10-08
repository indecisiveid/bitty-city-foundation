/**
 * addProofComment / deleteProofComment — talk about a teammate's proof.
 *
 * Server-authoritative like kudos: the author is the caller's uid (never a
 * client-sent name), the proof's owner must be a member of the same city who
 * has a proof filed for that game day (photo, Health, or an explicit skip —
 * whatever the viewer shows), and the day can't be in the future. Any past
 * day is fair game: the viewer behind a building is the same screen.
 *
 * Storage is the day ledger (see comments.ts), written in a transaction so
 * two crewmates commenting at once both land.
 */
import { randomUUID } from "crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { getProcessingDate } from "./gameLogic";
import { memberNameForUid } from "./groupHandlers";
import { notifyMembers } from "./notify";
import { proofCommentNotice, threadCommentNotice } from "./eventMessages";
import { requireAuth } from "./auth";
import {
  ProofComment,
  applyComment,
  cleanCommentText,
  commentRecipients,
  commentsFor,
  isGameDate,
  removeComment,
} from "./comments";

const db = () => getFirestore();

function readArgs(data: unknown): { groupId: string; date: string; owner: string } {
  const { group_id, date, to_member } = (data ?? {}) as Record<string, unknown>;
  if (typeof group_id !== "string" || !group_id) {
    throw new HttpsError("invalid-argument", "group_id is required");
  }
  if (!isGameDate(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD");
  }
  if (typeof to_member !== "string" || !to_member.trim()) {
    throw new HttpsError("invalid-argument", "to_member is required");
  }
  return { groupId: group_id, date, owner: to_member };
}

export const addProofComment = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { groupId, date, owner } = readArgs(request.data);
  const text = cleanCommentText(request.data?.text);
  if (!text) {
    throw new HttpsError("invalid-argument", "Write something first (up to 280 characters)");
  }

  const groupRef = db().collection("groups").doc(groupId);
  const dayRef = groupRef.collection("days").doc(date);

  let fromName = "";
  let groupData: FirebaseFirestore.DocumentData | null = null;
  let before: ProofComment[] = [];
  let comment: ProofComment | null = null;

  await db().runTransaction(async (tx) => {
    const [groupSnap, daySnap] = await Promise.all([tx.get(groupRef), tx.get(dayRef)]);
    if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found");
    const data = groupSnap.data()!;

    // Throws failed-precondition if the caller isn't in this city.
    fromName = memberNameForUid(data, uid);

    const members: string[] = data.group_members ?? [];
    if (!members.includes(owner)) {
      throw new HttpsError("not-found", "That member isn't in this city");
    }
    const today = getProcessingDate(data.goal_reset_time, data.goal_reset_timezone ?? "UTC");
    if (date > today) {
      throw new HttpsError("invalid-argument", "That day hasn't happened yet");
    }
    const day = daySnap.exists ? daySnap.data()! : {};
    if (!day.proofs || typeof day.proofs !== "object" || !(owner in day.proofs)) {
      throw new HttpsError("failed-precondition", `${owner} has no proof for that day`);
    }

    before = commentsFor(day.comments, owner);
    const next: ProofComment = { id: randomUUID(), from: fromName, text, at: new Date().toISOString() };
    const result = applyComment(before, next);
    if (!result.ok) {
      throw new HttpsError("resource-exhausted", "That proof has all the comments it can take");
    }
    // FieldPath, not a dotted string: display names can contain dots.
    tx.update(dayRef, new FieldPath("comments", owner), result.comments);
    comment = next;
    groupData = data;
  });

  // Pushes — best-effort, after the write. The owner hears it like kudos; the
  // others already talking under this proof get a quieter follow-up.
  const posted = comment as ProofComment | null;
  if (posted && groupData) {
    const data = groupData as FirebaseFirestore.DocumentData;
    const to = commentRecipients(before, owner, fromName, data.group_members ?? []);
    if (to.owner) {
      await notifyMembers(groupId, data, [to.owner], proofCommentNotice(fromName, posted.text, date, owner));
    }
    if (to.thread.length > 0) {
      await notifyMembers(groupId, data, to.thread, threadCommentNotice(fromName, owner, posted.text, date));
    }
  }

  return { success: true, comment: posted };
});

export const deleteProofComment = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireAuth(request);
  const { groupId, date, owner } = readArgs(request.data);
  const commentId = request.data?.comment_id;
  if (typeof commentId !== "string" || !commentId) {
    throw new HttpsError("invalid-argument", "comment_id is required");
  }

  const groupRef = db().collection("groups").doc(groupId);
  const dayRef = groupRef.collection("days").doc(date);

  await db().runTransaction(async (tx) => {
    const [groupSnap, daySnap] = await Promise.all([tx.get(groupRef), tx.get(dayRef)]);
    if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found");
    const caller = memberNameForUid(groupSnap.data()!, uid);
    if (!daySnap.exists) throw new HttpsError("not-found", "Comment not found");

    const result = removeComment(commentsFor(daySnap.data()!.comments, owner), commentId, owner, caller);
    if (!result.ok) {
      throw result.reason === "not-found"
        ? new HttpsError("not-found", "Comment not found")
        : new HttpsError("permission-denied", "Only the person who wrote it, or whose proof it's on, can remove it");
    }
    tx.update(dayRef, new FieldPath("comments", owner), result.comments);
  });

  return { success: true };
});
