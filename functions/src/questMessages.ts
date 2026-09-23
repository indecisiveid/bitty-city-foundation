/**
 * PURE — every word a quest says, on every surface: the push when it's
 * offered, when it moves, on its last day, when it's won; the clause the
 * daily reminders add; and the title/objective the app's quest card shows
 * (copied onto the quest so the app never re-derives rules).
 *
 * Copy rules (Christian's): state the fact, no explanation; name people.
 */
import { withArticle } from "./buildings";
import { labelFor } from "./buildCatalog";
import { Quest, QuestId } from "./quests";
import type { Notice } from "./eventMessages";

export const QUEST_TITLE: Record<QuestId, string> = {
  invite_bonus: "Invite friends bonus!",
  promotion: "Incoming Promotion!",
  material_sale: "Material Sale!",
  comeback: "The crew misses you",
};

const EMOJI: Record<QuestId, string> = { invite_bonus: "🎁", promotion: "📈", material_sale: "🏷️", comeback: "👋" };

const TIER_NAME = { easy: "Easy", medium: "Medium", challenge: "Challenge" } as const;

const bricks = (n: number) => `${n} bricks`;

/** The reward, as a phrase: "a Row House + 100 bricks". */
export function rewardPhrase(q: Quest): string {
  const parts: string[] = [];
  if (q.reward.build) parts.push(withArticle(labelFor(q.reward.build)));
  if (q.reward.bonus_same_build) parts.push("a second building free");
  if (q.reward.hard_hats) parts.push(q.reward.hard_hats === 1 ? "a hard hat" : `${q.reward.hard_hats} hard hats`);
  if (q.reward.bricks) parts.push(bricks(q.reward.bricks));
  return parts.join(" + ");
}

/** What to do — one sentence, for the card and the offer push. */
export function objectiveOf(q: Quest): string {
  switch (q.id) {
    case "invite_bonus":
      return `Invite a friend and complete a day together to win ${rewardPhrase(q)}.`;
    case "promotion":
      return `Land a 3-day build and get ${rewardPhrase(q)}.`;
    case "material_sale":
      return `${TIER_NAME[q.peek?.tier ?? "medium"]} builds are open to you, at ${q.peek?.days ?? 2} days each. Land one for ${rewardPhrase(q)}.`;
    case "comeback":
      return `Complete one day together to earn ${rewardPhrase(q)}.`;
  }
}

/** The line under the objective as it moves along. */
export function progressLineOf(q: Quest): string {
  if (q.status === "completed") return "Complete!";
  if (q.status === "expired") return "Ended";
  switch (q.id) {
    case "invite_bonus":
      return q.progress.step >= 1 ? `${q.progress.joined ?? "A friend"} joined — now complete a day together` : "Waiting for a friend to join";
    case "promotion":
      return q.progress.step >= 1 ? "Build under way" : "Pick a 3-day build";
    case "material_sale":
      return q.progress.step >= 1 ? "Sale build under way" : `Pick a ${TIER_NAME[q.peek?.tier ?? "medium"]} build`;
    case "comeback":
      return "One day to go";
  }
}

const weekday = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

function base(q: Quest, cityName: string, event: string, category: "quest" | "winback", variant: string) {
  return {
    data: { quest: q.key, city: cityName },
    meta: { type: `quest_${event}`, category, priority: "normal" as const, variant, dedupeKey: `quest:${q.key}:${event}` },
  };
}

/** A quest was offered. The comeback offer is the one winback message. */
export function questOfferedNotice(q: Quest, cityName: string): Notice {
  const winback = q.id === "comeback";
  return {
    title: `${EMOJI[q.id]} ${QUEST_TITLE[q.id]}`,
    body: winback
      ? `${cityName} misses you. ${objectiveOf(q)}`
      : `${objectiveOf(q)} Ends ${weekday(q.ends_on)}.`,
    ...base(q, cityName, "offered", winback ? "winback" : "quest", `quest_offered.${q.id}.v1`),
  };
}

/** Invite: the friend joined. */
export function questProgressNotice(q: Quest, cityName: string): Notice | null {
  if (q.id !== "invite_bonus" || !q.progress.joined) return null;
  return {
    title: `👋 ${q.progress.joined} joined ${cityName}`,
    body: `Complete a day together to win ${rewardPhrase(q)}.`,
    ...base(q, cityName, "progress", "quest", "quest_progress.invite_bonus.v1"),
  };
}

export function questEndingNotice(q: Quest, cityName: string): Notice {
  return {
    title: `⏳ Last day: ${QUEST_TITLE[q.id]}`,
    body: `${objectiveOf(q)}`,
    ...base(q, cityName, "ending", q.id === "comeback" ? "winback" : "quest", `quest_ending.${q.id}.v1`),
  };
}

export function questCompletedNotice(q: Quest, cityName: string, placedBuild: string | null): Notice {
  const won: string[] = [];
  if (placedBuild) won.push(withArticle(labelFor(placedBuild)));
  if (q.reward.hard_hats) won.push(q.reward.hard_hats === 1 ? "a hard hat" : `${q.reward.hard_hats} hard hats`);
  if (q.reward.bricks) won.push(`${bricks(q.reward.bricks)} each`);
  return {
    title: `🏆 ${QUEST_TITLE[q.id].replace(/!$/, "")} complete`,
    body: `${cityName} won ${won.join(" + ")}.`,
    ...base(q, cityName, "completed", "quest", `quest_completed.${q.id}.v1`),
  };
}

/** Appended to a daily reminder while a quest runs: the stake, in one clause. */
export function questReminderClause(q: Quest | null, today: string): string {
  if (!q || q.status !== "active" || today > q.ends_on) return "";
  const when = q.ends_on === today ? "ends today" : "is on";
  return ` The ${QUEST_TITLE[q.id].replace(/!$/, "")} ${when}.`;
}

/** The quest with the words the app shows — refreshed on every write. */
export function withDisplay(q: Quest): Quest {
  return {
    ...q,
    display: { title: QUEST_TITLE[q.id], objective: objectiveOf(q), progress: progressLineOf(q), reward: rewardPhrase(q) },
  };
}
