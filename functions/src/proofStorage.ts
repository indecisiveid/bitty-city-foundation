/**
 * The one thing storage.rules can't do: tell `completeGoal` whether the
 * object a client claims to have uploaded is really there. Admin SDK, so it
 * bypasses rules — which is fine, the *caller* was already gated by
 * membership + key ownership in proofs.ts.
 *
 * Bucket name is a param so the emulator smoke and a future dev project can
 * point elsewhere; the default is the bucket in GoogleService-Info.plist.
 * The functions emulator routes this to the Storage emulator automatically
 * (FIREBASE_STORAGE_EMULATOR_HOST).
 */
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "crypto";
import { defineString } from "firebase-functions/params";
import { parseCities } from "./proofs";

export const PROOFS_BUCKET_DEFAULT = "bitty-city.firebasestorage.app";
export const proofsBucket = defineString("PROOFS_BUCKET", { default: PROOFS_BUCKET_DEFAULT });

export interface ProofObjectInfo {
  size: number;
  /** Firebase download URL (existing token, minted if the upload had none). */
  url: string;
}

const isNotFound = (err: unknown) => (err as { code?: number }).code === 404;

/**
 * Everything `completeGoal(s)` needs from a claimed upload, in ONE metadata
 * read: whether it exists, its size, and a download URL for the entry and the
 * push banner — however many cities it lands in. A token is minted (one
 * write) only if the upload somehow has none. Null when the object doesn't
 * exist.
 */
export async function inspectProofObject(key: string, bucketName: string): Promise<ProofObjectInfo | null> {
  const f = getStorage().bucket(bucketName).file(key);
  let meta;
  try {
    [meta] = await f.getMetadata();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let token = String(meta.metadata?.firebaseStorageDownloadTokens ?? "").split(",")[0];
  if (!token) {
    token = randomUUID();
    await f.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  }
  return { size: Number(meta.size ?? 0), url: downloadUrlFor(bucketName, key, token) };
}

/**
 * Record that these cities now show a shared photo (its `cities` metadata).
 * Called once per check-in with every city that filed it.
 */
export async function addSharedProofCities(key: string, cities: string[], bucketName: string): Promise<void> {
  const f = getStorage().bucket(bucketName).file(key);
  const [meta] = await f.getMetadata();
  const had = parseCities(meta.metadata?.cities);
  const merged = [...new Set([...had, ...cities])];
  if (merged.length !== had.length) await f.setMetadata({ metadata: { cities: merged.join(",") } });
}

/**
 * A city lets go of a shared photo (the city was deleted, or the person who
 * posted it left the app). The object goes once no city references it.
 */
export async function releaseSharedProof(key: string, groupId: string, bucketName: string): Promise<void> {
  const f = getStorage().bucket(bucketName).file(key);
  let meta;
  try {
    [meta] = await f.getMetadata();
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const left = parseCities(meta.metadata?.cities).filter((id) => id !== groupId);
  if (left.length === 0) {
    await deleteProofObject(key, bucketName);
  } else {
    await f.setMetadata({ metadata: { cities: left.join(",") } });
  }
}

/**
 * The photo's Firebase download URL — the same kind of URL every crewmate's
 * app already loads it from (getDownloadURL), so putting it in a push widens
 * nothing. Uses the object's existing download token, minting one only if the
 * upload somehow has none. Null when the object is gone or unreadable; a push
 * without a picture is fine.
 */
export async function proofImageUrl(key: string, bucketName: string): Promise<string | null> {
  try {
    const f = getStorage().bucket(bucketName).file(key);
    const [meta] = await f.getMetadata();
    let token = String(meta.metadata?.firebaseStorageDownloadTokens ?? "").split(",")[0];
    if (!token) {
      token = randomUUID();
      await f.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    return downloadUrlFor(bucketName, key, token);
  } catch (err) {
    console.error("[proof] image url failed", key, err);
    return null;
  }
}

/** Firebase Storage's public download URL shape for an object + token. */
export function downloadUrlFor(bucketName: string, key: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(key)}?alt=media&token=${encodeURIComponent(token)}`;
}

export async function deleteProofObject(key: string, bucketName: string): Promise<void> {
  try {
    await getStorage().bucket(bucketName).file(key).delete();
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * Delete every object under `prefix` (a city's `proofs/{groupId}/`, or one
 * member's `proofs/{groupId}/{uid}/`). Used when a city or an account is
 * deleted — the privacy policy promises photos go with them. Throws on
 * failure so the caller doesn't report a deletion that left photos behind.
 */
export async function deleteProofPrefix(prefix: string, bucketName: string): Promise<void> {
  if (!prefix.startsWith("proofs/") || !prefix.endsWith("/")) {
    // Guard against a malformed prefix ever widening the delete.
    throw new Error(`refusing to delete unscoped prefix: ${prefix}`);
  }
  await getStorage().bucket(bucketName).deleteFiles({ prefix, force: true });
}
