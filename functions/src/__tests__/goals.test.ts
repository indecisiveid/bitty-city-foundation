import { isGoalCategory, normalizeGoalCategory } from "../goals";
import { requireGoalCategory } from "../utils";
import { citySettingsChangedMessage } from "../crewMessages";

describe("goal categories", () => {
  it("absent or unknown reads as custom", () => {
    expect(normalizeGoalCategory(undefined)).toBe("custom");
    expect(normalizeGoalCategory("yoga")).toBe("custom");
    expect(normalizeGoalCategory("body")).toBe("body");
  });

  it("only known categories validate", () => {
    expect(isGoalCategory("mind")).toBe(true);
    expect(isGoalCategory("exercise")).toBe(false);
    expect(requireGoalCategory(undefined)).toBe("custom");
    expect(requireGoalCategory(null)).toBe("custom");
    expect(requireGoalCategory("focus")).toBe("focus");
    expect(() => requireGoalCategory("exercise")).toThrow("goal_category");
  });
});

describe("city settings copy", () => {
  it("a new goal names the goal and says today's check-ins stand", () => {
    const m = citySettingsChangedMessage("Riley", "Riverside", { newGoal: "Stretch 10 min" })!;
    expect(m.title).toBe("🎯 Riley changed the goal");
    expect(m.body).toBe('"Stretch 10 min" in Riverside. Today\'s check-ins still count.');
  });

  it("a rename alone is in-app only", () => {
    expect(citySettingsChangedMessage("Riley", "Riverside", { newName: "Lakeside" })).toBeNull();
  });

  it("both at once name the goal under the new name", () => {
    const m = citySettingsChangedMessage("Riley", "Riverside", { newName: "Lakeside", newGoal: "Read" })!;
    expect(m.body).toContain('"Read" in Lakeside.');
  });

  it("a category change alone is silent", () => {
    expect(citySettingsChangedMessage("Riley", "Riverside", {})).toBeNull();
  });
});
