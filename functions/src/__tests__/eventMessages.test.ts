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
  healthReadingTitle,
  articleForNumber,
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

  it("teammate completed with a shared Health reading leads with the numbers", () => {
    const base = { target: 1, sources: ["Apple Watch"] };
    const steps = teammateCompletedNotice("Riverside", "Tom", "2026-10-07", { ...base, metric: "steps", value: 12345 });
    expect(steps.title).toBe("👟 Tom hit 12,345 steps");
    expect(steps.body).toBe("Tom finished today's goal in Riverside.");
    expect(steps.categoryId).toBe(NotificationCategory.TEAMMATE_COMPLETED);
    expect(steps.data).toEqual({ completed_by: "Tom", proof_date: "2026-10-07" });
    expect(steps.meta).toMatchObject({ type: "teammate_completed", priority: "transactional", variant: "teammate_completed.health.v1" });

    expect(teammateCompletedNotice("R", "Tom", "d", { ...base, metric: "exercise_minutes", value: 42 }).title).toBe(
      "⏱ Tom got 42 min of exercise",
    );
    expect(teammateCompletedNotice("R", "Tom", "d", { ...base, metric: "mindful_minutes", value: 12 }).title).toBe(
      "🧘 Tom did 12 mindful minutes",
    );
    expect(
      teammateCompletedNotice("R", "Tom", "d", { ...base, metric: "workout", value: 45, workout: { activity: "run", minutes: 45, km: 8.2 } }).title,
    ).toBe("🏃 Tom logged an 8.2 km run");
    expect(
      teammateCompletedNotice("R", "Tom", "d", { ...base, metric: "workout", value: 40, workout: { activity: "yoga session", minutes: 40 } }).title,
    ).toBe("🏃 Tom logged a 40-min yoga session");
    expect(teammateCompletedNotice("R", "Tom", "d", { ...base, metric: "workout", value: 30 }).title).toBe(
      "🏃 Tom logged a 30-min workout",
    );
  });

  it("no Health reading → the plain or photo push, unchanged", () => {
    expect(teammateCompletedNotice("Riverside", "Tom", null, null).meta.variant).toBe("teammate_completed.v1");
    expect(teammateCompletedNotice("Riverside", "Tom", null, null).data).toEqual({ completed_by: "Tom" });
    expect(teammateCompletedNotice("Riverside", "Tom", "2026-09-25", null).meta.variant).toBe("teammate_completed.photo.v1");
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
    teammateCompletedNotice("R", "Tom", "2026-09-25", { metric: "steps", value: 10000, target: 10000, sources: [] }),
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
