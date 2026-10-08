/**
 * PURE — the copy for every push that isn't a scheduled reminder, each one a
 * complete Notice: words + what kind of notice it is (notices.ts). These used
 * to be built inline in the handlers, untested and unlabelled; the label is
 * what lets the policy budget them and the app route and measure a tap.
 *
 * `variant` names the exact wording. When copy changes meaningfully, give it
 * a new variant id rather than editing the old one in place, so open rates
 * stay comparable.
 */
import { PushPayload, NotificationCategory } from "./push";
import { NoticeMeta } from "./notices";
import { withArticle } from "./buildings";
import { ProofStatus } from "./proofs";

export type Notice = PushPayload & { meta: NoticeMeta };

/** Wrap copy from another pure module (crewMessages, gameMode) with its meta. */
export function notice(copy: { title: string; body: string }, meta: NoticeMeta): Notice {
  return { ...copy, meta };
}

const crew = (type: string, variant: string, priority: NoticeMeta["priority"] = "normal"): NoticeMeta => ({
  type,
  category: "crew",
  priority,
  variant,
});

export function cityGrewNotice(cityName: string, label: string, restored: boolean): Notice {
  return restored
    ? {
        title: `🧱 ${cityName} is whole again`,
        body: `Your crew restored ${withArticle(label)}.`,
        meta: crew("city_grew", "city_grew.restored.v2"),
      }
    : {
        title: `🏙️ ${cityName} grew!`,
        body: `Your crew built ${withArticle(label)}.`,
        meta: crew("city_grew", "city_grew.v2"),
      };
}

/**
 * A build lost a day with no hard hat to cover it. Hard mode doesn't name the
 * easy-mode switch: 1.2 and older can't save a build that way, so the push
 * would promise what their app can't do.
 */
export function buildStalledNotice(label: string, mode: "easy" | "hard"): Notice {
  const why = mode === "easy" ? "Nobody finished yesterday." : "Not everyone finished yesterday.";
  return {
    title: `🚧 ${label} stalled`,
    body:
      mode === "hard"
        ? `${why} No hard hats left. Open the city today to see your options.`
        : `${why} No hard hats left. Pick a new build.`,
    meta: crew("build_stalled", `build_stalled.${mode}.v1`, "important"),
  };
}

/**
 * How a finish was proven, as the push says it: "Tom finished with a photo".
 * A new proof source (Apple Health, Strava, …) is one line here — the push
 * reads "Tom finished with Strava" without touching the copy below.
 */
export const PROOF_SOURCES: Partial<Record<ProofStatus, { emoji: string; via: string }>> = {
  photo: { emoji: "📸", via: "a photo" },
};

/**
 * A teammate finished. Sent to the members still pending, and only for the
 * first finisher of the day or when one person is left (`last`) — see
 * completeGoal. With proof the title says how, and a tap opens that day's
 * proof (`proof_date`).
 */
export function teammateCompletedNotice(
  cityName: string,
  completedName: string,
  proof?: { status: ProofStatus; date: string } | null,
  last = false,
): Notice {
  const source = proof ? PROOF_SOURCES[proof.status] : undefined;
  const meta: NoticeMeta = {
    type: "teammate_completed",
    category: "social",
    priority: "transactional",
    variant: `teammate_completed.${last ? "last" : "first"}${source ? `.${proof!.status}` : ""}.v2`,
  };
  return {
    title: source ? `${source.emoji} ${completedName} finished with ${source.via}` : `✅ ${completedName} finished`,
    body: last ? `You're the last one in ${cityName}.` : `Your turn in ${cityName}.`,
    categoryId: NotificationCategory.TEAMMATE_COMPLETED,
    data: { completed_by: completedName, ...(source ? { proof_date: proof!.date } : {}) },
    meta,
  };
}

export function kudosNotice(fromName: string): Notice {
  return {
    title: "❤️ Kudos!",
    body: `${fromName} sent you kudos!`,
    data: { from: fromName },
    meta: { type: "kudos", category: "social", priority: "transactional", variant: "kudos.v1" },
  };
}

export function peerNudgeNotice(fromName: string, body: string): Notice {
  return {
    title: "⏰ Nudge!",
    body,
    data: { from: fromName },
    meta: { type: "nudge", category: "social", priority: "transactional", variant: "nudge.v1" },
  };
}

export function testNotice(): Notice {
  return {
    title: "Bitty City",
    body: "🎉 Test notification — push is working!",
    data: { test: "true" },
    meta: { type: "test", category: "system", priority: "transactional", variant: "test.v1" },
  };
}
