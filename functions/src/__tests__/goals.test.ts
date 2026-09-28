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
    expect(m.title).toBe("🎯 Riley changed the goal for Riverside");
    expect(m.body).toContain('"Stretch 10 min"');
    expect(m.body).toContain("still counts");
  });

  it("a rename alone says what the city is called now", () => {
    const m = citySettingsChangedMessage("Riley", "Riverside", { newName: "Lakeside" })!;
    expect(m.title).toBe("🏷️ Riley renamed Riverside");
    expect(m.body).toContain("Riverside is now called Lakeside");
  });

  it("both at once lead with the goal under the new name", () => {
    const m = citySettingsChangedMessage("Riley", "Riverside", { newName: "Lakeside", newGoal: "Read" })!;
    expect(m.title).toBe("🎯 Riley changed the goal for Lakeside");
    expect(m.body).toContain("Riverside is now called Lakeside");
  });

  it("a category change alone is silent", () => {
    expect(citySettingsChangedMessage("Riley", "Riverside", {})).toBeNull();
  });
});
