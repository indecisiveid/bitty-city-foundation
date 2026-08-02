/**
 * Unit tests for the pure daily-nudge decision logic, the notification copy
 * it drives, and the build-progress helper behind "Day X of Y".
 */
import {
  decideNudge,
  slotForLocalMinutes,
  REMINDER_SLOTS,
  SLOT_WINDOW_MINUTES,
  NudgeInput,
  SlotId,
} from "../reminderLogic";
import { INACTIVITY_METEOR_DAYS } from "../gameLogic";
import { isValidPushToken } from "../push";
import { buildProgressOf, withArticle } from "../buildings";
import { CATALOG, LEGACY_LABEL } from "../buildCatalog";
import { messageFor } from "../scheduled";
import { dayCompleteMessage } from "../groupHandlers";

/** Minutes-since-midnight for a slot id. */
const at = (id: SlotId) => REMINDER_SLOTS.find((s) => s.id === id)!.minutes;

const base: NudgeInput = {
  localMinutes: at("evening"),
  todayGameDate: "2026-07-14",
  remindersSentDate: null,
  remindersSentSlots: [],
  memberCount: 3,
  completedCount: 1,
  streak: 0,
  idleDays: 0,
};

describe("slotForLocalMinutes", () => {
  it("maps the four advertised local times to slots", () => {
    expect(slotForLocalMinutes(8 * 60)).toBe("morning"); // 08:00
    expect(slotForLocalMinutes(11 * 60 + 30)).toBe("midday"); // 11:30
    expect(slotForLocalMinutes(17 * 60 + 30)).toBe("evening"); // 17:30
    expect(slotForLocalMinutes(21 * 60)).toBe("lastCall"); // 21:00
  });

  it("tolerates scheduler jitter inside the slot window but not past it", () => {
    expect(slotForLocalMinutes(8 * 60 + SLOT_WINDOW_MINUTES - 1)).toBe("morning");
    expect(slotForLocalMinutes(8 * 60 + SLOT_WINDOW_MINUTES)).toBeNull();
    expect(slotForLocalMinutes(8 * 60 - 1)).toBeNull();
  });

  it("is null at times that belong to no slot", () => {
    expect(slotForLocalMinutes(0)).toBeNull(); // midnight
    expect(slotForLocalMinutes(14 * 60)).toBeNull(); // 2pm
    expect(slotForLocalMinutes(23 * 60 + 59)).toBeNull();
  });

  it("never lets two slots claim the same minute", () => {
    for (let m = 0; m < 24 * 60; m++) {
      const hits = REMINDER_SLOTS.filter(
        (s) => m >= s.minutes && m < s.minutes + SLOT_WINDOW_MINUTES,
      );
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("decideNudge", () => {
  it("fires inside a slot window and stays silent outside one", () => {
    expect(decideNudge(base)).not.toBeNull();
    expect(decideNudge({ ...base, localMinutes: 14 * 60 })).toBeNull();
  });

  it("fires each of the four slots on the same day", () => {
    const slots: SlotId[] = ["morning", "midday", "evening", "lastCall"];
    const sent: SlotId[] = [];
    for (const id of slots) {
      const n = decideNudge({
        ...base,
        localMinutes: at(id),
        remindersSentDate: base.todayGameDate,
        remindersSentSlots: [...sent],
      });
      expect(n?.slot).toBe(id);
      sent.push(id);
    }
    expect(sent).toHaveLength(4);
  });

  it("sends each slot at most once per game-day", () => {
    const sentToday = {
      ...base,
      remindersSentDate: base.todayGameDate,
      remindersSentSlots: ["evening"] as SlotId[],
    };
    expect(decideNudge(sentToday)).toBeNull();
    // A different slot on the same day is still allowed.
    expect(decideNudge({ ...sentToday, localMinutes: at("lastCall") })).not.toBeNull();
  });

  it("treats a slot list from an older game-date as stale", () => {
    const n = decideNudge({
      ...base,
      remindersSentDate: "2026-07-13",
      remindersSentSlots: ["evening"],
    });
    expect(n?.slot).toBe("evening");
  });

  it("never back-fills a slot whose window already passed", () => {
    // It's 17:30 (evening). The morning + midday windows are long gone and
    // must not fire retroactively — a build started midday gets what's left.
    expect(decideNudge(base)?.slot).toBe("evening");
  });

  it("stays silent when the whole crew is done", () => {
    expect(decideNudge({ ...base, completedCount: 3, memberCount: 3 })).toBeNull();
  });

  it("stays silent for an empty group", () => {
    expect(decideNudge({ ...base, memberCount: 0, completedCount: 0 })).toBeNull();
  });

  it("plain reminder when no streak and not idle", () => {
    expect(decideNudge(base)).toEqual({
      kind: "reminder",
      recipients: "incomplete",
      slot: "evening",
    });
  });

  it("escalates to a streak nudge when a streak is live", () => {
    expect(decideNudge({ ...base, streak: 5 })?.kind).toBe("streak");
  });

  it("escalates to a meteor warning to ALL when idle one day short of the threshold", () => {
    const n = decideNudge({
      ...base,
      streak: 5, // meteor outranks streak
      idleDays: INACTIVITY_METEOR_DAYS - 1,
    });
    expect(n).toEqual({ kind: "meteor", recipients: "all", slot: "evening" });
  });

  it("does not warn meteor when still comfortably active", () => {
    expect(decideNudge({ ...base, idleDays: INACTIVITY_METEOR_DAYS - 2 })?.kind).not.toBe(
      "meteor",
    );
  });
});

describe("withArticle", () => {
  it("picks the article by leading vowel", () => {
    expect(withArticle("House")).toBe("a House");
    expect(withArticle("Apartment")).toBe("an Apartment");
    expect(withArticle("Skyscraper")).toBe("a Skyscraper");
    expect(withArticle("building")).toBe("a building");
  });

  it("reads correctly for every building label we ship", () => {
    // The whole catalog, not just the legacy three — "Apartments" begins with
    // a vowel, which is precisely the case this guards.
    const labels: string[] = [
      ...CATALOG.map((i) => i.label),
      ...Object.values(LEGACY_LABEL),
    ];
    for (const label of labels) {
      const phrase = withArticle(label);
      expect(phrase).toMatch(/^an? \w/);
      // "a Apartment" is the bug this guards against.
      if (/^[aeiou]/i.test(label)) expect(phrase.startsWith("an ")).toBe(true);
      else expect(phrase.startsWith("a ")).toBe(true);
    }
  });
});

describe("buildProgressOf", () => {
  it("is null with no build, or a single-day build", () => {
    expect(buildProgressOf(null)).toBeNull();
    expect(buildProgressOf(undefined)).toBeNull();
    expect(buildProgressOf({ type: "house", days_required: 1, days_completed: 0 })).toBeNull();
  });

  it("counts today as the next unbanked day (1-based)", () => {
    // Fresh 3-day build: no days banked → today is Day 1.
    expect(buildProgressOf({ type: "apartment", days_required: 3, days_completed: 0 }))
      .toEqual({ label: "Apartment", dayNumber: 1, daysRequired: 3 });
    // One all-complete day banked → today is Day 2, not Day 1.
    expect(buildProgressOf({ type: "apartment", days_required: 3, days_completed: 1 }))
      .toEqual({ label: "Apartment", dayNumber: 2, daysRequired: 3 });
  });

  it("clamps so a fully-banked build never reads past its last day", () => {
    expect(
      buildProgressOf({ type: "apartment", days_required: 3, days_completed: 3 })?.dayNumber,
    ).toBe(3);
  });

  it("falls back to BUILDING_DAYS when days_required is missing", () => {
    expect(buildProgressOf({ type: "skyscraper", days_completed: 0 })).toEqual({
      label: "Skyscraper",
      dayNumber: 1,
      daysRequired: 7,
    });
  });
});

describe("messageFor", () => {
  const ctx = { cityName: "Testville", streak: 4, build: null };
  const build = { label: "Apartment", dayNumber: 2, daysRequired: 3 };

  it("uses Day X of Y copy on the morning slot of a multi-day build", () => {
    const m = messageFor(
      { kind: "reminder", recipients: "incomplete", slot: "morning" },
      { ...ctx, build },
    );
    expect(m.body).toContain("Today is Day 2 of 3");
    expect(m.body).toContain("Apartment");
  });

  it("does not use Day X of Y on the later slots", () => {
    const m = messageFor(
      { kind: "reminder", recipients: "incomplete", slot: "midday" },
      { ...ctx, build },
    );
    expect(m.body).not.toContain("Day 2 of 3");
  });

  it("lets the meteor warning outrank the morning day-plan copy", () => {
    const m = messageFor(
      { kind: "meteor", recipients: "all", slot: "morning" },
      { ...ctx, build },
    );
    expect(m.title).toContain("Meteor");
  });

  it("mentions the streak length on a streak nudge", () => {
    const m = messageFor({ kind: "streak", recipients: "incomplete", slot: "evening" }, ctx);
    expect(m.body).toContain("4-day streak");
  });

  it("has a distinct last-call voice, streak or not", () => {
    const plain = messageFor({ kind: "reminder", recipients: "incomplete", slot: "lastCall" }, ctx);
    expect(plain.title).toContain("Last call");
    const streak = messageFor({ kind: "streak", recipients: "incomplete", slot: "lastCall" }, ctx);
    expect(streak.title).toContain("Last call");
    expect(streak.body).toContain("4-day streak");
  });

  it("never sends the same text twice in one day", () => {
    // Four identical pushes reads like a broken loop. Every slot the crew can
    // receive in a single day must say something different.
    const slots: SlotId[] = ["morning", "midday", "evening", "lastCall"];
    for (const kind of ["streak", "reminder"] as const) {
      for (const b of [null, build]) {
        const bodies = slots.map(
          (slot) => messageFor({ kind, recipients: "incomplete", slot }, { ...ctx, build: b }).body,
        );
        expect(new Set(bodies).size).toBe(slots.length);
      }
    }
  });

  it("always produces a non-empty title and body", () => {
    const slots: SlotId[] = ["morning", "midday", "evening", "lastCall"];
    for (const slot of slots) {
      for (const kind of ["meteor", "streak", "reminder"] as const) {
        for (const b of [null, build]) {
          const m = messageFor({ kind, recipients: "all", slot }, { ...ctx, build: b });
          expect(m.title.length).toBeGreaterThan(0);
          expect(m.body.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("dayCompleteMessage", () => {
  it("promises the next commitment day mid multi-day build", () => {
    const m = dayCompleteMessage({
      group_name: "Testville",
      current_build: { type: "apartment", days_required: 3, days_completed: 1 },
    });
    expect(m.body).toContain("Day 2 of 3");
    expect(m.body).toContain("Next commitment day");
  });

  it("celebrates the finished building on the final day", () => {
    const m = dayCompleteMessage({
      group_name: "Testville",
      current_build: { type: "apartment", days_required: 3, days_completed: 2 },
    });
    expect(m.title).toContain("build complete");
    expect(m.body).toContain("Apartment");
  });

  it("falls back to plain crew congratulations with no multi-day build", () => {
    const m = dayCompleteMessage({ group_name: "Testville", current_build: null });
    expect(m.title).toContain("Everyone's in");
    expect(m.body).toContain("Testville");
  });
});

describe("isValidPushToken", () => {
  it("accepts non-empty string FCM tokens and rejects junk", () => {
    expect(isValidPushToken("fMEP0v...:APA91bH...")).toBe(true);
    expect(isValidPushToken("abc123")).toBe(true);
    expect(isValidPushToken("")).toBe(false);
    expect(isValidPushToken(null)).toBe(false);
    expect(isValidPushToken(42)).toBe(false);
    expect(isValidPushToken("x".repeat(5000))).toBe(false);
  });
});
