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
 * So the body always states the new bar in completions, not just the event.
 * "Riley joined" is gossip; "that's 4 completions a day now" is the thing that
 * changes what you have to do today.
 */

const completions = (n: number) =>
  n === 1 ? "1 completion a day" : `${n} completions a day`;

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
    body:
      `${cityName} is now a crew of ${memberCount}. ` +
      `That's ${completions(memberCount)} for the build to keep going.`,
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
  if (memberCount === 1) {
    // The last one standing. Saying "a crew of 1" reads like a taunt.
    return {
      title: `${name} left ${cityName}`,
      body: `You're the only one left in ${cityName} — it's your goal alone now.`,
    };
  }
  return {
    title: `${name} left ${cityName}`,
    body:
      `${cityName} is down to ${memberCount}. ` +
      `That's ${completions(memberCount)} to keep building.`,
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
  if (activeCount === 0) {
    // Everyone is away now, which the game treats as a city pause.
    return {
      title: `🏖️ ${name} is on vacation`,
      body:
        `${name} is away until ${untilLabel} — that's the whole crew, ` +
        `so ${cityName} is paused until then.`,
    };
  }
  return {
    title: `🏖️ ${name} is on vacation`,
    body:
      `${name} is away from ${cityName} until ${untilLabel}. ` +
      `That's ${completions(activeCount)} to keep building until then.`,
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
    body: `That's ${completions(activeCount)} again, starting today.`,
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
    body:
      `${byName} paused the city until ${untilLabel}. ` +
      `Nothing counts for or against ${cityName} until then.`,
  };
}

/** …and resumed it early. */
export function cityResumedMessage(
  cityName: string,
  byName: string,
  memberCount: number,
): CrewMessage {
  return {
    title: `${cityName} is back in business`,
    body: `${byName} resumed the city. That's ${completions(memberCount)} again, starting today.`,
  };
}
