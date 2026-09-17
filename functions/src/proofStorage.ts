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
import { defineString } from "firebase-functions/params";

export const PROOFS_BUCKET_DEFAULT = "bitty-city.firebasestorage.app";
export const proofsBucket = defineString("PROOFS_BUCKET", { default: PROOFS_BUCKET_DEFAULT });

/** Size in bytes, or null when the object doesn't exist. */
export async function proofObjectSize(key: string, bucketName: string): Promise<number | null> {
  const f = getStorage().bucket(bucketName).file(key);
  const [exists] = await f.exists();
  if (!exists) return null;
  const [meta] = await f.getMetadata();
  return Number(meta.size ?? 0);
}

export async function deleteProofObject(key: string, bucketName: string): Promise<void> {
  try {
    await getStorage().bucket(bucketName).file(key).delete();
  } catch (err) {
    if ((err as { code?: number }).code === 404) return;
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
