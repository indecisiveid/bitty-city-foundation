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
