/**
 * Every event push, as a labelled Notice. Pins the words (October 2026 short
 * copy) and the labels the policy and the app rely on.
 */
import {
  buildStalledNotice,
  cityGrewNotice,
  kudosNotice,
  notice,
  proofCommentNotice,
  threadCommentNotice,
  peerNudgeNotice,
  teammateCompletedNotice,
  testNotice,
  healthReadingTitle,
  articleForNumber,
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

  it("with a photo the title says how they finished and a tap opens the proof", () => {
    const n = teammateCompletedNotice("Riverside", "Tom", { status: "photo", date: "2026-09-25" });
    expect(n.title).toBe("📸 Tom finished with a photo");
    expect(n.body).toBe("Your turn in Riverside.");
    // Still the kudos category: the recipients are still pending.
    expect(n.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(n.data).toEqual({ completed_by: "Tom", proof_date: "2026-09-25" });
    expect(n.meta).toMatchObject({ type: "teammate_completed", priority: "transactional", variant: "teammate_completed.first.photo.v2" });
  });

  it("a skipped proof — or a Health reading kept private — reads as a plain finish", () => {
    for (const proof of [{ status: "skipped" as const, date: "2026-09-25" }, { status: "health" as const, date: "2026-09-25" }]) {
      const n = teammateCompletedNotice("Riverside", "Tom", proof);
      expect(n.title).toBe("✅ Tom finished");
      expect(n.data).toEqual({ completed_by: "Tom" });
      expect(n.meta.variant).toBe("teammate_completed.first.v2");
    }
  });

  it("a shared Health reading leads with the numbers", () => {
    const base = { target: 1, sources: ["Apple Watch"] };
    const health = (h: Record<string, unknown>) =>
      ({ status: "health" as const, date: "2026-10-07", health: { ...base, ...h } as never });
    const steps = teammateCompletedNotice("Riverside", "Tom", health({ metric: "steps", value: 12345 }));
    expect(steps.title).toBe("👟 Tom hit 12,345 steps");
    expect(steps.body).toBe("Your turn in Riverside.");
    expect(steps.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(steps.data).toEqual({ completed_by: "Tom", proof_date: "2026-10-07" });
    expect(steps.meta).toMatchObject({ type: "teammate_completed", priority: "transactional", variant: "teammate_completed.first.health.v2" });

    expect(teammateCompletedNotice("R", "Tom", health({ metric: "exercise_minutes", value: 42 })).title).toBe(
      "⏱ Tom got 42 min of exercise",
    );
    expect(teammateCompletedNotice("R", "Tom", health({ metric: "mindful_minutes", value: 12 })).title).toBe(
      "🧘 Tom did 12 mindful minutes",
    );
    expect(
      teammateCompletedNotice("R", "Tom", health({ metric: "workout", value: 45, workout: { activity: "run", minutes: 45, km: 8.2 } })).title,
    ).toBe("🏃 Tom logged an 8.2 km run");
    expect(
      teammateCompletedNotice("R", "Tom", health({ metric: "workout", value: 40, workout: { activity: "yoga session", minutes: 40 } })).title,
    ).toBe("🏃 Tom logged a 40-min yoga session");
    expect(teammateCompletedNotice("R", "Tom", health({ metric: "workout", value: 30 })).title).toBe(
      "🏃 Tom logged a 30-min workout",
    );
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
    teammateCompletedNotice("R", "Tom", { status: "photo", date: "2026-09-25" }),
    teammateCompletedNotice("R", "Tom", null, true),
    teammateCompletedNotice("R", "Tom", { status: "photo", date: "2026-09-25" }, true),
    teammateCompletedNotice("R", "Tom", {
      status: "health",
      date: "2026-09-25",
      health: { metric: "steps", value: 10000, target: 10000, sources: [] },
    }),
    kudosNotice("A"),
    peerNudgeNotice("A", "x"),
    proofCommentNotice("A", "nice", "2026-10-07", "B"),
    threadCommentNotice("A", "B", "nice", "2026-10-07"),
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

describe("healthReadingTitle", () => {
  const workout = (activity: string, minutes: number, km?: number) => ({
    metric: "workout" as const,
    value: minutes,
    target: 20,
    sources: ["Strava"],
    workout: { activity, minutes, ...(km !== undefined ? { km } : {}) },
  });
  it("words each metric for the crew", () => {
    expect(healthReadingTitle("Sam", { metric: "steps", value: 10212, target: 10000, sources: [] })).toBe("👟 Sam hit 10,212 steps");
    expect(healthReadingTitle("Sam", { metric: "mindful_minutes", value: 12, target: 10, sources: [] })).toBe("🧘 Sam did 12 mindful minutes");
    expect(healthReadingTitle("Sam", workout("run", 28, 5.2))).toBe("🏃 Sam logged a 5.2 km run");
  });
  it("uses 'an' where the number is spoken with a vowel", () => {
    expect(healthReadingTitle("Sam", workout("run", 45, 8.2))).toBe("🏃 Sam logged an 8.2 km run");
    expect(healthReadingTitle("Sam", workout("ride", 80))).toBe("🏃 Sam logged an 80-min ride");
    expect(healthReadingTitle("Sam", workout("walk", 11))).toBe("🏃 Sam logged an 11-min walk");
    expect(healthReadingTitle("Sam", workout("walk", 21))).toBe("🏃 Sam logged a 21-min walk");
    expect(articleForNumber(18)).toBe("an");
    expect(articleForNumber(180)).toBe("a");
  });
});

describe("proof comments", () => {
  it("tells the owner who commented, says what, and opens that proof", () => {
    const n = proofCommentNotice("Amit", "Great run!\nSee you tomorrow", "2026-10-07", "Tom");
    expect(n.title).toBe("💬 Amit commented on your proof");
    expect(n.body).toBe("Great run!");
    expect(n.data).toEqual({ from: "Amit", proof_date: "2026-10-07", proof_member: "Tom" });
    expect(n.meta).toMatchObject({ type: "proof_comment", category: "social", priority: "transactional" });
  });

  it("a follow-up on someone else's proof is social but not transactional", () => {
    const n = threadCommentNotice("Amit", "Tom", "same", "2026-10-07");
    expect(n.title).toBe("💬 Amit on Tom’s proof");
    expect(n.data).toMatchObject({ proof_date: "2026-10-07", proof_member: "Tom" });
    expect(n.meta).toMatchObject({ category: "social", priority: "normal" });
  });
});
