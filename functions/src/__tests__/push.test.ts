import { apsFor, dataFor, isValidPushToken, NotificationCategory } from "../push";

describe("apsFor", () => {
  const base = { title: "Bitty City", body: "Ana completed today's goal." };

  it("always renders a visible alert (never a silent push)", () => {
    const aps = apsFor(base);
    expect(aps.alert).toEqual({ title: base.title, body: base.body });
    expect(aps.sound).toBe("default");
  });

  it("omits `category` entirely when the payload has none", () => {
    expect(apsFor(base)).not.toHaveProperty("category");
  });

  it("stamps aps.category so iOS attaches that category's buttons", () => {
    const aps = apsFor({ ...base, categoryId: NotificationCategory.TEAMMATE_COMPLETED });
    expect(aps.category).toBe("bitty.teammate-completed");
  });
});

describe("dataFor", () => {
  it("stringifies every value — FCM data must be strings", () => {
    const data = dataFor({
      title: "t",
      body: "b",
      data: { group_id: "g1", count: 3, flag: true },
    });
    expect(data).toEqual({ group_id: "g1", count: "3", flag: "true" });
  });

  it("mirrors the category into data so a foreground redraw keeps its buttons", () => {
    const data = dataFor({
      title: "t",
      body: "b",
      data: { group_id: "g1" },
      categoryId: NotificationCategory.TEAMMATE_COMPLETED,
    });
    expect(data.category).toBe("bitty.teammate-completed");
  });

  it("adds no category key when the payload has none", () => {
    expect(dataFor({ title: "t", body: "b" })).toEqual({});
  });
});

describe("NotificationCategory", () => {
  // The app registers these ids natively (mobile/src/notifications/categories.ts).
  // A rename on one side without the other means iOS drops the buttons
  // silently, so both repos pin the literal.
  it("pins the teammate-completed id", () => {
    expect(NotificationCategory.TEAMMATE_COMPLETED).toBe("bitty.teammate-completed");
  });
});

describe("isValidPushToken", () => {
  it("accepts a plausible FCM token and rejects junk", () => {
    expect(isValidPushToken("abc123")).toBe(true);
    expect(isValidPushToken("")).toBe(false);
    expect(isValidPushToken(null)).toBe(false);
    expect(isValidPushToken("x".repeat(5000))).toBe(false);
  });
});
