/**
 * Scheduled push notifications — the daily nudges (goal reminders +
 * streak-at-risk + meteor warning, escalated by urgency in reminderLogic).
 *
 * Runs every 30 minutes. Each group has its own timezone, so a single global
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
 * Scope note: this scans every group each tick. Fine at launch scale; if the
 * group count grows large, precompute a `next_nudge_at` field and query on it
 * instead of scanning.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { getProcessingDate, daysBetween } from "./gameLogic";
import { decideNudge, SlotId } from "./reminderLogic";
import { notifyUids, uidsForNames } from "./notify";
import { buildProgressOf } from "./buildings";
import { consolidate, NudgeEntry } from "./nudgeMessages";

// Re-exported: the copy moved to nudgeMessages.ts, callers and tests did not.
export { messageFor } from "./nudgeMessages";

const db = () => getFirestore();

async function runNudges(): Promise<void> {
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
      const now = DateTime.now().setZone(tz);
      if (!now.isValid) return;

      const todayGameDate = getProcessingDate(data.goal_reset_time ?? "00:00", tz);
      const members: string[] = data.group_members ?? [];
      const completions: string[] = data.completions_today ?? [];
      const lastActivity: string | null = data.last_activity_date ?? null;
      const sentDate: string | null = data.reminders_sent_date ?? null;
      const sentSlots: SlotId[] = data.reminders_sent_slots ?? [];

      const nudge = decideNudge({
        localMinutes: now.hour * 60 + now.minute,
        todayGameDate,
        remindersSentDate: sentDate,
        remindersSentSlots: sentSlots,
        memberCount: members.length,
        completedCount: completions.length,
        streak: data.streak ?? 0,
        idleDays: lastActivity ? daysBetween(lastActivity, todayGameDate) : null,
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
      };
      const base = { groupId: doc.id, cityName, nudge, ctx };

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
  await Promise.all(
    [...byUid.entries()].map(async ([uid, entries]) => {
      const payload = consolidate(entries);
      if (payload) await notifyUids([uid], payload);
    }),
  );
}

// Every 30 minutes — the :30 slots (11:30, 17:30) need half-hour granularity.
// The per-group timezone math inside decides who actually fires.
export const dailyNudge = onSchedule(
  { schedule: "every 30 minutes", timeoutSeconds: 300, memory: "256MiB" },
  async () => {
    await runNudges();
  },
);
