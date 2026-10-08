import {
  HEALTH_METRICS,
  METRIC_BOUNDS,
  effectiveHealthGoal,
  isHealthGoal,
  presetHealthGoal,
} from "../healthGoal";

describe("presetHealthGoal", () => {
  it("maps the app picker's three Health presets", () => {
    expect(presetHealthGoal("Walk 10,000 steps")).toEqual({ metric: "steps", target: 10000 });
    expect(presetHealthGoal("Exercise for 30 min")).toEqual({ metric: "exercise_minutes", target: 30 });
    expect(presetHealthGoal("Meditate for 10 min")).toEqual({ metric: "mindful_minutes", target: 10 });
  });
  it("matches case-insensitively after trimming", () => {
    expect(presetHealthGoal("  walk 10,000 STEPS ")).toEqual({ metric: "steps", target: 10000 });
    expect(presetHealthGoal("MEDITATE FOR 10 MIN")).toEqual({ metric: "mindful_minutes", target: 10 });
  });
  it("ignores anything else", () => {
    expect(presetHealthGoal("Walk 10000 steps")).toBeNull();
    expect(presetHealthGoal("Run 1 mile")).toBeNull();
    expect(presetHealthGoal("")).toBeNull();
    expect(presetHealthGoal(undefined)).toBeNull();
    expect(presetHealthGoal(42)).toBeNull();
  });
  it("hands out a copy, not the shared preset", () => {
    const a = presetHealthGoal("Walk 10,000 steps")!;
    a.target = 1;
    expect(presetHealthGoal("Walk 10,000 steps")!.target).toBe(10000);
  });
});

describe("effectiveHealthGoal", () => {
  it("absent → derived from the goal text", () => {
    expect(effectiveHealthGoal({ daily_goal: "Exercise for 30 min" })).toEqual({ metric: "exercise_minutes", target: 30 });
    expect(effectiveHealthGoal({ daily_goal: "Read 10 pages" })).toBeNull();
  });
  it("an explicit object wins over the text", () => {
    expect(
      effectiveHealthGoal({ daily_goal: "Walk 10,000 steps", health_goal: { metric: "workout", target: 20, activity: "Running" } }),
    ).toEqual({ metric: "workout", target: 20, activity: "Running" });
    expect(effectiveHealthGoal({ daily_goal: "Read", health_goal: { metric: "steps", target: 5000 } })).toEqual({
      metric: "steps",
      target: 5000,
    });
  });
  it("an explicit null turns Health off, even for a preset goal", () => {
    expect(effectiveHealthGoal({ daily_goal: "Walk 10,000 steps", health_goal: null })).toBeNull();
  });
  it("a malformed stored goal counts as off", () => {
    expect(effectiveHealthGoal({ daily_goal: "Walk 10,000 steps", health_goal: { metric: "sleep", target: 8 } })).toBeNull();
  });
  it("strips unknown fields", () => {
    expect(effectiveHealthGoal({ health_goal: { metric: "steps", target: 8000, extra: 1 } })).toEqual({ metric: "steps", target: 8000 });
  });
});

describe("isHealthGoal + METRIC_BOUNDS", () => {
  it("has the four metrics and their bounds", () => {
    expect([...HEALTH_METRICS]).toEqual(["steps", "exercise_minutes", "workout", "mindful_minutes"]);
    expect(METRIC_BOUNDS).toEqual({ steps: 200000, exercise_minutes: 1440, workout: 1440, mindful_minutes: 1440 });
  });
  it("accepts targets from 1 to the bound, inclusive", () => {
    for (const metric of HEALTH_METRICS) {
      expect(isHealthGoal({ metric, target: 1 })).toBe(true);
      expect(isHealthGoal({ metric, target: METRIC_BOUNDS[metric] })).toBe(true);
      expect(isHealthGoal({ metric, target: 0 })).toBe(false);
      expect(isHealthGoal({ metric, target: METRIC_BOUNDS[metric] + 1 })).toBe(false);
    }
  });
  it("rejects non-integer targets, unknown metrics, and non-objects", () => {
    expect(isHealthGoal({ metric: "steps", target: 10.5 })).toBe(false);
    expect(isHealthGoal({ metric: "steps", target: "10000" })).toBe(false);
    expect(isHealthGoal({ metric: "sleep", target: 8 })).toBe(false);
    expect(isHealthGoal(null)).toBe(false);
    expect(isHealthGoal([])).toBe(false);
    expect(isHealthGoal("steps")).toBe(false);
  });
  it("activity is optional, 1..30 chars", () => {
    expect(isHealthGoal({ metric: "workout", target: 30, activity: "Running" })).toBe(true);
    expect(isHealthGoal({ metric: "workout", target: 30, activity: "x".repeat(30) })).toBe(true);
    expect(isHealthGoal({ metric: "workout", target: 30, activity: "x".repeat(31) })).toBe(false);
    expect(isHealthGoal({ metric: "workout", target: 30, activity: "" })).toBe(false);
    expect(isHealthGoal({ metric: "workout", target: 30, activity: 7 })).toBe(false);
  });
});
