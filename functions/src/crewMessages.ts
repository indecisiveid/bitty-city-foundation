/**
 * Crew-change copy — pure, like nudgeMessages.
 *
 * Why these notifications exist at all: a build only lands when EVERY member
 * completes the goal, so the size of the crew IS the win condition. Someone
 * joining raises the bar — today's build may have just become unreachable
 * because a person who wasn't there this morning hasn't checked in. Someone
 * leaving lowers it. Until now both happened in total silence and the crew
 * only noticed if they happened to be staring at the member count.
 *
 * So the body states the new crew size, not just the event: "Riley joined"
 * is gossip; "crew of 4 now" is the thing that changes what you do today.
 * One short clause — see the copy rules in nudgeMessages.ts.
 */

export interface CrewMessage {
  title: string;
  body: string;
}

/** Someone new is in the crew — the bar just went up. */
export function joinedMessage(
  name: string,
  cityName: string,
  memberCount: number,
): CrewMessage {
  return {
    title: `👋 ${name} joined ${cityName}`,
    body: `Crew of ${memberCount} now — everyone counts.`,
  };
}

/**
 * Someone left — the bar went down.
 *
 * Deliberately flat in tone. Somebody leaving a shared goal can be a sore
 * subject, and the useful content is the new number, not a reaction to it.
 */
export function leftMessage(
  name: string,
  cityName: string,
  memberCount: number,
): CrewMessage {
  // The last one standing. Saying "a crew of 1" reads like a taunt.
  return {
    title: `${name} left ${cityName}`,
    body: memberCount === 1 ? "It's just you now." : `Crew of ${memberCount} now.`,
  };
}

// --- Vacation mode -----------------------------------------------------------
//
// Same reasoning as join/leave: a pause moves the bar. Someone going on
// vacation lowers it for the rest of the crew; a city pause takes it away
// entirely for a while. The body states the new bar, and the date it changes
// back, because those are the two things that change what you do today.

/** A member is away — the bar dropped for everyone else. */
export function onVacationMessage(
  name: string,
  cityName: string,
  untilLabel: string,
  activeCount: number,
): CrewMessage {
  return {
    title: `🏖️ ${name} is away from ${cityName}`,
    // Everyone away is a city pause, which the game treats as such.
    body:
      activeCount === 0
        ? `Back ${untilLabel}. The city is paused till then.`
        : `Back ${untilLabel}. Crew of ${activeCount} till then.`,
  };
}

/** A member is back — the bar is up again. Flat, like leftMessage. */
export function backMessage(
  name: string,
  cityName: string,
  activeCount: number,
): CrewMessage {
  return {
    title: `${name} is back in ${cityName}`,
    body: `Crew of ${activeCount} again, starting today.`,
  };
}

/** The founder paused the whole city. */
export function cityPausedMessage(
  cityName: string,
  byName: string,
  untilLabel: string,
): CrewMessage {
  return {
    title: `🏖️ ${cityName} is paused`,
    body: `${byName} paused it until ${untilLabel}. Nothing counts till then.`,
  };
}

/** …and resumed it early. */
export function cityResumedMessage(
  cityName: string,
  byName: string,
  memberCount: number,
): CrewMessage {
  return {
    title: `${cityName} is back on`,
    body: `${byName} resumed it. Crew of ${memberCount}, starting today.`,
  };
}

// --- Game mode -----------------------------------------------------------------
//
// A mode switch itself is in-app only (cut from pushes in October 2026).

/**
 * Hard mode has been rough — suggest easy mode. Sent once per cooldown
 * (gameMode.ts) when the crew keeps finishing partially.
 */
export function easyModeSuggestionMessage(cityName: string): CrewMessage {
  return {
    title: `Hard mode's been rough in ${cityName}`,
    body: "In easy mode, at least 1 person needs to complete your goal to make progress.",
  };
}

/**
 * Someone edited the city's settings. Only a new goal or a new name is worth
 * a push: the goal is what everyone has to do, the name is how they find the
 * city. A category change alone is a quiet tag and sends nothing.
 */
export function citySettingsChangedMessage(
  byName: string,
  oldCityName: string,
  change: { newName?: string; newGoal?: string },
): CrewMessage | null {
  // A rename alone is in-app only (October 2026 push cut); a new goal changes
  // what everyone does today, so it still goes out.
  if (change.newGoal === undefined) return null;
  return {
    title: `🎯 ${byName} changed the goal`,
    body: `"${change.newGoal}" in ${change.newName ?? oldCityName}. Today's check-ins still count.`,
  };
}
