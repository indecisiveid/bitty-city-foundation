/**
 * Quests — the pure engine. Pins: who is eligible for what, how often a crew
 * gets one (engaged / normal / ignoring / idle), the weighted seeded pick,
 * each quest's steps, expiry, and what a win puts in the city.
 */
import {
  CATALOG_QUESTS,
  CitySignals,
  DEFAULT_QUEST_CONFIG,
  QuestConfig,
  addDaysYmd,
  completionUpdates,
  expireQuest,
  gapDays,
  mergeQuestConfig,
  nextTierBuilding,
  offerQuest,
  onBuildStarted,
  onCompletion,
  onJoin,
  onLanding,
  placeBonusBuilding,
  pushHistory,
  rollQuest,
  salePeekAllows,
  tiers,
  winRate,
} from "../quests";
import { seededRng } from "../seededRng";

const TODAY = "2026-09-23";
const ON: QuestConfig = mergeQuestConfig({ enabled: true });
const rng = () => seededRng(7);

const signals = (over: Partial<CitySignals> = {}): CitySignals => ({
  cityId: "g",
  today: TODAY,
  activeMembers: 3,
  buildings: 12,
  winRate14: 0.6,
  idleDays: 0,
  paused: false,
  hasBuild: false,
  quest: null,
  history: [],
  ...over,
});

const emptyMap = (): Record<string, (string | null)[]> =>
  Object.fromEntries(Array.from({ length: 3 }, (_, r) => [String(r), [null, null, null] as (string | null)[]]));

describe("config", () => {
  it("ships switched off", () => {
    expect(DEFAULT_QUEST_CONFIG.enabled).toBe(false);
    expect(rollQuest(signals(), DEFAULT_QUEST_CONFIG, rng())).toBeNull();
  });

  it("merges config/quests over the defaults, ignoring junk", () => {
    const c = mergeQuestConfig({ enabled: true, engagedGapDays: 3, weights: { promotion: 0, bogus: 9 }, saleDays: "x" });
    expect(c.enabled).toBe(true);
    expect(c.engagedGapDays).toBe(3);
    expect(c.weights.promotion).toBe(0);
    expect(c.weights.invite_bonus).toBe(DEFAULT_QUEST_CONFIG.weights.invite_bonus);
    expect(c.saleDays).toBe(DEFAULT_QUEST_CONFIG.saleDays);
    expect(mergeQuestConfig(null)).toEqual(DEFAULT_QUEST_CONFIG);
  });
});

describe("signals", () => {
  it("win rate over the last 14 days, or since founding", () => {
    const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(TODAY, -i));
    expect(winRate(days, TODAY, null)).toBeCloseTo(0.5);
    expect(winRate(days.slice(0, 3), TODAY, addDaysYmd(TODAY, -3))).toBe(1);
  });

  it("tiers by building count", () => {
    expect(tiers(0)).toEqual({ unlocked: "easy", next: "medium" });
    expect(tiers(10)).toEqual({ unlocked: "medium", next: "challenge" });
    expect(tiers(25)).toEqual({ unlocked: "challenge", next: null });
  });
});

describe("eligibility — each quest has its crew", () => {
  it("invite: solo cities with something built", () => {
    expect(CATALOG_QUESTS.invite_bonus.eligible(signals({ activeMembers: 1, buildings: 1 }), ON)).toBe(true);
    expect(CATALOG_QUESTS.invite_bonus.eligible(signals({ activeMembers: 1, buildings: 0 }), ON)).toBe(false);
    expect(CATALOG_QUESTS.invite_bonus.eligible(signals({ activeMembers: 2 }), ON)).toBe(false);
  });

  it("promotion: Medium unlocked, winning, between builds", () => {
    expect(CATALOG_QUESTS.promotion.eligible(signals(), ON)).toBe(true);
    expect(CATALOG_QUESTS.promotion.eligible(signals({ buildings: 9 }), ON)).toBe(false);
    expect(CATALOG_QUESTS.promotion.eligible(signals({ winRate14: 0.2 }), ON)).toBe(false);
    expect(CATALOG_QUESTS.promotion.eligible(signals({ hasBuild: true }), ON)).toBe(false);
  });

  it("sale: a next tier to peek at, and a few buildings first", () => {
    expect(CATALOG_QUESTS.material_sale.eligible(signals({ buildings: 4 }), ON)).toBe(true);
    expect(CATALOG_QUESTS.material_sale.eligible(signals({ buildings: 1 }), ON)).toBe(false);
    expect(CATALOG_QUESTS.material_sale.eligible(signals({ buildings: 25 }), ON)).toBe(false);
  });

  it("comeback: idle crews", () => {
    expect(CATALOG_QUESTS.comeback.eligible(signals({ idleDays: 3 }), ON)).toBe(true);
    expect(CATALOG_QUESTS.comeback.eligible(signals({ idleDays: 1 }), ON)).toBe(false);
  });
});

describe("rollQuest — cadence by how the crew plays", () => {
  it("never replaces an active quest, never rolls for a paused city", () => {
    const active = offerQuest("promotion", signals(), ON, rng());
    expect(rollQuest(signals({ quest: active }), ON, rng())).toBeNull();
    expect(rollQuest(signals({ paused: true }), ON, rng())).toBeNull();
  });

  it("engaged crews every 5 days, others every 7, ignored quests half as often", () => {
    expect(gapDays(signals({ winRate14: 0.6 }), ON)).toBe(5);
    expect(gapDays(signals({ winRate14: 0.3 }), ON)).toBe(7);
    const ignored = [
      { id: "promotion" as const, offered_on: "2026-09-01", outcome: "expired" as const },
      { id: "material_sale" as const, offered_on: "2026-09-10", outcome: "expired" as const },
    ];
    expect(gapDays(signals({ history: ignored }), ON)).toBe(10);
  });

  it("waits out the gap since the last quest", () => {
    const recent = [{ id: "invite_bonus" as const, offered_on: addDaysYmd(TODAY, -3), outcome: "completed" as const }];
    expect(rollQuest(signals({ history: recent }), ON, rng())).toBeNull();
    const old = [{ id: "invite_bonus" as const, offered_on: addDaysYmd(TODAY, -6), outcome: "completed" as const }];
    expect(rollQuest(signals({ history: old }), ON, rng())).not.toBeNull();
  });

  it("an idle crew gets the comeback quest whatever the gap — at most every 14 days", () => {
    const recent = [{ id: "promotion" as const, offered_on: addDaysYmd(TODAY, -1), outcome: "expired" as const }];
    const q = rollQuest(signals({ idleDays: 5, history: recent }), ON, rng());
    expect(q?.id).toBe("comeback");
    const hadOne = [{ id: "comeback" as const, offered_on: addDaysYmd(TODAY, -10), outcome: "expired" as const }];
    expect(rollQuest(signals({ idleDays: 5, history: hadOne }), ON, rng())).toBeNull();
  });

  it("respects each quest's own cooldown", () => {
    const solo = signals({ activeMembers: 1, buildings: 1, winRate14: 0.1 });
    const invited = [{ id: "invite_bonus" as const, offered_on: addDaysYmd(TODAY, -10), outcome: "expired" as const }];
    expect(rollQuest({ ...solo, history: invited }, ON, rng())).toBeNull(); // 21-day cooldown, nothing else fits
    expect(rollQuest(solo, ON, rng())?.id).toBe("invite_bonus");
  });

  it("picks by weight among the eligible, stable for a seed", () => {
    const counts: Record<string, number> = {};
    const r = seededRng(1);
    for (let i = 0; i < 3000; i++) {
      const id = rollQuest(signals({ buildings: 12 }), ON, r)!.id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    // promotion 2 : sale 2 (invite needs a solo city)
    expect(counts.promotion / 3000).toBeGreaterThan(0.4);
    expect(counts.material_sale / 3000).toBeGreaterThan(0.4);
    expect(rollQuest(signals(), ON, seededRng(5))?.id).toBe(rollQuest(signals(), ON, seededRng(5))?.id);
  });

  it("a weight of 0 switches a quest off", () => {
    const c = mergeQuestConfig({ enabled: true, weights: { material_sale: 0 } });
    for (let i = 0; i < 50; i++) expect(rollQuest(signals(), c, seededRng(i))?.id).toBe("promotion");
  });
});

describe("the quests", () => {
  it("invite: a friend joins, then a day together wins the next tier's building + bricks", () => {
    const q0 = offerQuest("invite_bonus", signals({ activeMembers: 1, buildings: 2 }), ON, rng());
    expect(q0.reward.bricks).toBe(100);
    expect(tiers(2).next).toBe("medium");
    expect(["apartment_e", "apartment_f", "apartment_c", "apartment_d"]).toContain(q0.reward.build);
    expect(onCompletion(q0, { completedActive: 1, dayWon: true, today: TODAY })).toBeNull();
    expect(onJoin(q0, 1, "Tom", TODAY)).toBeNull();
    const t1 = onJoin(q0, 2, "Tom", TODAY)!;
    expect(t1.event).toBe("progress");
    expect(t1.quest.progress).toMatchObject({ step: 1, joined: "Tom" });
    expect(onCompletion(t1.quest, { completedActive: 1, dayWon: true, today: TODAY })).toBeNull();
    const t2 = onCompletion(t1.quest, { completedActive: 2, dayWon: true, today: TODAY })!;
    expect(t2).toMatchObject({ event: "completed", quest: { status: "completed", completed_on: TODAY } });
  });

  it("invite reward climbs with the city: medium → skyscraper → twin towers", () => {
    expect(nextTierBuilding(12, rng())).toBe("skyscraper_slim");
    expect(nextTierBuilding(30, rng())).toBe("skyscraper_twin");
  });

  it("promotion: only a 3-day build started during the quest counts, and it wins a second copy", () => {
    const q = offerQuest("promotion", signals(), ON, rng());
    expect(onBuildStarted(q, "house_a", TODAY)).toBeNull();
    const started = onBuildStarted(q, "apartment_c", TODAY)!;
    expect(started.stamp).toEqual({ quest: q.key });
    expect(onLanding(started.transition!.quest, { quest: "someone-else" }, TODAY)).toBeNull();
    const won = onLanding(started.transition!.quest, { quest: q.key }, TODAY)!;
    expect(won.event).toBe("completed");
  });

  it("sale: peeks the next tier at 2 days, only during the quest", () => {
    const q = offerQuest("material_sale", signals({ buildings: 4 }), ON, rng());
    expect(q.peek).toEqual({ tier: "medium", days: 2 });
    expect(salePeekAllows(q, "apartment_c", TODAY)).toBe(true);
    expect(salePeekAllows(q, "skyscraper_slim", TODAY)).toBe(false);
    expect(salePeekAllows(q, "apartment_c", addDaysYmd(q.ends_on, 1))).toBe(false);
    expect(onBuildStarted(q, "apartment_c", TODAY)!.stamp).toEqual({ quest: q.key, days_required: 2 });
  });

  it("a quest build that lands after the window still wins (the crew started in time)", () => {
    const q = offerQuest("material_sale", signals({ buildings: 4 }), ON, rng());
    const later = addDaysYmd(q.ends_on, 2);
    expect(onLanding(expireQuest(q, later), { quest: q.key }, later)?.event).toBe("completed");
  });

  it("comeback: any won day inside the window", () => {
    const q = offerQuest("comeback", signals({ idleDays: 4 }), ON, rng());
    expect(q.reward).toEqual({ hard_hats: 1, bricks: 30 });
    expect(onCompletion(q, { completedActive: 1, dayWon: false, today: TODAY })).toBeNull();
    expect(onCompletion(q, { completedActive: 1, dayWon: true, today: TODAY })?.event).toBe("completed");
  });

  it("expires after its last day and goes into history", () => {
    const q = offerQuest("comeback", signals({ idleDays: 4 }), ON, rng());
    expect(q.ends_on).toBe(addDaysYmd(TODAY, 2));
    expect(expireQuest(q, q.ends_on)).toBe(q);
    const gone = expireQuest(q, addDaysYmd(q.ends_on, 1))!;
    expect(gone.status).toBe("expired");
    expect(pushHistory([], gone)).toEqual([{ id: "comeback", offered_on: TODAY, outcome: "expired" }]);
    expect(onCompletion(gone, { completedActive: 2, dayWon: true, today: addDaysYmd(q.ends_on, 1) })).toBeNull();
  });
});

describe("rewards", () => {
  it("places a bonus building on an empty lot without touching anything else", () => {
    const map = emptyMap();
    map["0"][0] = "house_a";
    const p = placeBonusBuilding({ cityMap: map, buildOrder: ["0,0"], tileBuildDates: {}, type: "apartment_c", on: TODAY }, rng())!;
    const cells = Object.values(p.city_map).flat().filter(Boolean);
    expect(cells.sort()).toEqual(["apartment_c", "house_a"]);
    expect(p.build_order).toHaveLength(2);
    expect(Object.values(p.tile_build_dates)).toEqual([TODAY]);
    expect(map["0"].filter(Boolean)).toHaveLength(1); // input untouched
  });

  it("a full city still gets its bricks, just no building", () => {
    const full = emptyMap();
    for (const row of Object.values(full)) row.fill("house_a");
    const q = { ...offerQuest("promotion", signals(), ON, rng()), status: "completed" as const };
    const out = completionUpdates(
      { quest: q, cityMap: full, buildOrder: null, tileBuildDates: {}, streakFreezes: 0, freezeCap: 3, history: [], landedType: "apartment_c", today: TODAY },
      rng(),
    );
    expect(out.placed).toBeNull();
    expect(out.quest.granted).toMatchObject({ build: null, bricks: 60 });
    expect(out.updates.city_map).toBeUndefined();
  });

  it("promotion's bonus is a copy of the build that won it; comeback's hard hat respects the cap", () => {
    const promo = { ...offerQuest("promotion", signals(), ON, rng()), status: "completed" as const };
    const out = completionUpdates(
      { quest: promo, cityMap: emptyMap(), buildOrder: [], tileBuildDates: {}, streakFreezes: 1, freezeCap: 3, history: [], landedType: "apartment_d", today: TODAY },
      rng(),
    );
    expect(out.placed).toBe("apartment_d");
    const back = { ...offerQuest("comeback", signals({ idleDays: 4 }), ON, rng()), status: "completed" as const };
    const capped = completionUpdates(
      { quest: back, cityMap: emptyMap(), buildOrder: [], tileBuildDates: {}, streakFreezes: 3, freezeCap: 3, history: [], landedType: null, today: TODAY },
      rng(),
    );
    expect(capped.updates.streak_freezes).toBe(3);
    expect(capped.updates.quest_history).toEqual([{ id: "comeback", offered_on: TODAY, outcome: "completed" }]);
  });
});
