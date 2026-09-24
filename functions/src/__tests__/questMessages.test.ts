import { mergeQuestConfig, offerQuest, CitySignals, Quest } from "../quests";
import {
  QUEST_TITLE,
  objectiveOf,
  progressLineOf,
  questCompletedNotice,
  questEndingNotice,
  questOfferedNotice,
  questProgressNotice,
  questReminderClause,
  rewardPhrase,
  withDisplay,
} from "../questMessages";
import { seededRng } from "../seededRng";

const TODAY = "2026-09-23";
const ON = mergeQuestConfig({ enabled: true });
const s = (over: Partial<CitySignals> = {}): CitySignals => ({
  cityId: "g", today: TODAY, activeMembers: 1, buildings: 2, winRate14: 0.6, idleDays: 0,
  paused: false, hasBuild: false, quest: null, history: [], ...over,
});
const invite = () => offerQuest("invite_bonus", s(), ON, seededRng(3));

describe("quest copy", () => {
  it("the titles from the brief", () => {
    expect(QUEST_TITLE.promotion).toBe("Incoming Promotion!");
    expect(QUEST_TITLE.material_sale).toBe("Material Sale!");
    expect(QUEST_TITLE.invite_bonus).toBe("Invite friends bonus!");
  });

  it("states the objective and the reward", () => {
    const q = invite();
    expect(rewardPhrase(q)).toMatch(/^(an?|the) .+ \+ 100 bricks$/);
    expect(objectiveOf(q)).toMatch(/^Invite a friend and complete a day together to win /);
    const sale = offerQuest("material_sale", s({ buildings: 4, activeMembers: 3 }), ON, seededRng(3));
    expect(objectiveOf(sale)).toBe("Medium builds are open to you, at 2 days each. Land one for 40 bricks.");
    const promo = offerQuest("promotion", s({ buildings: 12, activeMembers: 3 }), ON, seededRng(3));
    expect(objectiveOf(promo)).toBe("Land a 3-day build and get a second building free + 60 bricks.");
  });

  it("the progress line follows the steps", () => {
    const q = invite();
    expect(progressLineOf(q)).toBe("Waiting for a friend to join");
    const joined: Quest = { ...q, progress: { ...q.progress, step: 1, joined: "Tom" } };
    expect(progressLineOf(joined)).toBe("Tom joined — now complete a day together");
    expect(progressLineOf({ ...q, status: "completed" })).toBe("Complete!");
  });

  it("offer / progress / ending / completed pushes are labelled and once-only", () => {
    const q = invite();
    const offered = questOfferedNotice(q, "Riverside");
    expect(offered.title).toBe("🎁 Invite friends bonus!");
    expect(offered.body).toMatch(/Ends \w+day\.$/);
    expect(offered.meta).toMatchObject({ type: "quest_offered", category: "quest", dedupeKey: `quest:${q.key}:offered` });
    expect(questProgressNotice(q, "Riverside")).toBeNull();
    const p = questProgressNotice({ ...q, progress: { ...q.progress, step: 1, joined: "Tom" } }, "Riverside")!;
    expect(p.title).toBe("👋 Tom joined Riverside");
    expect(questEndingNotice(q, "Riverside").title).toBe("⏳ Last day: Invite friends bonus!");
    const done = questCompletedNotice({ ...q, status: "completed" }, "Riverside", "apartment_c");
    expect(done.title).toBe("🏆 Invite friends bonus complete");
    expect(done.body).toBe("Riverside won the Apartments + 100 bricks each.");
  });

  it("the comeback offer is the one winback message", () => {
    const back = offerQuest("comeback", s({ idleDays: 5, activeMembers: 3 }), ON, seededRng(3));
    const n = questOfferedNotice(back, "Riverside");
    expect(n.meta.category).toBe("winback");
    expect(n.body).toBe("Riverside misses you. Complete one day together to earn a hard hat + 30 bricks.");
  });

  it("adds the quest's stake to reminders while it runs", () => {
    const q = invite();
    expect(questReminderClause(q, TODAY)).toBe(" The Invite friends bonus is on.");
    expect(questReminderClause({ ...q, ends_on: TODAY }, TODAY)).toBe(" The Invite friends bonus ends today.");
    expect(questReminderClause({ ...q, status: "expired" }, TODAY)).toBe("");
    expect(questReminderClause(null, TODAY)).toBe("");
  });

  it("withDisplay writes the card's words onto the quest", () => {
    const d = withDisplay(invite()).display!;
    expect(d.title).toBe("Invite friends bonus!");
    expect(d.progress).toBe("Waiting for a friend to join");
    expect(d.reward).toMatch(/100 bricks/);
  });
});
