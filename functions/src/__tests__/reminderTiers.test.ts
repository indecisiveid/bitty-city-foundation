/**
 * Per-person reminder tiers. reminderLogic decides what a city owes at a
 * slot; this decides how much of it a person hears, by how long since they
 * last opened the app.
 */
import {
  applyUserTier,
  COOLING_AFTER_DAYS,
  DORMANT_AFTER_DAYS,
  EMPTY_REMINDER_STATE,
  reminderStateOf,
  sentTodayOf,
  tierFor,
  UserReminderState,
} from "../reminderTiers";
import { NudgeEntry } from "../nudgeMessages";
import { Nudge, SlotId } from "../reminderLogic";

const TODAY = "2026-09-22";

const entry = (slot: SlotId, kind: Nudge["kind"] = "reminder", city = "Riverside"): NudgeEntry => ({
  groupId: `g-${city}`,
  cityName: city,
  nudge: { kind, recipients: "incomplete", slot },
  role: "pending",
  ctx: { cityName: city, streak: 0, build: null },
  gameDate: TODAY,
});

describe("tierFor", () => {
  it("has the advertised boundaries", () => {
    expect(tierFor(0)).toBe("active");
    expect(tierFor(COOLING_AFTER_DAYS - 1)).toBe("active");
    expect(tierFor(COOLING_AFTER_DAYS)).toBe("cooling");
    expect(tierFor(DORMANT_AFTER_DAYS - 1)).toBe("cooling");
    expect(tierFor(DORMANT_AFTER_DAYS)).toBe("dormant");
    expect(tierFor(60)).toBe("dormant");
  });

  it("treats unknown presence as active — never farewell on a guess", () => {
    expect(tierFor(null)).toBe("active");
  });
});

describe("reminderStateOf", () => {
  it("normalizes a missing or partial record", () => {
    expect(reminderStateOf(undefined)).toEqual(EMPTY_REMINDER_STATE);
    expect(reminderStateOf(null)).toEqual(EMPTY_REMINDER_STATE);
    expect(reminderStateOf({ date: TODAY })).toEqual({ date: TODAY, sent: 0, farewellSent: false });
    expect(reminderStateOf({ date: TODAY, sent: 2, farewell_sent_at: { toDate: () => new Date() } })).toEqual({
      date: TODAY,
      sent: 2,
      farewellSent: true,
    });
    // A cleared farewell (null) reads as not sent.
    expect(reminderStateOf({ farewell_sent_at: null }).farewellSent).toBe(false);
  });

  it("only counts today's sends", () => {
    expect(sentTodayOf({ date: TODAY, sent: 3, farewellSent: false }, TODAY)).toBe(3);
    expect(sentTodayOf({ date: "2026-09-21", sent: 3, farewellSent: false }, TODAY)).toBe(0);
  });
});

describe("applyUserTier — active", () => {
  it("passes everything the cities decided, untouched", () => {
    const entries = [entry("morning"), entry("morning", "streak", "Hilltop")];
    expect(applyUserTier(entries, "active", EMPTY_REMINDER_STATE, TODAY)).toEqual({ action: "send", entries });
  });

  it("skips when nothing is owed", () => {
    expect(applyUserTier([], "active", EMPTY_REMINDER_STATE, TODAY).action).toBe("skip");
  });
});

describe("applyUserTier — cooling", () => {
  it("drops the daytime slots", () => {
    for (const slot of ["morning", "midday"] as SlotId[]) {
      const d = applyUserTier([entry(slot)], "cooling", EMPTY_REMINDER_STATE, TODAY);
      expect(d.action).toBe("skip");
    }
  });

  it("keeps evening and last call, and the meteor at any slot", () => {
    expect(applyUserTier([entry("evening")], "cooling", EMPTY_REMINDER_STATE, TODAY).action).toBe("send");
    expect(applyUserTier([entry("lastCall", "streak")], "cooling", EMPTY_REMINDER_STATE, TODAY).action).toBe("send");
    expect(applyUserTier([entry("morning", "meteor")], "cooling", EMPTY_REMINDER_STATE, TODAY).action).toBe("send");
  });

  it("filters a mixed bag down to what a cooling user hears", () => {
    const d = applyUserTier(
      [entry("morning", "reminder", "A"), entry("morning", "meteor", "B")],
      "cooling",
      EMPTY_REMINDER_STATE,
      TODAY,
    );
    expect(d).toEqual({ action: "send", entries: [entry("morning", "meteor", "B")] });
  });

  it("caps at one push per game-day", () => {
    const afterOne: UserReminderState = { date: TODAY, sent: 1, farewellSent: false };
    expect(applyUserTier([entry("lastCall")], "cooling", afterOne, TODAY).action).toBe("skip");
    // Yesterday's count does not carry over.
    const yesterday: UserReminderState = { date: "2026-09-21", sent: 4, farewellSent: false };
    expect(applyUserTier([entry("evening")], "cooling", yesterday, TODAY).action).toBe("send");
  });
});

describe("applyUserTier — dormant", () => {
  it("farewells once, then goes quiet", () => {
    expect(applyUserTier([entry("evening")], "dormant", EMPTY_REMINDER_STATE, TODAY)).toEqual({ action: "farewell" });
    const said: UserReminderState = { date: "2026-09-01", sent: 1, farewellSent: true };
    expect(applyUserTier([entry("evening")], "dormant", said, TODAY).action).toBe("skip");
  });

  it("stays quiet even for the meteor — they've been gone two weeks", () => {
    const said: UserReminderState = { date: "2026-09-01", sent: 1, farewellSent: true };
    expect(applyUserTier([entry("evening", "meteor")], "dormant", said, TODAY).action).toBe("skip");
  });

  it("farewells even when this tick owes nothing else — the city decided, the person is gone", () => {
    // Enrolment only happens when a city owes a nudge, so entries is never
    // empty in practice; the rule still holds if it were.
    expect(applyUserTier([], "dormant", EMPTY_REMINDER_STATE, TODAY).action).toBe("farewell");
  });
});
