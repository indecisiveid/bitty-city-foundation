/**
 * Unit tests for the pure daily-nudge decision logic.
 */
import {
  decideNudge,
  reminderHour,
  REMIND_LEAD_HOURS,
  NudgeInput,
} from "../reminderLogic";
import { INACTIVITY_METEOR_DAYS } from "../gameLogic";
import { isExpoPushToken } from "../push";

const base: NudgeInput = {
  localHour: reminderHour(0), // reset at midnight → nudge 3h before
  resetHour: 0,
  todayGameDate: "2026-07-14",
  lastReminderDate: null,
  memberCount: 3,
  completedCount: 1,
  streak: 0,
  idleDays: 0,
};

describe("reminderHour", () => {
  it("is REMIND_LEAD_HOURS before reset, wrapping past midnight", () => {
    expect(reminderHour(0)).toBe(24 - REMIND_LEAD_HOURS); // 21
    expect(reminderHour(9)).toBe(9 - REMIND_LEAD_HOURS); // 6
    expect(reminderHour(2)).toBe((2 - REMIND_LEAD_HOURS + 24) % 24); // 23
  });
});

describe("decideNudge", () => {
  it("only fires on the group's reminder hour", () => {
    expect(decideNudge({ ...base, localHour: base.localHour })).not.toBeNull();
    expect(decideNudge({ ...base, localHour: (base.localHour + 1) % 24 })).toBeNull();
  });

  it("fires at most once per game-day", () => {
    expect(decideNudge({ ...base, lastReminderDate: "2026-07-14" })).toBeNull();
    expect(decideNudge({ ...base, lastReminderDate: "2026-07-13" })).not.toBeNull();
  });

  it("stays silent when the whole crew is done", () => {
    expect(decideNudge({ ...base, completedCount: 3, memberCount: 3 })).toBeNull();
  });

  it("stays silent for an empty group", () => {
    expect(decideNudge({ ...base, memberCount: 0, completedCount: 0 })).toBeNull();
  });

  it("plain reminder when no streak and not idle", () => {
    const n = decideNudge(base);
    expect(n).toEqual({ kind: "reminder", recipients: "incomplete" });
  });

  it("escalates to a streak nudge when a streak is live", () => {
    const n = decideNudge({ ...base, streak: 5 });
    expect(n).toEqual({ kind: "streak", recipients: "incomplete" });
  });

  it("escalates to a meteor warning to ALL when idle one day short of the threshold", () => {
    const n = decideNudge({
      ...base,
      streak: 5, // meteor outranks streak
      idleDays: INACTIVITY_METEOR_DAYS - 1,
    });
    expect(n).toEqual({ kind: "meteor", recipients: "all" });
  });

  it("does not warn meteor when still comfortably active", () => {
    const n = decideNudge({ ...base, idleDays: INACTIVITY_METEOR_DAYS - 2 });
    expect(n?.kind).not.toBe("meteor");
  });
});

describe("isExpoPushToken", () => {
  it("accepts Expo token shapes and rejects junk", () => {
    expect(isExpoPushToken("ExponentPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("not-a-token")).toBe(false);
    expect(isExpoPushToken("")).toBe(false);
    expect(isExpoPushToken(null)).toBe(false);
    expect(isExpoPushToken(42)).toBe(false);
  });
});
