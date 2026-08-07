/**
 * Nudge COPY — pure. No Firestore, no clock, no push transport.
 *
 * Split out of scheduled.ts so the wording (and, more importantly, the
 * consolidation rules below) can be tested as plain functions. scheduled.ts
 * decides *whether* and *whom*; this file decides *what it says*.
 */
import { Nudge, NudgeKind } from "./reminderLogic";
import { BuildProgress } from "./buildings";

export interface MessageContext {
  cityName: string;
  streak: number;
  build: BuildProgress | null;
  /** Members who still haven't completed — names the last-call chaser uses. */
  pendingNames?: string[];
}

/**
 * Which side of the crew a recipient is on. Only `lastCall` addresses both:
 * every other slot is sent to the pending members alone.
 */
export type NudgeRole = "pending" | "done";

/**
 * Name the members still holding the day up, as a clause.
 *
 * Truncated past two, because a push body is not a roster and the useful
 * information is "who do I chase first", not the full list.
 */
function pendingClause(names: string[]): string {
  if (names.length === 0) return "someone hasn't";
  if (names.length === 1) return `${names[0]} hasn't`;
  if (names.length === 2) return `${names[0]} and ${names[1]} haven't`;
  return `${names[0]} and ${names.length - 1} others haven't`;
}

/**
 * Build the payload text for a decided nudge.
 *
 * `role` only changes the wording at last call, where the crew is addressed on
 * both sides: the people who still owe the goal are told to finish it, and the
 * people who are already done — the only ones who can still rescue the day —
 * are told who to chase. Defaults to `pending`, which is every other slot.
 */
export function messageFor(
  nudge: Nudge,
  ctx: MessageContext,
  role: NudgeRole = "pending",
) {
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

  // The chaser. Nobody reaches this unless their crew still has a gap —
  // decideNudge goes quiet the moment everyone is done.
  if (role === "done" && nudge.slot === "lastCall") {
    return {
      title: "⏳ Last call for the crew",
      body: `You're done in ${cityName}, but ${pendingClause(ctx.pendingNames ?? [])} finished today's goal.${stake(`Your ${streak}-day streak is riding on it.`)} A nudge might be all it takes.`,
    };
  }

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


// ---------------------------------------------------------------------------
// Consolidation — one push per person per tick, however many cities they hold.
//
// The scheduler decides city by city, which is correct: every city has its own
// timezone, streak and crew. But a PERSON is not a city. Somebody in three
// cities used to get three near-identical pushes seconds apart, differing only
// in a name — the fastest way to have notifications switched off for good, and
// once they're off you don't get a second prompt.
//
// So the fan-out is inverted at the last moment: decide per city, then collapse
// per person. One city collapses to exactly the copy it always had, byte for
// byte — the common case must not regress just because the machinery grew.
// ---------------------------------------------------------------------------

/** One city's decision, as it lands on one person. */
export interface NudgeEntry {
  groupId: string;
  cityName: string;
  nudge: Nudge;
  ctx: MessageContext;
  role: NudgeRole;
}

export interface ConsolidatedPush {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Urgency order. The most alarming city sets the tone for the whole message. */
const KIND_RANK: Record<NudgeKind, number> = { meteor: 3, streak: 2, reminder: 1 };

/**
 * Name cities the way a person would: one, two, then a count. Past two the
 * list stops being readable at a glance, and the actionable fact becomes "how
 * many", not "which".
 */
export function cityList(names: string[]): string {
  if (names.length === 0) return "your cities";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Collapse everything one person is owed this tick into a single push.
 *
 * A single entry returns the untouched per-city copy, and keeps `group_id` so
 * the tap still deep-links to that city. Several entries drop `group_id` on
 * purpose: there is no one right city to open, and the app's `openFromData`
 * early-returns without it, landing the user on Home — which is exactly where
 * a message about several cities should go.
 */
export function consolidate(entries: NudgeEntry[]): ConsolidatedPush | null {
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    const e = entries[0];
    const single = messageFor(e.nudge, e.ctx, e.role);
    return { ...single, data: { group_id: e.groupId } };
  }

  const worst = entries.reduce((a, b) =>
    KIND_RANK[b.nudge.kind] > KIND_RANK[a.nudge.kind] ? b : a,
  );

  // A meteor is the only nudge that costs buildings, so it takes the whole
  // message even when other cities are merely nagging.
  if (worst.nudge.kind === "meteor") {
    const others = entries.length - 1;
    return {
      title: "☄️ Meteor incoming",
      body:
        `${worst.cityName} hasn't been active in days — complete today's goal to stop the meteor. ` +
        `${others} other ${plural(others, "city", "cities")} still ${plural(others, "needs", "need")} today's goal too.`,
    };
  }

  const pending = entries.filter((e) => e.role === "pending");

  // Nothing left for this person to DO — they've finished everywhere, and are
  // being asked to chase the crews that haven't.
  if (pending.length === 0) {
    const n = entries.length;
    return {
      title: "⏳ Last call for your crews",
      body:
        `You're done in ${cityList(entries.map((e) => e.cityName))}, but ${n} ` +
        `${plural(n, "crew", "crews")} still ${plural(n, "hasn't", "haven't")} finished today's goal. ` +
        `A nudge might be all it takes.`,
    };
  }

  const atStake = pending.filter((e) => e.nudge.kind === "streak").length;
  const waiting = entries.length - pending.length;

  return {
    title: atStake > 0
      ? `🔥 ${atStake} ${plural(atStake, "streak", "streaks")} on the line`
      : "Bitty City",
    body:
      `Today's goal is still open in ${cityList(pending.map((e) => e.cityName))}.` +
      (atStake > 0
        ? ` Your ${plural(atStake, "streak is", "streaks are")} riding on it.`
        : "") +
      (waiting > 0
        ? ` ${waiting} other ${plural(waiting, "crew", "crews")} ${plural(waiting, "is", "are")} waiting on someone too.`
        : ""),
  };
}
