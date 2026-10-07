/**
 * Every event push, as a labelled Notice. Pins the words (October 2026 short
 * copy) and the labels the policy and the app rely on.
 */
import {
  buildStalledNotice,
  cityGrewNotice,
  kudosNotice,
  notice,
  peerNudgeNotice,
  teammateCompletedNotice,
  testNotice,
} from "../eventMessages";
import { NotificationCategory } from "../push";

describe("event notices keep their words", () => {
  it("city grew / restored", () => {
    expect(cityGrewNotice("Riverside", "Cottage", false)).toMatchObject({
      title: "🏙️ Riverside grew!",
      body: "Your crew built a Cottage.",
    });
    expect(cityGrewNotice("Riverside", "Apartments", true)).toMatchObject({
      title: "🧱 Riverside is whole again",
      body: "Your crew restored the Apartments.",
    });
  });

  it("stall: hard mode never promises the easy-mode save", () => {
    expect(buildStalledNotice("Park", "hard").body).toBe(
      "Not everyone finished yesterday. No hard hats left. Open the city today to see your options.",
    );
    expect(buildStalledNotice("Park", "easy").body).toContain("Nobody finished yesterday.");
  });

  it("first finisher: your turn, with the kudos button and who completed", () => {
    const n = teammateCompletedNotice("Riverside", "Tom");
    expect(n.title).toBe("✅ Tom finished");
    expect(n.body).toBe("Your turn in Riverside.");
    expect(n.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(n.data).toEqual({ completed_by: "Tom" });
    expect(n.meta.variant).toBe("teammate_completed.first.v2");
  });

  it("one person left: says it's on them", () => {
    const n = teammateCompletedNotice("Riverside", "Tom", null, true);
    expect(n.body).toBe("You're the last one in Riverside.");
    expect(n.meta.variant).toBe("teammate_completed.last.v2");
  });

  it("with a photo the title says so and a tap opens the proof", () => {
    const n = teammateCompletedNotice("Riverside", "Tom", "2026-09-25");
    expect(n.title).toBe("📸 Tom posted proof");
    expect(n.body).toBe("Your turn in Riverside.");
    // Still the kudos category: the recipients are still pending.
    expect(n.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(n.data).toEqual({ completed_by: "Tom", proof_date: "2026-09-25" });
    expect(n.meta).toMatchObject({ type: "teammate_completed", priority: "transactional", variant: "teammate_completed.first.photo.v2" });
  });

  it("kudos / nudge carry who sent them", () => {
    expect(kudosNotice("Amit").data).toEqual({ from: "Amit" });
    expect(peerNudgeNotice("Amit", "x").data).toEqual({ from: "Amit" });
  });
});

describe("labels", () => {
  const all = [
    cityGrewNotice("R", "Cottage", false),
    cityGrewNotice("R", "Cottage", true),
    buildStalledNotice("Park", "hard"),
    buildStalledNotice("Park", "easy"),
    teammateCompletedNotice("R", "Tom"),
    teammateCompletedNotice("R", "Tom", "2026-09-25"),
    teammateCompletedNotice("R", "Tom", null, true),
    teammateCompletedNotice("R", "Tom", "2026-09-25", true),
    kudosNotice("A"),
    peerNudgeNotice("A", "x"),
    testNotice(),
  ];

  it("every notice has a type, a category, a priority and a variant", () => {
    for (const n of all) {
      expect(n.meta.type).toMatch(/^[a-z_]+$/);
      expect(n.meta.variant).toMatch(/^[a-z_.]+\.v\d+$/);
    }
  });

  it("variant ids are unique — they're what open rates are compared by", () => {
    const ids = all.map((n) => n.meta.variant);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a person acting on you is transactional; a stall is important", () => {
    expect(kudosNotice("A").meta).toMatchObject({ category: "social", priority: "transactional" });
    expect(teammateCompletedNotice("R", "T").meta).toMatchObject({ category: "social", priority: "transactional" });
    expect(buildStalledNotice("P", "hard").meta.priority).toBe("important");
    expect(cityGrewNotice("R", "C", false).meta).toMatchObject({ category: "crew", priority: "normal" });
  });

  it("notice() wraps copy from the other pure modules", () => {
    const meta = { type: "member_joined", category: "crew" as const, priority: "normal" as const, variant: "member_joined.v1" };
    expect(notice({ title: "t", body: "b" }, meta)).toEqual({ title: "t", body: "b", meta });
  });
});
