/**
 * The 30-minute tick: day rollover first, then the daily nudges.
 *
 * DAY ROLLOVER (`runDayRollover`). End-of-day processing used to be purely
 * lazy — it ran only when a callable touched the group, i.e. when someone
 * opened the app. On iOS nothing runs in the background, so a city whose
 * reset time passed while its crew sat on Home, in another city, or with the
 * app closed simply stayed on yesterday's state; and whoever eventually
 * tapped in was the one who triggered the pass, so THEY got the "build
 * stalled" push about the screen they were already looking at. The server
 * now owns the clock: every tick settles every city whose boundary has
 * passed, the live Firestore listeners carry the new state to every card, and
 * the boundary pushes go to the whole crew within 30 minutes of reset time.
 * The callables keep their nudge as a fallback for that half-hour gap; the
 * pass is transactional, so the two can never double-settle a day.
 *
 * Rollover runs BEFORE the nudges on purpose: a nudge decided against an
 * unsettled doc would say "Day 2 of 3" about a build that actually stalled at
 * the boundary, or warn about a streak the pass is about to freeze.
 *
 * NUDGES (`runNudges`): goal reminders + streak-at-risk + meteor warning,
 * escalated by urgency in reminderLogic.
 *
 * Each group has its own timezone, so a single global
 * tick can't "be 8am" for everyone at once — instead every run asks each group
 * "is it one of your nudge slots right now?" (decideNudge), and only the
 * matching slot fires. A per-slot guard (`reminders_sent_slots`, scoped to
 * `reminders_sent_date`) keeps it to one send per slot per game-day even if a
 * run is retried.
 *
 * A deleted city stops nudging for free: this scans the live `groups`
 * collection, and deleteGroup removes the doc, so its scheduled notifications
 * simply cease to exist.
 *
 * Sending is inverted at the end: pass 1 decides city by city and enrols
 * recipients into a uid → cities map, pass 2 sends ONE consolidated push per
 * person (see nudgeMessages.consolidate). Deciding stays per-city because
 * timezone, streak and crew are per-city; only delivery is per-person.
 *
 * Pass 2 is also where a PERSON's own state gates the send (reminderTiers):
 * someone who hasn't opened the app in a week gets at most one push a day,
 * and after two weeks one farewell and then silence. The per-city slot claim
 * in pass 1 is unaffected — it records what the city decided, not what each
 * member ended up hearing.
 *
 * Scope note: this scans every group each tick. Fine at launch scale; if the
 * group count grows large, precompute a `next_nudge_at` field and query on it
 * instead of scanning.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { getProcessingDate, daysBetween } from "./gameLogic";
import { decideNudge, SlotId } from "./reminderLogic";
import { loadUsers, notifySnaps, recordSent, uidsForNames } from "./notify";
import { NoticeMeta } from "./notices";
import { buildProgressOf, landingTodayLabel } from "./buildings";
import { consolidate, farewellMessage, NudgeEntry } from "./nudgeMessages";
import { applyUserTier, reminderStateOf, sentTodayOf, tierFor } from "./reminderTiers";
import { idleDaysFor } from "./presence";
import { activeMembersOn, isDayPaused, rosterOf } from "./pauses";
import { normalizeGameMode } from "./gameMode";
import { dueForDayProcessing, maybeProcessDay } from "./groupHandlers";

// Re-exported: the copy moved to nudgeMessages.ts, callers and tests did not.
export { messageFor } from "./nudgeMessages";

const db = () => getFirestore();

/**
 * The cities whose day boundary has passed since their last pass.
 *
 * Today this is a full scan filtered in memory — the same scan the nudges do,
 * fine at launch scale. This is the seam for growth: when the group count
 * makes a scan slow, stamp a `next_boundary_at` timestamp on each doc at the
 * end of every pass and replace the body with a `where("next_boundary_at",
 * "<=", now)` query. Nothing else needs to change.
 */
async function groupsDueForRollover(): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const snap = await db().collection("groups").get();
  return snap.docs.filter((doc) => dueForDayProcessing(doc.data()));
}

/**
 * Settle every city that is due. Each pass sends its own pushes (city grew,
 * build stalled) exactly as the callable path does — the trigger is the only
 * thing that changed. A failure on one city is logged and never stops the
 * rest; the next tick simply tries it again.
 */
export async function runDayRollover(): Promise<{ due: number; settled: number }> {
  const due = await groupsDueForRollover();
  let settled = 0;
  await Promise.all(
    due.map(async (doc) => {
      try {
        const after = await maybeProcessDay(doc.id, doc.data());
        if (after.last_processed_date !== doc.data().last_processed_date) settled++;
      } catch (err) {
        console.error("[rollover] failed", doc.id, err);
      }
    }),
  );
  if (due.length > 0) console.log("[rollover]", { due: due.length, settled });
  return { due: due.length, settled };
}

/**
 * `now` is injectable for tests; production passes the tick time. Every
 * timezone/game-date computation below derives from it, never from the wall
 * clock directly, so a test can pin "it is 17:35 in New York".
 */
export async function runNudges(now: Date = new Date()): Promise<void> {
  const snap = await db().collection("groups").get();

  // uid → every city that owes this person a nudge on this tick. Filled by the
  // per-city pass below, drained by the per-person pass after it. This map is
  // the whole point: without it each city sends on its own and a person in
  // three cities gets three near-identical pushes.
  const byUid = new Map<string, NudgeEntry[]>();
  const add = (uid: string, entry: NudgeEntry) => {
    const list = byUid.get(uid);
    if (list) list.push(entry);
    else byUid.set(uid, [entry]);
  };

  // --- Pass 1: decide, city by city. Claims each slot, sends nothing. -------
  await Promise.all(
    snap.docs.map(async (doc) => {
      const data = doc.data();
      const tz: string = data.goal_reset_timezone ?? "UTC";
      const local = DateTime.fromJSDate(now).setZone(tz);
      if (!local.isValid) return;

      const todayGameDate = getProcessingDate(data.goal_reset_time ?? "00:00", tz, now);
      // Vacation mode: a paused city has nothing to nudge about (and its
      // meteor can't fall, so no warning either), and a member on vacation
      // is neither reminded nor counted against the crew.
      const roster = rosterOf(data);
      if (isDayPaused(roster, todayGameDate)) return;
      const members: string[] = activeMembersOn(roster, todayGameDate);
      const completions: string[] = (data.completions_today ?? []).filter((m: string) =>
        members.includes(m),
      );
      const lastActivity: string | null = data.last_activity_date ?? null;
      const lastMeteor: string | null = data.last_inactivity_meteor_date ?? null;
      const sentDate: string | null = data.reminders_sent_date ?? null;
      const sentSlots: SlotId[] = data.reminders_sent_slots ?? [];

      const nudge = decideNudge({
        localMinutes: local.hour * 60 + local.minute,
        todayGameDate,
        remindersSentDate: sentDate,
        remindersSentSlots: sentSlots,
        memberCount: members.length,
        completedCount: completions.length,
        streak: data.streak ?? 0,
        idleDays: lastActivity ? daysBetween(lastActivity, todayGameDate) : null,
        daysSinceMeteor: lastMeteor ? daysBetween(lastMeteor, todayGameDate) : null,
        gameMode: normalizeGameMode(data.game_mode),
      });

      if (!nudge) return;

      // Record the slot first so a retry of this run can't double-send. When
      // the stored list belongs to an older game-date, start it fresh. This
      // stays per-city: consolidation changes who receives, never who decides.
      const slotsForToday =
        sentDate === todayGameDate ? [...sentSlots, nudge.slot] : [nudge.slot];
      await doc.ref.update({
        reminders_sent_date: todayGameDate,
        reminders_sent_slots: slotsForToday,
        // Legacy single-nudge field, no longer read. Drop it as we touch docs.
        last_reminder_date: FieldValue.delete(),
      });

      const incomplete = members.filter((m) => !completions.includes(m));
      const cityName = data.group_name ?? "your city";
      const ctx = {
        cityName,
        streak: data.streak ?? 0,
        build: buildProgressOf(data.current_build),
        pendingNames: incomplete,
        // Completion order, so "Amit already checked in" names the first one in.
        completedNames: completions,
        landsToday: landingTodayLabel(data.current_build),
      };
      const base = { groupId: doc.id, cityName, nudge, ctx, gameDate: todayGameDate };

      // The meteor is about the CITY, not about who owes what, so the whole
      // crew is enrolled with the identical warning.
      if (nudge.kind === "meteor") {
        for (const uid of uidsForNames(data, members)) {
          add(uid, { ...base, role: "pending" });
        }
        return;
      }

      for (const uid of uidsForNames(data, incomplete)) {
        add(uid, { ...base, role: "pending" });
      }

      // At last call the members who are DONE are enrolled too — they're the
      // only ones who can still save the day by chasing whoever is late.
      if (nudge.recipients === "all") {
        const done = members.filter((m) => completions.includes(m));
        for (const uid of uidsForNames(data, done)) {
          add(uid, { ...base, role: "done" });
        }
      }
    }),
  );

  // --- Pass 2: one push per person, however many cities they hold. ---------
  // One batched read of every recipient's user doc: tokens, presence and the
  // per-person reminder state all live there.
  const users = await loadUsers([...byUid.keys()]);
  await Promise.all(
    [...byUid.entries()].map(async ([uid, entries]) => {
      const userSnap = users.get(uid);
      const user = userSnap?.data() ?? {};
      const tier = tierFor(idleDaysFor(user, now));
      const state = reminderStateOf(user.reminders);
      // A person in cities on different clocks: key the daily cap on the date
      // of the city that woke them this tick. Good enough at this scale.
      const todayDate = entries[0].gameDate ?? now.toISOString().slice(0, 10);
      const decision = applyUserTier(entries, tier, state, todayDate);
      if (decision.action === "skip") return;

      const sentToday = sentTodayOf(state, todayDate);
      if (decision.action === "farewell") {
        const cities = [...new Set(entries.map((e) => e.cityName))];
        const meta: NoticeMeta = { type: "farewell", category: "reminder", priority: "normal", variant: "farewell.v1" };
        const single: Partial<ReturnType<typeof cityContext>> = entries.length === 1 ? cityContext(entries[0]) : {};
        if (userSnap) {
          await notifySnaps([userSnap], {
            ...farewellMessage(cities),
            threadId: single.threadId,
            data: { ...(single.data ?? {}), type: meta.type, variant: meta.variant },
          });
          await recordSent(userSnap, meta, todayDate);
        }
        await recordReminder(userSnap, {
          date: todayDate,
          sent: sentToday + 1,
          farewell_sent_at: Timestamp.fromDate(now),
        });
        return;
      }

      const payload = consolidate(decision.entries);
      if (!payload) return;
      const meta = reminderMeta(decision.entries);
      if (userSnap) {
        // One city: stack it with that city's other notifications on iOS and
        // let a tap open it (the multi-city push lands on Home by design).
        const single: Partial<ReturnType<typeof cityContext>> =
          decision.entries.length === 1 ? cityContext(decision.entries[0]) : {};
        await notifySnaps([userSnap], {
          ...payload,
          threadId: single.threadId,
          data: { ...(payload.data ?? {}), ...(single.data ?? {}), type: meta.type, variant: meta.variant },
        });
        await recordSent(userSnap, meta, todayDate);
      }
      await recordReminder(userSnap, { date: todayDate, sent: sentToday + 1 });
    }),
  );
}

/** The same city context event pushes carry (notify.withGroupData). */
function cityContext(e: NudgeEntry): { threadId: string; data: Record<string, string> } {
  return { threadId: e.groupId, data: { group_id: e.groupId, group_name: e.cityName } };
}

/**
 * Label a reminder push for the ledger and for `data.variant`: which slot,
 * which kind, and whether it was the last-call chaser — so push opens can be
 * compared the same way widget taps are.
 */
export function reminderMeta(entries: NudgeEntry[]): NoticeMeta {
  const base = { type: "reminder", category: "reminder" as const, priority: "normal" as const };
  if (entries.length === 1) {
    const e = entries[0];
    return { ...base, variant: `reminder.${e.nudge.slot}.${e.nudge.kind}${e.role === "done" ? ".chaser" : ""}` };
  }
  const rank = { meteor: 3, streak: 2, reminder: 1 } as const;
  const worst = entries.reduce((a, b) => (rank[b.nudge.kind] > rank[a.nudge.kind] ? b : a));
  return { ...base, variant: `reminder.multi.${worst.nudge.kind}` };
}

/** Persist what this person was sent today (`users/{uid}.reminders`). Best-effort. */
async function recordReminder(
  userSnap: FirebaseFirestore.DocumentSnapshot | undefined,
  fields: Record<string, unknown>,
): Promise<void> {
  // No user doc means no tokens and nothing to cap; don't conjure one.
  if (!userSnap?.exists) return;
  try {
    await userSnap.ref.set({ reminders: fields }, { merge: true });
  } catch (err) {
    console.error("[nudge] recordReminder failed", userSnap.id, err);
  }
}

// Every 30 minutes — the :30 slots (11:30, 17:30) need half-hour granularity.
// The per-group timezone math inside decides who actually fires.
//
// Still exported as `dailyNudge`: that is the deployed function's name, and
// renaming it would deploy a second scheduler beside the old one.
export const dailyNudge = onSchedule(
  { schedule: "every 30 minutes", timeoutSeconds: 300, memory: "256MiB" },
  async () => {
    await runDayRollover();
    await runNudges(new Date());
  },
);
