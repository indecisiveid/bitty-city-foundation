/**
 * Quests, the I/O half (the rules are pure, in quests.ts; the words in
 * questMessages.ts). Three jobs:
 *
 *  1. `runQuests` — on every 30-minute tick, after day rollover: settle a
 *     quest whose last day passed, roll a new one once per game day by the
 *     crew's cadence, and send "last day" notices in the evening slot.
 *  2. Helpers the callables use to advance a quest inside their own
 *     transaction (join, pick a build, check in, land).
 *  3. Paying bricks and sending the quest notices, after the write.
 *
 * Everything is off unless `config/quests.enabled` is true: the app that
 * shows a quest card has to be in people's hands before quest pushes go out.
 */
import { getFirestore } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { FREEZE_CAP, countBuildings, daysBetween, getProcessingDate } from "./gameLogic";
import { normalizeParks } from "./parks";
import { activeMembersOn, isDayPaused, rosterOf } from "./pauses";
import { applyBrickEntry } from "./bricks";
import { notifyMembers } from "./notify";
import { uidsForNames } from "./notify";
import {
  CitySignals,
  Quest,
  QuestConfig,
  QuestHistoryEntry,
  QuestTransition,
  completionUpdates,
  expireQuest,
  mergeQuestConfig,
  pushHistory,
  rollQuest,
  winRate,
} from "./quests";
import {
  questCompletedNotice,
  questEndingNotice,
  questOfferedNotice,
  questProgressNotice,
  withDisplay,
} from "./questMessages";
import type { Notice } from "./eventMessages";
import { hashString, seededRng } from "./seededRng";

const db = () => getFirestore();

/** Evening slot (mirrors reminderLogic's 17:30) — when "last day" goes out. */
const ENDING_WINDOW: [number, number] = [17 * 60 + 30, 18 * 60];

let cachedConfig: { at: number; config: QuestConfig } | null = null;

/** `config/quests` over the defaults; cached for a minute per instance. */
export async function loadQuestConfig(now = Date.now()): Promise<QuestConfig> {
  if (cachedConfig && now - cachedConfig.at < 60_000) return cachedConfig.config;
  let raw: unknown = null;
  try {
    const snap = await db().collection("config").doc("quests").get();
    raw = snap.exists ? snap.data() : null;
  } catch (err) {
    console.error("[quests] config read failed", err);
  }
  const config = mergeQuestConfig(raw);
  cachedConfig = { at: now, config };
  return config;
}

/** Test seam. */
export function __resetQuestConfigCache(): void {
  cachedConfig = null;
}

function createdOn(data: FirebaseFirestore.DocumentData): string | null {
  const c = data.created_at?.toDate?.() ?? (typeof data.created_at === "string" ? new Date(data.created_at) : null);
  return c && !isNaN(c.getTime()) ? c.toISOString().slice(0, 10) : null;
}

export function signalsFor(cityId: string, data: FirebaseFirestore.DocumentData, today: string): CitySignals {
  const roster = rosterOf(data);
  const last: string | null = data.last_activity_date ?? null;
  return {
    cityId,
    today,
    activeMembers: activeMembersOn(roster, today).length,
    buildings: countBuildings(data.city_map ?? {}, normalizeParks(data.parks)),
    winRate14: winRate(data.building_completions ?? [], today, createdOn(data)),
    idleDays: last ? Math.max(0, daysBetween(last, today)) : null,
    paused: isDayPaused(roster, today),
    hasBuild: !!data.current_build,
    quest: (data.quest as Quest) ?? null,
    history: (data.quest_history as QuestHistoryEntry[]) ?? [],
  };
}

export const questRng = (cityId: string, today: string, salt = "") => seededRng(hashString(`${cityId}|${today}|${salt}`));

/** Members who haven't dismissed this quest, by display name. */
function audience(data: FirebaseFirestore.DocumentData, q: Quest, except?: string | null): string[] {
  const names: string[] = data.group_members ?? [];
  const uids: string[] = data.member_uids ?? [];
  return names.filter((n, i) => n !== except && !q.dismissed_by.includes(uids[i]));
}

export async function sendQuestNotice(
  cityId: string,
  data: FirebaseFirestore.DocumentData,
  q: Quest,
  n: Notice | null,
  except?: string | null,
): Promise<void> {
  if (!n) return;
  await notifyMembers(cityId, data, audience(data, q, except), n);
}

/** Pay the quest's bricks to every member, once (event id = quest key). */
export async function grantQuestBricks(cityId: string, data: FirebaseFirestore.DocumentData, q: Quest): Promise<void> {
  if (!q.reward.bricks) return;
  const at = new Date().toISOString();
  await Promise.all(
    (data.member_uids ?? []).map(async (uid: string) => {
      const ref = db().collection("users").doc(uid);
      try {
        await db().runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const next = applyBrickEntry(snap.exists ? snap.data()! : null, {
            event_id: `quest:${cityId}:${q.key}`,
            amount: q.reward.bricks,
            reason: "quest",
            group_id: cityId,
            at,
          });
          if (next) tx.set(ref, next, { merge: true });
        });
      } catch (err) {
        console.error(`[quests] bricks to ${uid} for ${q.key} failed`, err);
      }
    }),
  );
}

/**
 * Inside a callable's transaction: turn a quest transition into the fields
 * to write (and, on completion, the reward on the map as it stands after
 * `stateAfter`). Returns null when nothing changed.
 */
export function questWrite(
  t: QuestTransition,
  stateAfter: FirebaseFirestore.DocumentData,
  today: string,
  landedType: string | null = null,
): { updates: Record<string, unknown>; quest: Quest; placed: string | null } | null {
  if (!t) return null;
  if (t.event !== "completed") return { updates: { quest: withDisplay(t.quest) }, quest: t.quest, placed: null };
  const done = completionUpdates(
    {
      quest: t.quest,
      cityMap: stateAfter.city_map ?? {},
      buildOrder: stateAfter.build_order ?? null,
      tileBuildDates: stateAfter.tile_build_dates ?? {},
      streakFreezes: stateAfter.streak_freezes ?? 0,
      freezeCap: FREEZE_CAP,
      history: stateAfter.quest_history ?? [],
      landedType,
      today,
    },
    questRng(t.quest.key, today, "reward"),
  );
  return { updates: { ...done.updates, quest: withDisplay(done.quest) }, quest: done.quest, placed: done.placed };
}

/** After a completed quest's write: bricks, then the whole crew hears. */
export async function afterQuestCompleted(
  cityId: string,
  data: FirebaseFirestore.DocumentData,
  q: Quest,
  placed: string | null,
): Promise<void> {
  await grantQuestBricks(cityId, data, q);
  await sendQuestNotice(cityId, data, q, questCompletedNotice(q, data.group_name ?? "your city", placed));
}

// --- the tick ---------------------------------------------------------------

export interface QuestTickResult {
  offered: number;
  expired: number;
  ending: number;
}

export async function runQuests(now: Date = new Date()): Promise<QuestTickResult> {
  const result: QuestTickResult = { offered: 0, expired: 0, ending: 0 };
  const config = await loadQuestConfig(now.getTime());
  if (!config.enabled) return result;

  const groups = await db().collection("groups").get();
  await Promise.all(
    groups.docs.map(async (doc) => {
      try {
        const data = doc.data();
        const tz: string = data.goal_reset_timezone ?? "UTC";
        const today = getProcessingDate(data.goal_reset_time ?? "00:00", tz, now);
        let offered: Quest | null = null;
        let after: FirebaseFirestore.DocumentData | null = null;

        await db().runTransaction(async (tx) => {
          const fresh = (await tx.get(doc.ref)).data();
          if (!fresh) return;
          const updates: Record<string, unknown> = {};
          let history: QuestHistoryEntry[] = fresh.quest_history ?? [];
          let quest: Quest | null = (fresh.quest as Quest) ?? null;

          const settled = expireQuest(quest, today);
          if (settled !== quest && settled) {
            history = pushHistory(history, settled);
            quest = settled;
            updates.quest = withDisplay(settled);
            updates.quest_history = history;
            result.expired++;
          }
          if (fresh.quest_rolled_on !== today) {
            updates.quest_rolled_on = today;
            const rolled = rollQuest(
              { ...signalsFor(doc.id, fresh, today), quest, history },
              config,
              questRng(doc.id, today),
            );
            if (rolled) {
              offered = rolled;
              updates.quest = withDisplay(rolled);
              result.offered++;
            }
          }
          if (Object.keys(updates).length) {
            tx.update(doc.ref, updates);
            after = { ...fresh, ...updates };
          }
        });

        const current = (after ?? data) as FirebaseFirestore.DocumentData;
        const cityName = current.group_name ?? "your city";
        if (offered) await sendQuestNotice(doc.id, current, offered, questOfferedNotice(offered, cityName));

        // "Last day" in the evening slot of the quest's final day.
        const q = current.quest as Quest | undefined;
        const local = DateTime.fromJSDate(now).setZone(tz);
        const minutes = local.isValid ? local.hour * 60 + local.minute : -1;
        if (q?.status === "active" && q.ends_on === today && minutes >= ENDING_WINDOW[0] && minutes < ENDING_WINDOW[1]) {
          await sendQuestNotice(doc.id, current, q, questEndingNotice(q, cityName));
          result.ending++;
        }
      } catch (err) {
        console.error("[quests] tick failed", doc.id, err);
      }
    }),
  );
  if (result.offered || result.expired || result.ending) console.log("[quests]", result);
  return result;
}

/** Tell the crew the invite quest moved (a friend joined). */
export async function afterQuestProgress(cityId: string, data: FirebaseFirestore.DocumentData, q: Quest, except?: string | null) {
  await sendQuestNotice(cityId, data, q, questProgressNotice(q, data.group_name ?? "your city"), except);
}

export { uidsForNames };
