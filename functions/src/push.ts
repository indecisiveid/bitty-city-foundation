/**
 * Firebase Cloud Messaging transport.
 *
 * The app registers an FCM registration token (via
 * @react-native-firebase/messaging, which exchanges the iOS APNs token for an
 * FCM token) and stores it on its user doc. Here we fan a payload out to those
 * tokens with the firebase-admin Messaging SDK — no third-party push service,
 * and the only per-platform credential is the APNs key uploaded to the
 * Firebase console.
 *
 * This module is deliberately thin and side-effecting: it knows how to talk to
 * FCM and which tokens FCM rejected. Deciding *who* to notify lives in
 * notify.ts; deciding *when* lives in the handlers / scheduler.
 */
import { getMessaging } from "firebase-admin/messaging";

// sendEachForMulticast accepts up to 500 tokens per call.
const CHUNK = 500;

// FCM error codes that mean the token is permanently dead → prune it.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

export interface PushPayload {
  title: string;
  body: string;
  /** Arbitrary data delivered to the app (e.g. `{ group_id, group_name }`
   *  so a tap can deep-link to the city). FCM data values must be strings. */
  data?: Record<string, unknown>;
}

/** FCM registration tokens are opaque, non-empty strings. */
export function isValidPushToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length < 4096;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** FCM requires string data values. */
function stringifyData(data?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Send one payload to many tokens. Returns the subset of tokens FCM reports as
 * permanently invalid so the caller can prune them from the user docs.
 * Transient / network errors are logged and swallowed — a failed notification
 * must never break the game action that triggered it.
 */
export async function sendPush(
  tokens: string[],
  payload: PushPayload,
): Promise<string[]> {
  const valid = [...new Set(tokens.filter(isValidPushToken))];
  if (valid.length === 0) return [];

  const invalid: string[] = [];
  const data = stringifyData(payload.data);

  for (const group of chunk(valid, CHUNK)) {
    try {
      const res = await getMessaging().sendEachForMulticast({
        tokens: group,
        notification: { title: payload.title, body: payload.body },
        data,
        apns: {
          payload: {
            aps: {
              // Explicit alert so APNs always renders a visible banner — a bare
              // `aps` with only `sound` can produce a silent (no-alert) push
              // that FCM still reports as "success".
              alert: { title: payload.title, body: payload.body },
              sound: "default",
            },
          },
        },
      });

      if (res.failureCount > 0) {
        console.log("[push] sent", {
          success: res.successCount,
          failure: res.failureCount,
        });
      }

      res.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code ?? "";
        if (DEAD_TOKEN_CODES.has(code)) {
          invalid.push(group[i]);
        } else {
          console.error("[push] send error", code, r.error?.message);
        }
      });
    } catch (err) {
      console.error("[push] sendEachForMulticast failed", err);
    }
  }

  return invalid;
}
