import {
  joinedMessage,
  leftMessage,
  onVacationMessage,
  backMessage,
  cityPausedMessage,
  cityResumedMessage,
} from "../crewMessages";
import { MAX_MEMBERS_PER_GROUP } from "../utils";

/**
 * Crew changes are notified because crew size IS the win condition: a build
 * lands only when every member completes. Someone joining can put today's
 * build out of reach; someone leaving can put it back in. Both used to happen
 * silently.
 *
 * So the thing these tests actually guard is that the body states the new bar
 * in completions. The name and the emoji are decoration — the number is the
 * part that changes what you have to do today.
 */

describe("joinedMessage", () => {
  it("states the new bar, not just the arrival", () => {
    const m = joinedMessage("Riley", "Riverside", 3);
    expect(m.title).toContain("Riley");
    expect(m.title).toContain("Riverside");
    expect(m.body).toContain("3 completions a day");
  });

  it("covers every crew size the cap allows", () => {
    // Joining always produces a crew of at least 2 — you can't join alone.
    for (let n = 2; n <= MAX_MEMBERS_PER_GROUP; n++) {
      expect(joinedMessage("Riley", "Riverside", n).body).toContain(
        `${n} completions a day`,
      );
    }
  });
});

describe("leftMessage", () => {
  it("states the reduced bar", () => {
    const m = leftMessage("Sam", "Riverside", 2);
    expect(m.title).toContain("Sam");
    expect(m.body).toContain("2 completions a day");
  });

  it("doesn't call one person a crew", () => {
    // "Riverside is down to 1. That's 1 completion a day" is technically true
    // and reads like a taunt at the person who just got left behind.
    const m = leftMessage("Sam", "Riverside", 1);
    expect(m.body).not.toContain("crew of 1");
    expect(m.body).toContain("only one left");
  });

  it("stays flat in tone — no reaction to the departure", () => {
    // Somebody quitting a shared goal is a sore subject. The useful content is
    // the new number; anything editorial about it is not ours to add.
    const body = leftMessage("Sam", "Riverside", 2).body.toLowerCase();
    for (const editorial of ["sorry", "sadly", "unfortunately", "abandoned", "quit"]) {
      expect(body).not.toContain(editorial);
    }
  });
});

describe("vacation messages", () => {
  it("states the lowered bar and when it comes back", () => {
    const m = onVacationMessage("Sam", "Riverside", "Sep 12", 3);
    expect(m.title).toContain("Sam");
    expect(m.body).toContain("Sep 12");
    expect(m.body).toContain("3 completions a day");
  });

  it("says the city is paused when the last active member goes away", () => {
    const m = onVacationMessage("Sam", "Riverside", "Sep 12", 0);
    expect(m.body).toContain("paused");
    expect(m.body).not.toContain("0 completions");
  });

  it("restores the bar on return", () => {
    expect(backMessage("Sam", "Riverside", 4).body).toContain("4 completions a day");
  });

  it("names who paused the city and until when", () => {
    const m = cityPausedMessage("Riverside", "Chris", "Sep 12");
    expect(m.title).toContain("Riverside");
    expect(m.body).toContain("Chris");
    expect(m.body).toContain("Sep 12");
  });

  it("states the bar again on resume", () => {
    expect(cityResumedMessage("Riverside", "Chris", 2).body).toContain("2 completions a day");
  });

  it("stays flat — a vacation is not a desertion", () => {
    const body = onVacationMessage("Sam", "Riverside", "Sep 12", 2).body.toLowerCase();
    for (const editorial of ["sorry", "sadly", "unfortunately", "abandoned", "quit", "lazy"]) {
      expect(body).not.toContain(editorial);
    }
  });
});
