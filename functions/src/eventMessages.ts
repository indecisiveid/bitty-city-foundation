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
import { HealthReading, ProofStatus } from "./proofs";
import { commentPreview } from "./comments";

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
 * A new proof source (Strava, …) is one line here — the push reads "Tom
 * finished with Strava" without touching the copy below. A shared Health
 * reading has its own headline (the numbers are the news); one kept private,
 * like a skip, reads as a plain finish — the push never says there was no proof.
 */
export const PROOF_SOURCES: Partial<Record<ProofStatus, { emoji: string; via: string }>> = {
  photo: { emoji: "📸", via: "a photo" },
};

/** "a" or "an" before a number as it's spoken: an 8.2 km run, an 11-min walk, an 80-min ride. */
export function articleForNumber(n: number | string): "a" | "an" {
  const digits = String(n).split(".")[0];
  if (digits.startsWith("8")) return "an";
  // eleven, eighteen — and eleven/eighteen thousand
  if (/^(11|18)$/.test(digits) || /^(11|18)\d{3}$/.test(digits)) return "an";
  return "a";
}

/** The headline for a shared Health reading — the numbers are the news. */
export function healthReadingTitle(name: string, health: HealthReading): string {
  switch (health.metric) {
    case "steps":
      return `👟 ${name} hit ${health.value.toLocaleString("en-US")} steps`;
    case "exercise_minutes":
      return `⏱ ${name} got ${health.value} min of exercise`;
    case "workout": {
      const activityLabel = (health.workout?.activity ?? "workout").toLowerCase();
      const km = health.workout?.km;
      const minutes = health.workout?.minutes ?? health.value;
      return km !== undefined
        ? `🏃 ${name} logged ${articleForNumber(km)} ${km} km ${activityLabel}`
        : `🏃 ${name} logged ${articleForNumber(minutes)} ${minutes}-min ${activityLabel}`;
    }
    case "mindful_minutes":
      return `🧘 ${name} did ${health.value} mindful minutes`;
  }
}

/**
 * A teammate finished. Sent to the members still pending, and only for the
 * first finisher of the day or when one person is left (`last`) — see
 * completeGoal. Carries the Send kudos button: everyone on the list has NOT
 * completed and `completedName` has, exactly the precondition sendKudos
 * enforces. With shared proof the title says how, and a tap opens that day's
 * proof (`proof_date`).
 */
export function teammateCompletedNotice(
  cityName: string,
  completedName: string,
  proof?: { status: ProofStatus; date: string; health?: HealthReading | null } | null,
  last = false,
): Notice {
  const health = proof?.status === "health" ? proof.health ?? null : null;
  const source = proof ? PROOF_SOURCES[proof.status] : undefined;
  const shared = health ? "health" : source ? proof!.status : null;
  const meta: NoticeMeta = {
    type: "teammate_completed",
    category: "social",
    priority: "transactional",
    variant: `teammate_completed.${last ? "last" : "first"}${shared ? `.${shared}` : ""}.v2`,
  };
  return {
    title: health
      ? healthReadingTitle(completedName, health)
      : source
        ? `${source.emoji} ${completedName} finished with ${source.via}`
        : `✅ ${completedName} finished`,
    body: last ? `You're the last one in ${cityName}.` : `Your turn in ${cityName}.`,
    categoryId: NotificationCategory.TEAMMATE_COMPLETED,
    data: { completed_by: completedName, ...(shared ? { proof_date: proof!.date } : {}) },
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

/**
 * Someone commented on your proof — a person acted on you, like kudos. The
 * body is the comment itself (first line, trimmed to fit); a tap opens that
 * day's proof scrolled to yours (`proof_date` + `proof_member`).
 */
export function proofCommentNotice(fromName: string, text: string, date: string, owner: string): Notice {
  return {
    title: `💬 ${fromName} commented on your proof`,
    body: commentPreview(text),
    data: { from: fromName, proof_date: date, proof_member: owner },
    meta: { type: "proof_comment", category: "social", priority: "transactional", variant: "proof_comment.v1" },
  };
}

/**
 * Someone else commented under a proof you already commented on. Not about
 * you, so `normal` — it only goes out while the day still has a spare slot.
 */
export function threadCommentNotice(fromName: string, owner: string, text: string, date: string): Notice {
  return {
    title: `💬 ${fromName} on ${owner}’s proof`,
    body: commentPreview(text),
    data: { from: fromName, proof_date: date, proof_member: owner },
    meta: { type: "proof_comment_thread", category: "social", priority: "normal", variant: "proof_comment_thread.v1" },
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
