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
 * Scope note: this scans every group each tick. Fine at launch scale; if the
 * group count grows large, precompute a `next_nudge_at` field and query on it
 * instead of scanning.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { getProcessingDate, daysBetween } from "./gameLogic";
import { decideNudge, Nudge, SlotId } from "./reminderLogic";
import { notifyMembers, notifyAllMembers } from "./notify";
import { buildProgressOf, BuildProgress } from "./buildings";

const db = () => getFirestore();

interface MessageContext {
  cityName: string;
  streak: number;
  build: BuildProgress | null;
}

/** Build the payload text for a decided nudge. */
export function messageFor(nudge: Nudge, ctx: MessageContext) {
  // The meteor outranks everything — it's the only one that costs buildings.
  if (nudge.kind === "meteor") {
    return {
      title: "☄️ Meteor incoming",
      body: `${ctx.cityName} hasn't been active in days — complete today's goal to stop the meteor.`,
    };
  }

  // Every slot gets its own voice. Four pushes a day that all read "keep the
  // streak alive" feels like a broken loop, so the day escalates instead:
  // plan it → nudge → still open → last call. A test pins that no two slots
  // in the same day can produce the same body.
  const { cityName, streak, build } = ctx;
  const onStreak = nudge.kind === "streak";
  // The goal is always the thing to do; the streak is what's at stake. Keeping
  // them in separate clauses avoids copy like "finish your 4-day streak".
  const stake = (clause: string) => (onStreak ? ` ${clause}` : "");

  switch (nudge.slot) {
    case "morning":
      // The morning slot sets up the day. On a multi-day build, say where we are.
      if (build) {
        const { dayNumber, daysRequired, label } = build;
        return {
          title: `🌅 Day ${dayNumber} of ${daysRequired}`,
          body: `Today is Day ${dayNumber} of ${daysRequired}. Plan to complete your goal today to finish building your ${label}.`,
        };
      }
      return {
        title: "🌅 Good morning",
        body: `Plan when you'll finish today's goal in ${cityName}.${stake(`Your ${streak}-day streak depends on it.`)}`,
      };

    case "midday":
      return {
        title: onStreak ? "🔥 Keep the streak alive" : "Bitty City",
        body: `Don't forget today's goal in ${cityName}.${stake(`Your ${streak}-day streak is on the line.`)}`,
      };

    case "evening":
      return {
        title: onStreak ? "🔥 Streak still open" : "Bitty City",
        body: `Today's goal in ${cityName} still isn't checked off.${stake(`Your ${streak}-day streak is riding on it.`)}`,
      };

    case "lastCall":
    default:
      return {
        title: "⏳ Last call",
        body: `The day's nearly done and today's goal in ${cityName} is still open.${stake(`Last chance to save your ${streak}-day streak.`)}`,
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
      // the stored list belongs to an older game-date, start it fresh.
      const slotsForToday =
        sentDate === todayGameDate ? [...sentSlots, nudge.slot] : [nudge.slot];
      await doc.ref.update({
        reminders_sent_date: todayGameDate,
        reminders_sent_slots: slotsForToday,
        // Legacy single-nudge field, no longer read. Drop it as we touch docs.
        last_reminder_date: FieldValue.delete(),
      });

      const payload = messageFor(nudge, {
        cityName: data.group_name ?? "your city",
        streak: data.streak ?? 0,
        build: buildProgressOf(data.current_build),
      });

      if (nudge.recipients === "all") {
        await notifyAllMembers(doc.id, data, payload);
      } else {
        const incomplete = members.filter((m) => !completions.includes(m));
        await notifyMembers(doc.id, data, incomplete, payload);
      }
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
