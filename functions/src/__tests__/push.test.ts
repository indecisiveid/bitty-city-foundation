import { apsFor, dataFor, isValidPushToken, NotificationCategory } from "../push";
import { downloadUrlFor } from "../proofStorage";

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

  it("stamps aps.threadId so one city's pushes stack together", () => {
    expect(apsFor({ ...base, threadId: "group-1" }).threadId).toBe("group-1");
    expect(apsFor(base)).not.toHaveProperty("threadId");
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

describe("apsFor — quiet delivery", () => {
  it("drops the sound and marks the push passive in quiet hours", () => {
    const aps = apsFor({ title: "t", body: "b", quiet: true }) as Record<string, unknown>;
    expect(aps.sound).toBeUndefined();
    expect(aps["interruption-level"]).toBe("passive");
    expect((apsFor({ title: "t", body: "b" }) as Record<string, unknown>).sound).toBe("default");
  });
});

describe("a picture on the banner", () => {
  const base = { title: "📸 Tom finished with a photo", body: "Your turn in Riverside." };
  const imageUrl = "https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2Fg%2Fu%2Fx.jpg?alt=media&token=t";

  it("lets the notification service extension rewrite the push", () => {
    expect(apsFor({ ...base, imageUrl }).mutableContent).toBe(true);
    expect(apsFor(base)).not.toHaveProperty("mutableContent");
  });

  it("carries the URL in data for the foreground banner", () => {
    expect(dataFor({ ...base, imageUrl }).image_url).toBe(imageUrl);
    expect(dataFor(base)).not.toHaveProperty("image_url");
  });
});

describe("downloadUrlFor", () => {
  it("encodes the object path and token the way getDownloadURL does", () => {
    expect(downloadUrlFor("bitty-city.firebasestorage.app", "proofs/g1/u1/abc-123.jpg", "tok")).toBe(
      "https://firebasestorage.googleapis.com/v0/b/bitty-city.firebasestorage.app/o/proofs%2Fg1%2Fu1%2Fabc-123.jpg?alt=media&token=tok",
    );
  });
});
