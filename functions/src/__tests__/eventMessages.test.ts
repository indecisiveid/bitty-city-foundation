/**
 * Every event push, now a labelled Notice. Pins the words that moved out of
 * the handlers (unchanged), and the labels the policy and the app rely on.
 */
import {
  buildRescuedNotice,
  buildStalledNotice,
  cityGrewNotice,
  kudosNotice,
  nextUpNotice,
  notice,
  peerNudgeNotice,
  restoringNotice,
  streakRepairedNotice,
  teammateCompletedNotice,
  proofPostedNotice,
  testNotice,
} from "../eventMessages";
import { NotificationCategory } from "../push";

describe("event notices keep their words", () => {
  it("city grew / restored", () => {
    expect(cityGrewNotice("Riverside", "Cottage", false)).toMatchObject({
      title: "🏙️ Riverside grew!",
      body: "Your crew finished a Cottage. Come see it in the city.",
    });
    expect(cityGrewNotice("Riverside", "Apartments", true).title).toBe("🧱 Riverside is whole again");
  });

  it("stall: hard mode never promises the easy-mode save", () => {
    expect(buildStalledNotice("Park", "hard").body).toBe(
      "Not everyone finished yesterday. No hard hats left. Open the city today to see your options.",
    );
    expect(buildStalledNotice("Park", "easy").body).toContain("Nobody finished yesterday.");
  });

  it("teammate completed carries the kudos button and who completed", () => {
    const n = teammateCompletedNotice("Riverside", "Tom");
    expect(n.body).toBe("Tom completed today's goal. Your turn!");
    expect(n.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(n.data).toEqual({ completed_by: "Tom" });
    expect(n.meta.variant).toBe("teammate_completed.v1");
  });

  it("teammate completed with a photo says so and opens the proof", () => {
    const n = teammateCompletedNotice("Riverside", "Tom", "2026-09-25");
    expect(n.title).toBe("📸 Tom posted proof");
    expect(n.body).toBe("Tom finished today's goal in Riverside.");
    // Still the kudos category: the recipients are still pending.
    expect(n.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(n.data).toEqual({ completed_by: "Tom", proof_date: "2026-09-25" });
    expect(n.meta).toMatchObject({ type: "teammate_completed", priority: "transactional", variant: "teammate_completed.photo.v1" });
  });

  it("proof posted — to crewmates already done: no kudos button, budgeted", () => {
    const n = proofPostedNotice("Riverside", "Tom", "2026-09-25");
    expect(n.title).toBe("📸 Tom posted proof");
    expect(n.body).toBe("Tom finished today's goal in Riverside. Tap to see the photo.");
    expect(n.categoryId).toBeUndefined();
    expect(n.data).toEqual({ completed_by: "Tom", proof_date: "2026-09-25" });
    expect(n.meta).toMatchObject({ type: "proof_posted", category: "social", priority: "normal" });
  });

  it("next up / restoring / rescue / repair / kudos / nudge", () => {
    expect(nextUpNotice("Riverside", "Amit", "Apartments", 3).body).toBe(
      "Amit picked the Apartments for Riverside. It takes 3 days of everyone completing their goal.",
    );
    expect(restoringNotice("building", "Riverside", "Amit", "Cottage", 1).body).toContain("Today's goal restores it.");
    expect(restoringNotice("park", "Riverside", "Amit", "Park", 3).title).toBe("🌳 Restoring a Park");
    expect(buildRescuedNotice("Park", "Amit").title).toBe("🪖 The Park build is back on");
    expect(streakRepairedNotice(9, "Amit", null).body).toBe("Amit used a hard hat to bring back your streak.");
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
    proofPostedNotice("R", "Tom", "2026-09-25"),
    nextUpNotice("R", "A", "Cottage", 1),
    restoringNotice("building", "R", "A", "Cottage", 1),
    restoringNotice("park", "R", "A", "Park", 2),
    buildRescuedNotice("Park", "A"),
    streakRepairedNotice(3, "A", "Park"),
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
