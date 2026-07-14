/**
 * Scheduled push notifications — the once-a-day nudge (daily reminder +
 * streak-at-risk + meteor warning, escalated by urgency in reminderLogic).
 *
 * Runs hourly. Each group has its own timezone and reset time, so a single
 * global tick can't "be evening" for everyone at once — instead every hourly
 * run asks each group "is it your reminder hour right now?" (decideNudge), and
 * only the matching hour fires. A `last_reminder_date` guard keeps it to one
 * nudge per game-day even if a run is retried.
 *
 * Scope note: this scans every group each hour. Fine at launch scale; if the
 * group count grows large, precompute a `next_nudge_hour` field and query on
 * it instead of scanning.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { getProcessingDate, daysBetween } from "./gameLogic";
import { decideNudge, Nudge } from "./reminderLogic";
import { notifyMembers, notifyAllMembers } from "./notify";

const db = () => getFirestore();

function resetHourOf(goalResetTime: unknown): number {
  const hh = parseInt(String(goalResetTime ?? "00:00").slice(0, 2), 10);
  return Number.isFinite(hh) ? ((hh % 24) + 24) % 24 : 0;
}

/** Build the payload text for a decided nudge. */
function messageFor(nudge: Nudge, cityName: string, streak: number) {
  switch (nudge.kind) {
    case "meteor":
      return {
        title: "☄️ Meteor incoming",
        body: `${cityName} hasn't been active in days — complete today's goal to stop the meteor.`,
      };
    case "streak":
      return {
        title: "🔥 Keep the streak alive",
        body: `Your ${streak}-day streak in ${cityName} is on the line. Finish today's goal!`,
      };
    default:
      return {
        title: "Bitty City",
        body: `Don't forget today's goal in ${cityName}.`,
      };
  }
}

async function runNudges(): Promise<void> {
  const snap = await db().collection("groups").get();

  await Promise.all(
    snap.docs.map(async (doc) => {
      const data = doc.data();
      const tz: string = data.goal_reset_timezone ?? "UTC";
      const now = DateTime.now().setZone(tz);
      if (!now.isValid) return;

      const resetHour = resetHourOf(data.goal_reset_time);
      const todayGameDate = getProcessingDate(data.goal_reset_time ?? "00:00", tz);
      const members: string[] = data.group_members ?? [];
      const completions: string[] = data.completions_today ?? [];
      const lastActivity: string | null = data.last_activity_date ?? null;

      const nudge = decideNudge({
        localHour: now.hour,
        resetHour,
        todayGameDate,
        lastReminderDate: data.last_reminder_date ?? null,
        memberCount: members.length,
        completedCount: completions.length,
        streak: data.streak ?? 0,
        idleDays: lastActivity ? daysBetween(lastActivity, todayGameDate) : null,
      });

      if (!nudge) return;

      // Record the nudge first so a retry of this run can't double-send.
      await doc.ref.update({ last_reminder_date: todayGameDate });

      const payload = messageFor(nudge, data.group_name ?? "your city", data.streak ?? 0);

      if (nudge.recipients === "all") {
        await notifyAllMembers(doc.id, data, payload);
      } else {
        const incomplete = members.filter((m) => !completions.includes(m));
        await notifyMembers(doc.id, data, incomplete, payload);
      }
    }),
  );
}

// Hourly. The per-group timezone math inside decides who actually fires.
export const dailyNudge = onSchedule(
  { schedule: "every 60 minutes", timeoutSeconds: 300, memory: "256MiB" },
  async () => {
    await runNudges();
  },
);
