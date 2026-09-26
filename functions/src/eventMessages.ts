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
        body: `Your crew restored ${withArticle(label)}. Come see it in the city.`,
        meta: crew("city_grew", "city_grew.restored.v1"),
      }
    : {
        title: `🏙️ ${cityName} grew!`,
        body: `Your crew finished ${withArticle(label)}. Come see it in the city.`,
        meta: crew("city_grew", "city_grew.v1"),
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
 * "Tom completed today's goal. Your turn!" — to the members still pending.
 * Carries the Send kudos button: everyone on this list has NOT completed and
 * `completedName` has, exactly the precondition sendKudos enforces.
 *
 * With a photo (`proofDate` = the game day it belongs to) the push says so and
 * carries `proof_date`, so a tap opens that day's proof instead of just the
 * city — the photo is the news, not the checkmark.
 */
export function teammateCompletedNotice(cityName: string, completedName: string, proofDate?: string | null): Notice {
  const meta: NoticeMeta = {
    type: "teammate_completed",
    category: "social",
    priority: "transactional",
    variant: proofDate ? "teammate_completed.photo.v1" : "teammate_completed.v1",
  };
  return proofDate
    ? {
        title: `📸 ${completedName} posted proof`,
        body: `${completedName} finished today's goal in ${cityName}.`,
        categoryId: NotificationCategory.TEAMMATE_COMPLETED,
        data: { completed_by: completedName, proof_date: proofDate },
        meta,
      }
    : {
        title: cityName,
        body: `${completedName} completed today's goal. Your turn!`,
        categoryId: NotificationCategory.TEAMMATE_COMPLETED,
        data: { completed_by: completedName },
        meta,
      };
}

/**
 * The same photo, to crewmates who already finished today. Nothing is asked
 * of them, so it's `normal` (budgeted) social, not transactional, and it has
 * no kudos button — they can cheer from the crew list, where the photo is.
 */
export function proofPostedNotice(cityName: string, completedName: string, proofDate: string): Notice {
  return {
    title: `📸 ${completedName} posted proof`,
    body: `${completedName} finished today's goal in ${cityName}. Tap to see the photo.`,
    data: { completed_by: completedName, proof_date: proofDate },
    meta: { type: "proof_posted", category: "social", priority: "normal", variant: "proof_posted.v1" },
  };
}

export function nextUpNotice(cityName: string, pickerName: string, label: string, days: number): Notice {
  const span = days === 1 ? "Today's goal builds it." : `It takes ${days} days of everyone completing their goal.`;
  return {
    title: `🏗️ Next up: ${withArticle(label)}`,
    body: `${pickerName} picked ${withArticle(label)} for ${cityName}. ${span}`,
    meta: crew("next_up", "next_up.v1"),
  };
}

export function restoreSpan(days: number): string {
  return days === 1
    ? "Today's goal restores it."
    : `It takes ${days} days of everyone completing their goal.`;
}

export function restoringNotice(
  what: "building" | "park",
  cityName: string,
  repairerName: string,
  label: string,
  days: number,
): Notice {
  return what === "park"
    ? {
        title: `🌳 Restoring ${withArticle(label)}`,
        body: `${repairerName} is fixing up ${withArticle(label)} in ${cityName}. ${restoreSpan(days)}`,
        meta: crew("restoring", "restoring.park.v1"),
      }
    : {
        title: `🧱 Restoring ${withArticle(label)}`,
        body: `${repairerName} is putting ${withArticle(label)} back up in ${cityName}. ${restoreSpan(days)}`,
        meta: crew("restoring", "restoring.building.v1"),
      };
}

export function buildRescuedNotice(label: string, rescuerName: string): Notice {
  return {
    title: `🪖 The ${label} build is back on`,
    body: `${rescuerName} used a hard hat to save it. Finish today's goal to keep it moving.`,
    meta: crew("build_rescued", "build_rescued.v1"),
  };
}

export function streakRepairedNotice(restoredValue: number, repairerName: string, label: string | null): Notice {
  return {
    title: `🧊 ${restoredValue}-day streak repaired`,
    body: label
      ? `${repairerName} used a hard hat to bring back your streak and your ${label} build. Finish today's goal to keep it moving.`
      : `${repairerName} used a hard hat to bring back your streak.`,
    meta: crew("streak_repaired", "streak_repaired.v1"),
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
