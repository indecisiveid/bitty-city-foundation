/**
 * Expo push transport.
 *
 * We send through Expo's push service rather than talking to APNs/FCM
 * directly: the app registers an Expo push token, and the backend POSTs
 * messages to https://exp.host/--/api/v2/push/send. Expo fans out to APNs
 * (and Android/FCM later) for us, so the only per-platform credential is the
 * APNs key uploaded to Expo via `eas credentials` — no FCM admin wiring here.
 *
 * This module is deliberately thin and side-effecting: it knows how to talk
 * to Expo and which tokens Expo rejected. Deciding *who* to notify lives in
 * notify.ts; deciding *when* lives in the handlers / scheduler.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Expo accepts up to 100 messages per request.
const CHUNK = 100;

export interface PushPayload {
  title: string;
  body: string;
  /** Arbitrary data delivered to the app (e.g. `{ group_id, group_name }`
   *  so a tap can deep-link to the city). */
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** An Expo push token looks like `ExponentPushToken[xxxxxxxx]`. */
export function isExpoPushToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["))
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Send one payload to many tokens. Returns the subset of tokens Expo reports
 * as permanently invalid (`DeviceNotRegistered`) so the caller can prune them
 * from the user docs. Network / transient errors are swallowed and logged —
 * a failed notification must never break the game action that triggered it.
 */
export async function sendPush(
  tokens: string[],
  payload: PushPayload,
): Promise<string[]> {
  const valid = [...new Set(tokens.filter(isExpoPushToken))];
  if (valid.length === 0) return [];

  const invalid: string[] = [];

  for (const group of chunk(valid, CHUNK)) {
    const messages = group.map((to) => ({
      to,
      sound: "default" as const,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        console.error("[push] Expo responded", res.status, await res.text());
        continue;
      }

      const json = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];
      tickets.forEach((ticket, i) => {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          invalid.push(group[i]);
        }
      });
    } catch (err) {
      console.error("[push] send failed", err);
    }
  }

  return invalid;
}
