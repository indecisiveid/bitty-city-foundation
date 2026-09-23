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

// --- Game mode -----------------------------------------------------------------
//
// A mode switch changes what a day IS, which is a bigger move of the bar than
// any join or pause. The body states the new rule as the thing to do today.

/** A member switched the city's game mode. */
export function modeChangedMessage(
  byName: string,
  cityName: string,
  mode: "easy" | "hard",
  activeCount: number,
): CrewMessage {
  if (mode === "easy") {
    return {
      title: `${byName} switched ${cityName} to easy mode`,
      body:
        `From the next reset, every completion counts: each person who finishes ` +
        `adds their share of the day, and at least 1 of ${activeCount} keeps the city growing.`,
    };
  }
  return {
    title: `${byName} switched ${cityName} to hard mode`,
    body:
      `From the next reset it's all or nothing: the build only moves on days ` +
      `when all ${activeCount} of you complete the goal.`,
  };
}

/**
 * Hard mode has been rough — suggest easy mode. Sent once per cooldown
 * (gameMode.ts) when the crew keeps finishing partially.
 */
export function easyModeSuggestionMessage(
  cityName: string,
  nearMisses: number,
  windowDays: number,
): CrewMessage {
  return {
    title: `Hard mode's been rough in ${cityName}`,
    body:
      `${nearMisses} of the last ${windowDays} days someone finished but not everyone, ` +
      `so nothing counted. In easy mode, at least 1 person needs to complete your goal ` +
      `to make progress. Tap to switch.`,
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
  const cityName = change.newName ?? oldCityName;
  const renamed = change.newName !== undefined
    ? `${oldCityName} is now called ${change.newName}. `
    : "";
  if (change.newGoal !== undefined) {
    return {
      title: `🎯 ${byName} changed the goal for ${cityName}`,
      body:
        `${renamed}New goal: "${change.newGoal}". ` +
        `Anything already checked in today still counts.`,
    };
  }
  if (change.newName !== undefined) {
    return {
      title: `🏷️ ${byName} renamed ${oldCityName}`,
      body: `${renamed}Same crew, same streak.`,
    };
  }
  return null;
}
