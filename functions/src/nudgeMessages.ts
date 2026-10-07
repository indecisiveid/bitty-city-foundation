/**
 * Nudge COPY — pure. No Firestore, no clock, no push transport.
 *
 * Split out of scheduled.ts so the wording (and, more importantly, the
 * consolidation rules below) can be tested as plain functions. scheduled.ts
 * decides *whether* and *whom*; this file decides *what it says*.
 */
import { Nudge, NudgeKind } from "./reminderLogic";

export interface MessageContext {
  cityName: string;
  streak: number;
  /** Members who still haven't completed — names the last-call chaser uses. */
  pendingNames?: string[];
  /** Members already done today, in completion order — "Amit already checked in". */
  completedNames?: string[];
  /** Label of the build that lands if the crew wins today (buildings.landingTodayLabel). */
  landsToday?: string | null;
}

/**
 * Which side of the crew a recipient is on. Only `lastCall` addresses both:
 * the evening slot is sent to the pending members alone.
 */
export type NudgeRole = "pending" | "done";

/**
 * Push copy rules (October 2026 rewrite): the title is the news, the body is
 * ONE short clause. The old reminders stacked every fact we had — who's done,
 * how many are left, the city, the streak, tonight's landing, the quest — into
 * ~200 characters that iOS truncated anyway. Each fact now has one place: the
 * stake (streak, or a build landing tonight) goes in the title, the crew
 * status in the body.
 */

/** Short name list: "Sam", "Sam and Jo", "Sam +2". */
export function shortNames(names: string[]): string {
  if (names.length === 0) return "your crew";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} +${names.length - 1}`;
}

/**
 * Where the crew stands, as one clause. Naming the friend who is done is the
 * strongest thing a reminder can say — it turns "do your goal" into "your crew
 * is waiting on you" — and when the recipient is the last one out, it says so.
 */
function crewStatus(ctx: MessageContext, fallback: string): string {
  const done = ctx.completedNames ?? [];
  if (done.length === 0) return fallback;
  const pending = ctx.pendingNames?.length ?? 0;
  if (pending <= 1) return `${shortNames(done)} finished — you're the last one in ${ctx.cityName}.`;
  return `${shortNames(done)} finished. ${pending} to go in ${ctx.cityName}.`;
}

/**
 * The push a dormant person gets once, before reminders go quiet for them.
 * Neutral on purpose: no guilt, no countdown — just the fact and the door
 * left open (spec §9.5).
 */
export function farewellMessage(cityNames: string[]) {
  return {
    title: "👋 Pausing reminders",
    body:
      cityNames.length === 1
        ? `${cityNames[0]} will be here when you're back.`
        : "Your cities will be here when you're back.",
  };
}

/**
 * Build the payload text for a decided nudge.
 *
 * `role` only changes the wording at last call, where the crew is addressed on
 * both sides: the people who still owe the goal are told to finish it, and the
 * people who are already done — the only ones who can still rescue the day —
 * are told who to chase. Defaults to `pending`.
 */
export function messageFor(
  nudge: Nudge,
  ctx: MessageContext,
  role: NudgeRole = "pending",
) {
  const { cityName, streak } = ctx;

  // The meteor outranks everything — it's the only one that costs buildings.
  if (nudge.kind === "meteor") {
    return { title: "☄️ Meteor incoming", body: `Finish today's goal to save ${cityName}.` };
  }

  const onStreak = nudge.kind === "streak";

  // The chaser. Nobody reaches this unless their crew still has a gap —
  // decideNudge goes quiet the moment everyone is done.
  if (role === "done" && nudge.slot === "lastCall") {
    return {
      title: `⏳ Waiting on ${shortNames(ctx.pendingNames ?? [])}`,
      body: onStreak
        ? `A nudge could save the ${streak}-day streak in ${cityName}.`
        : `A nudge might be all ${cityName} needs.`,
    };
  }

  // The stake goes in the title: the streak if there is one, else a build
  // that lands tonight. The two slots read differently so the day escalates.
  const stake = onStreak
    ? `${streak}-day streak`
    : ctx.landsToday
      ? `${ctx.landsToday} lands tonight`
      : null;

  if (nudge.slot === "lastCall") {
    return {
      title: stake ? `⏳ Last call: ${stake}` : "⏳ Last call",
      body: crewStatus(ctx, `Today's goal in ${cityName} is still open.`),
    };
  }

  return {
    title: onStreak ? `🔥 ${stake} on the line` : stake ? `🏗️ ${stake}` : "Today's goal is open",
    body: crewStatus(ctx, `Still time to finish in ${cityName}.`),
  };
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
  /** The city's game-date this decision belongs to (per-person daily caps key on it). */
  gameDate?: string;
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
      body: `Finish today's goal to save ${worst.cityName} (+${others} more ${plural(others, "city", "cities")} open).`,
    };
  }

  const pending = entries.filter((e) => e.role === "pending");

  // Nothing left for this person to DO — they've finished everywhere, and are
  // being asked to chase the crews that haven't.
  if (pending.length === 0) {
    const n = entries.length;
    return {
      title: "⏳ Last call for your crews",
      body: `${n} ${plural(n, "crew is", "crews are")} still waiting on someone. A nudge might do it.`,
    };
  }

  const atStake = pending.filter((e) => e.nudge.kind === "streak").length;

  return {
    title: atStake > 0
      ? `🔥 ${atStake} ${plural(atStake, "streak", "streaks")} on the line`
      : "Today's goals are open",
    body: `Still open: ${cityList(pending.map((e) => e.cityName))}.`,
  };
}
