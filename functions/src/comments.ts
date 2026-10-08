/**
 * Proof comments — pure logic.
 *
 * A comment is one member writing under another member's proof (or under
 * their own, to answer). They live beside the proofs in the durable day
 * ledger, keyed by the proof's owner:
 *
 *   groups/{id}/days/{date}.comments: { [ownerName]: ProofComment[] }
 *
 * Same doc as `proofs[ownerName]` (see proofs.ts), so a building tapped
 * months later shows the photo and what the crew said about it, and the
 * today viewer reads them live from the same place. Nothing goes on the
 * group doc: comments are unbounded chatter, and every write there wakes
 * every member's snapshot listener.
 *
 * Arrays (append order = display order) of objects, inside a map — never an
 * array of arrays, which Firestore refuses.
 */

export interface ProofComment {
  /** Random id, minted by the server — what a delete names. */
  id: string;
  /** Author's display name in this city (server-resolved, never client-sent). */
  from: string;
  text: string;
  /** ISO timestamp. */
  at: string;
}

export type CommentsByOwner = Record<string, ProofComment[]>;

export const MAX_COMMENT_LENGTH = 280;
/** Per proof. A day doc stays far under Firestore's 1 MiB at any crew size. */
export const MAX_COMMENTS_PER_PROOF = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isGameDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);

const isComment = (v: unknown): v is ProofComment =>
  !!v &&
  typeof v === "object" &&
  typeof (v as ProofComment).id === "string" &&
  typeof (v as ProofComment).from === "string" &&
  typeof (v as ProofComment).text === "string" &&
  typeof (v as ProofComment).at === "string";

/** Whatever is on the doc for one proof, as a clean list. */
export function commentsFor(raw: unknown, owner: string): ProofComment[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)[owner];
  return Array.isArray(list) ? list.filter(isComment) : [];
}

/**
 * Tidy what the person typed: trim, collapse runs of blank lines, refuse
 * empty or over-long text. Returns null when there's nothing to post.
 */
export function cleanCommentText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || [...text].length > MAX_COMMENT_LENGTH) return null;
  return text;
}

export type AddCommentResult =
  | { ok: true; comments: ProofComment[] }
  | { ok: false; reason: "full" };

/** Append a comment under one proof. */
export function applyComment(existing: ProofComment[], comment: ProofComment): AddCommentResult {
  if (existing.length >= MAX_COMMENTS_PER_PROOF) return { ok: false, reason: "full" };
  return { ok: true, comments: [...existing, comment] };
}

export type RemoveCommentResult =
  | { ok: true; comments: ProofComment[] }
  | { ok: false; reason: "not-found" | "not-allowed" };

/**
 * Take a comment down. Its author can, and so can the proof's owner — it's
 * their photo the words hang under.
 */
export function removeComment(
  existing: ProofComment[],
  commentId: string,
  owner: string,
  caller: string,
): RemoveCommentResult {
  const target = existing.find((c) => c.id === commentId);
  if (!target) return { ok: false, reason: "not-found" };
  if (target.from !== caller && owner !== caller) return { ok: false, reason: "not-allowed" };
  return { ok: true, comments: existing.filter((c) => c.id !== commentId) };
}

/**
 * Who hears about a new comment: the proof's owner (it's on their proof),
 * and everyone else who has already commented there (the conversation they
 * joined moved). Never the author; each name once; still in the city.
 */
export function commentRecipients(
  existing: ProofComment[],
  owner: string,
  author: string,
  members: string[],
): { owner: string | null; thread: string[] } {
  const inCity = new Set(members);
  const thread = [...new Set(existing.map((c) => c.from))].filter(
    (n) => n !== author && n !== owner && inCity.has(n),
  );
  return { owner: owner !== author && inCity.has(owner) ? owner : null, thread };
}

/**
 * A member's account is going away: drop the comments under their proofs
 * and the ones they wrote under anyone else's. Returns null when this day
 * has nothing of theirs (no write needed).
 */
export function withoutMemberComments(raw: unknown, name: string): CommentsByOwner | null {
  if (!raw || typeof raw !== "object") return null;
  let changed = false;
  const out: CommentsByOwner = {};
  for (const owner of Object.keys(raw as Record<string, unknown>)) {
    const list = commentsFor(raw, owner);
    if (owner === name) {
      changed = true;
      continue;
    }
    const kept = list.filter((c) => c.from !== name);
    if (kept.length !== list.length) changed = true;
    if (kept.length > 0) out[owner] = kept;
  }
  return changed ? out : null;
}

/** First line, cut to fit a push body. */
export function commentPreview(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  const chars = [...line.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}
