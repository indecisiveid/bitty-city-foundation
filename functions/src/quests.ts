/**
 * PURE — quests: time-limited crew challenges with a reward.
 *
 *   invite_bonus   "Invite friends bonus!"  a new member joins and the crew
 *                  completes a day together → the next tier's building + bricks.
 *                  For solo cities — the thing the usage data says matters most.
 *   promotion      "Incoming Promotion!"    land a 3-day build → a second copy
 *                  of it free + bricks. For established crews (Medium unlocked).
 *   material_sale  "Material Sale!"         a limited-time PEEK at the next,
 *                  still-locked tier at a sale price (2 days); land one → bricks.
 *   comeback       "The crew misses you"    a slipping or silent crew wins one
 *                  day → a hard hat + bricks. The one quest that is allowed to
 *                  reach people who've gone quiet (category `winback`).
 *
 * Adding a quest = one CATALOG entry + its copy in questMessages.ts + tests.
 *
 * WHEN a city gets a quest (`rollQuest`) is driven by how the crew plays:
 *   - one quest per city at a time;
 *   - an engaged crew (won ≥ ENGAGED_WIN_RATE of the last 14 days) gets one
 *     every `engagedGapDays`, others every `normalGapDays`; a crew that let its
 *     last two quests expire gets them `ignoredMultiplier`× less often;
 *   - a crew idle `comebackIdleDays` gets a comeback quest regardless of the
 *     gap (at most every `comebackCooldownDays`) — the way back in;
 *   - each quest has its own cooldown and eligibility; the pick among the
 *     eligible is weighted and seeded by (city, day), so a retry is stable.
 * Every number lives in QuestConfig, overridable from the server-only
 * Firestore doc `config/quests` without a deploy — including `enabled`,
 * which ships FALSE until the app that shows quests is in people's hands.
 */
import { BuildTier, CATALOG, TIER_MIN_BUILDINGS, daysFor, labelFor, tierFor as tierOfBuild } from "./buildCatalog";
import { CityMap, findEmptyTiles, rowMajorBuildOrder } from "./gameLogic";

export type QuestId = "invite_bonus" | "promotion" | "material_sale" | "comeback";
export type QuestStatus = "active" | "completed" | "expired";

export interface QuestReward {
  /** A building placed in the city when the quest completes. */
  build?: string;
  /** Promotion: a second copy of the build that completed it. */
  bonus_same_build?: boolean;
  /** Paid to every member. */
  bricks: number;
  hard_hats?: number;
}

export interface Quest {
  /** Unique instance id: `${id}:${offered_on}` — idempotency key for pushes and bricks. */
  key: string;
  id: QuestId;
  status: QuestStatus;
  offered_on: string;
  /** Last game day the quest can be completed on. */
  ends_on: string;
  baseline: { members: number; buildings: number };
  reward: QuestReward;
  /** Sale: this tier may be started during the quest, at `days` each. */
  peek?: { tier: BuildTier; days: number } | null;
  /** 0 → steps; `joined` names the friend who joined (invite). */
  progress: { step: number; steps: number; joined?: string | null };
  granted?: { build?: string | null; tile?: number[] | null; bricks: number; hard_hats?: number } | null;
  dismissed_by: string[];
  completed_on?: string | null;
  /** What the app shows, written by the server (questMessages.withDisplay). */
  display?: { title: string; objective: string; progress: string; reward: string } | null;
}

export interface QuestHistoryEntry {
  id: QuestId;
  offered_on: string;
  outcome: "completed" | "expired";
}

export interface QuestConfig {
  enabled: boolean;
  engagedWinRate: number;
  engagedGapDays: number;
  normalGapDays: number;
  ignoredMultiplier: number;
  comebackIdleDays: number;
  comebackCooldownDays: number;
  saleDays: number;
  saleMinBuildings: number;
  promotionMinWinRate: number;
  weights: Record<QuestId, number>;
  cooldownDays: Record<QuestId, number>;
  durationDays: Record<QuestId, number>;
  bricks: Record<QuestId, number>;
}

export const DEFAULT_QUEST_CONFIG: QuestConfig = {
  enabled: false,
  engagedWinRate: 0.5,
  engagedGapDays: 5,
  normalGapDays: 7,
  ignoredMultiplier: 2,
  comebackIdleDays: 3,
  comebackCooldownDays: 14,
  saleDays: 2,
  saleMinBuildings: 3,
  promotionMinWinRate: 0.4,
  weights: { invite_bonus: 3, promotion: 2, material_sale: 2, comeback: 1 },
  cooldownDays: { invite_bonus: 21, promotion: 10, material_sale: 14, comeback: 14 },
  durationDays: { invite_bonus: 7, promotion: 7, material_sale: 3, comeback: 3 },
  bricks: { invite_bonus: 100, promotion: 60, material_sale: 40, comeback: 30 },
};

export const QUEST_HISTORY_MAX = 20;

/** Defaults overlaid with whatever `config/quests` sets (unknown keys ignored). */
export function mergeQuestConfig(raw: unknown): QuestConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<QuestConfig>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const table = <T extends Record<string, number>>(v: unknown, d: T): T => {
    const out = { ...d };
    if (v && typeof v === "object") for (const k of Object.keys(d)) out[k as keyof T] = num((v as T)[k], d[k]) as T[keyof T];
    return out;
  };
  const d = DEFAULT_QUEST_CONFIG;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    engagedWinRate: num(r.engagedWinRate, d.engagedWinRate),
    engagedGapDays: num(r.engagedGapDays, d.engagedGapDays),
    normalGapDays: num(r.normalGapDays, d.normalGapDays),
    ignoredMultiplier: num(r.ignoredMultiplier, d.ignoredMultiplier),
    comebackIdleDays: num(r.comebackIdleDays, d.comebackIdleDays),
    comebackCooldownDays: num(r.comebackCooldownDays, d.comebackCooldownDays),
    saleDays: num(r.saleDays, d.saleDays),
    saleMinBuildings: num(r.saleMinBuildings, d.saleMinBuildings),
    promotionMinWinRate: num(r.promotionMinWinRate, d.promotionMinWinRate),
    weights: table(r.weights, d.weights),
    cooldownDays: table(r.cooldownDays, d.cooldownDays),
    durationDays: table(r.durationDays, d.durationDays),
    bricks: table(r.bricks, d.bricks),
  };
}

// --- dates (YYYY-MM-DD, UTC arithmetic — labels, not instants) --------------

export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// --- signals ----------------------------------------------------------------

export interface CitySignals {
  cityId: string;
  today: string;
  activeMembers: number;
  buildings: number;
  /** Successful days / days in the last 14 (or since founding, if younger). */
  winRate14: number;
  /** Days since the last completion, or null. */
  idleDays: number | null;
  paused: boolean;
  hasBuild: boolean;
  quest: Quest | null;
  history: QuestHistoryEntry[];
}

export function winRate(completions: string[], today: string, createdOn: string | null, window = 14): number {
  const from = addDaysYmd(today, -window);
  const age = createdOn ? Math.max(1, Math.min(window, daysFrom(createdOn, today))) : window;
  const wins = new Set(completions.filter((d) => d > from && d <= today)).size;
  return Math.min(1, wins / age);
}

/** The highest tier this many buildings unlocks, and the one after it. */
export function tiers(buildings: number): { unlocked: BuildTier; next: BuildTier | null } {
  const order: BuildTier[] = ["easy", "medium", "challenge"];
  let unlocked: BuildTier = "easy";
  for (const t of order) if (buildings >= TIER_MIN_BUILDINGS[t]) unlocked = t;
  const i = order.indexOf(unlocked);
  return { unlocked, next: order[i + 1] ?? null };
}

// --- catalog ----------------------------------------------------------------

interface QuestDef {
  id: QuestId;
  eligible: (s: CitySignals, c: QuestConfig) => boolean;
  reward: (s: CitySignals, c: QuestConfig, rng: () => number) => QuestReward;
  peek?: (s: CitySignals, c: QuestConfig) => Quest["peek"];
  steps: number;
}

/** Buildings (not parks) of a tier — a reward is always something that stands on a lot. */
function buildingsOfTier(tier: BuildTier): string[] {
  return CATALOG.filter((i) => i.tier === tier && i.kind === "building").map((i) => i.id);
}

/** Invite reward: a building from the tier above what the city has unlocked (the top tier's tallest at the top). */
export function nextTierBuilding(buildings: number, rng: () => number): string {
  const { next } = tiers(buildings);
  if (!next) return "skyscraper_twin";
  if (next === "challenge") return "skyscraper_slim";
  const pool = buildingsOfTier(next);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

export const CATALOG_QUESTS: Record<QuestId, QuestDef> = {
  invite_bonus: {
    id: "invite_bonus",
    steps: 2,
    eligible: (s) => s.activeMembers === 1 && s.buildings >= 1,
    reward: (s, c, rng) => ({ build: nextTierBuilding(s.buildings, rng), bricks: c.bricks.invite_bonus }),
  },
  promotion: {
    id: "promotion",
    steps: 2,
    eligible: (s, c) => s.buildings >= TIER_MIN_BUILDINGS.medium && s.winRate14 >= c.promotionMinWinRate && !s.hasBuild,
    reward: (_s, c) => ({ bonus_same_build: true, bricks: c.bricks.promotion }),
  },
  material_sale: {
    id: "material_sale",
    steps: 2,
    eligible: (s, c) => tiers(s.buildings).next !== null && s.buildings >= c.saleMinBuildings && !s.hasBuild,
    reward: (_s, c) => ({ bricks: c.bricks.material_sale }),
    peek: (s, c) => ({ tier: tiers(s.buildings).next!, days: c.saleDays }),
  },
  comeback: {
    id: "comeback",
    steps: 1,
    eligible: (s, c) => (s.idleDays ?? 0) >= c.comebackIdleDays,
    reward: (_s, c) => ({ hard_hats: 1, bricks: c.bricks.comeback }),
  },
};

function makeQuest(def: QuestDef, s: CitySignals, c: QuestConfig, rng: () => number): Quest {
  return {
    key: `${def.id}:${s.today}`,
    id: def.id,
    status: "active",
    offered_on: s.today,
    ends_on: addDaysYmd(s.today, c.durationDays[def.id] - 1),
    baseline: { members: s.activeMembers, buildings: s.buildings },
    reward: def.reward(s, c, rng),
    peek: def.peek ? def.peek(s, c) : null,
    progress: { step: 0, steps: def.steps, joined: null },
    granted: null,
    dismissed_by: [],
    completed_on: null,
  };
}

// --- rolling ----------------------------------------------------------------

function lastOf(history: QuestHistoryEntry[], id?: QuestId): QuestHistoryEntry | undefined {
  const list = id ? history.filter((h) => h.id === id) : history;
  return list.reduce<QuestHistoryEntry | undefined>((a, b) => (!a || b.offered_on > a.offered_on ? b : a), undefined);
}

/** Days until another quest may be offered, from how the crew plays. */
export function gapDays(s: CitySignals, c: QuestConfig): number {
  const base = s.winRate14 >= c.engagedWinRate ? c.engagedGapDays : c.normalGapDays;
  const recent = [...s.history].sort((a, b) => a.offered_on.localeCompare(b.offered_on)).slice(-2);
  const ignored = recent.length === 2 && recent.every((h) => h.outcome === "expired");
  return ignored ? base * c.ignoredMultiplier : base;
}

/**
 * A new quest for this city today, or null. Never replaces an active quest.
 * `rng` should be seeded by (city, day) so a retried tick picks the same one.
 */
export function rollQuest(s: CitySignals, c: QuestConfig, rng: () => number): Quest | null {
  if (!c.enabled || s.paused) return null;
  if (s.quest?.status === "active") return null;

  const offCooldown = (id: QuestId) => {
    const last = lastOf(s.history, id);
    return !last || daysFrom(last.offered_on, s.today) >= c.cooldownDays[id];
  };

  // The way back in: an idle crew gets a comeback quest whatever the gap.
  if (CATALOG_QUESTS.comeback.eligible(s, c)) {
    const last = lastOf(s.history, "comeback");
    if (!last || daysFrom(last.offered_on, s.today) >= c.comebackCooldownDays) {
      return makeQuest(CATALOG_QUESTS.comeback, s, c, rng);
    }
    return null;
  }

  const last = lastOf(s.history);
  if (last && daysFrom(last.offered_on, s.today) < gapDays(s, c)) return null;

  const pool = (Object.keys(CATALOG_QUESTS) as QuestId[])
    .filter((id) => id !== "comeback")
    .filter((id) => c.weights[id] > 0 && offCooldown(id) && CATALOG_QUESTS[id].eligible(s, c));
  if (pool.length === 0) return null;
  const total = pool.reduce((t, id) => t + c.weights[id], 0);
  let r = rng() * total;
  for (const id of pool) {
    r -= c.weights[id];
    if (r < 0) return makeQuest(CATALOG_QUESTS[id], s, c, rng);
  }
  return makeQuest(CATALOG_QUESTS[pool[pool.length - 1]], s, c, rng);
}

/** Settle an active quest whose last day has passed. */
export function expireQuest(q: Quest | null, today: string): Quest | null {
  if (!q || q.status !== "active" || today <= q.ends_on) return q;
  return { ...q, status: "expired" };
}

export function pushHistory(history: QuestHistoryEntry[], q: Quest): QuestHistoryEntry[] {
  if (q.status === "active") return history;
  const entry: QuestHistoryEntry = { id: q.id, offered_on: q.offered_on, outcome: q.status };
  const rest = history.filter((h) => !(h.id === q.id && h.offered_on === q.offered_on));
  return [...rest, entry].slice(-QUEST_HISTORY_MAX);
}

// --- objectives -------------------------------------------------------------

export type QuestTransition = { quest: Quest; event: "progress" | "completed" } | null;

const isActive = (q: Quest | null, today: string): q is Quest =>
  !!q && q.status === "active" && today >= q.offered_on && today <= q.ends_on;

/** Invite: someone new joined. */
export function onJoin(q: Quest | null, memberCountAfter: number, joinedName: string, today: string): QuestTransition {
  if (!isActive(q, today) || q.id !== "invite_bonus" || q.progress.step > 0) return null;
  if (memberCountAfter <= q.baseline.members) return null;
  return { quest: { ...q, progress: { ...q.progress, step: 1, joined: joinedName } }, event: "progress" };
}

/** A completion was recorded. `completedActive` counts members done today, after it. */
export function onCompletion(
  q: Quest | null,
  c: { completedActive: number; dayWon: boolean; today: string },
): QuestTransition {
  if (!isActive(q, c.today)) return null;
  if (q.id === "invite_bonus" && q.progress.step >= 1 && c.completedActive >= 2) {
    return { quest: complete(q, c.today), event: "completed" };
  }
  if (q.id === "comeback" && c.dayWon) return { quest: complete(q, c.today), event: "completed" };
  return null;
}

/**
 * A build is being started while the quest runs. Returns the build fields to
 * stamp (the quest key, and the sale price) and the quest's next state — or
 * null when the quest doesn't care about this build.
 */
export function onBuildStarted(
  q: Quest | null,
  type: string,
  today: string,
): { stamp: { quest: string; days_required?: number }; transition: QuestTransition } | null {
  if (!isActive(q, today) || q.progress.step > 0) return null;
  if (q.id === "promotion" && daysFor(type) === 3) {
    return { stamp: { quest: q.key }, transition: { quest: step(q, 1), event: "progress" } };
  }
  if (q.id === "material_sale" && q.peek && tierOfBuild(type) === q.peek.tier) {
    return { stamp: { quest: q.key, days_required: q.peek.days }, transition: { quest: step(q, 1), event: "progress" } };
  }
  return null;
}

/** Whether the sale lets this city START `type` now, despite the tier lock. */
export function salePeekAllows(q: Quest | null, type: string, today: string): boolean {
  return isActive(q, today) && q.id === "material_sale" && !!q.peek && tierOfBuild(type) === q.peek.tier;
}

/**
 * A build landed. A quest build (stamped at start) completes promotion and
 * the sale even if the quest window has since closed — the crew started it
 * in time and kept at it.
 */
export function onLanding(q: Quest | null, landedBuild: { quest?: string } | null, today: string): QuestTransition {
  if (!q || !landedBuild?.quest || landedBuild.quest !== q.key) return null;
  if (q.status === "completed") return null;
  return { quest: complete(q, today), event: "completed" };
}

function step(q: Quest, n: number): Quest {
  return { ...q, progress: { ...q.progress, step: n } };
}
function complete(q: Quest, today: string): Quest {
  return { ...q, status: "completed", completed_on: today, progress: { ...q.progress, step: q.progress.steps } };
}

// --- rewards ----------------------------------------------------------------

export interface BonusPlacement {
  city_map: CityMap;
  build_order: string[];
  tile_build_dates: Record<string, string>;
  tile: number[];
}

/**
 * Place a reward building on an empty lot, appended to the growth frontier
 * like any landing. No freeze, no bricks, no `pending_event` — the quest's own
 * completion is the celebration, and a bonus must not earn like a real build.
 * Null when the city is full (the bricks are still paid).
 */
export function placeBonusBuilding(
  p: { cityMap: CityMap; buildOrder: string[] | null; tileBuildDates: Record<string, string>; type: string; on: string },
  rng: () => number,
): BonusPlacement | null {
  const empty = findEmptyTiles(p.cityMap);
  if (empty.length === 0) return null;
  const tile = empty[Math.floor(rng() * empty.length) % empty.length];
  const key = `${tile[0]},${tile[1]}`;
  const map: CityMap = Object.fromEntries(Object.entries(p.cityMap).map(([k, row]) => [k, [...row]]));
  map[tile[0]][tile[1]] = p.type;
  const order = p.buildOrder ?? rowMajorBuildOrder(p.cityMap);
  return {
    city_map: map,
    build_order: order.includes(key) ? order : [...order, key],
    tile_build_dates: { ...p.tileBuildDates, [key]: p.on },
    tile,
  };
}

/** What building a completed quest places, if any. */
export function rewardBuildFor(q: Quest, landedType: string | null): string | null {
  if (q.reward.build) return q.reward.build;
  if (q.reward.bonus_same_build && landedType) return landedType;
  return null;
}

export { labelFor };

/** Offer a specific quest now, bypassing cadence (the dev control). */
export function offerQuest(id: QuestId, s: CitySignals, c: QuestConfig, rng: () => number): Quest {
  return makeQuest(CATALOG_QUESTS[id], s, c, rng);
}

/**
 * Everything a completed quest writes to the city, in one place for all the
 * paths that can complete one (a check-in, a landing, a settlement). The
 * placed building goes on the map AS IT STANDS AFTER the triggering write
 * (e.g. after the landing that won the Promotion). Hard hats are capped like
 * any freeze. Bricks are paid per member outside the transaction
 * (grantQuestBricks), idempotent on the quest key.
 */
export function completionUpdates(
  p: {
    quest: Quest;
    cityMap: CityMap;
    buildOrder: string[] | null;
    tileBuildDates: Record<string, string>;
    streakFreezes: number;
    freezeCap: number;
    history: QuestHistoryEntry[];
    landedType: string | null;
    today: string;
  },
  rng: () => number,
): { updates: Record<string, unknown>; placed: string | null; quest: Quest } {
  const want = rewardBuildFor(p.quest, p.landedType);
  const placement = want
    ? placeBonusBuilding({ cityMap: p.cityMap, buildOrder: p.buildOrder, tileBuildDates: p.tileBuildDates, type: want, on: p.today }, rng)
    : null;
  const hats = p.quest.reward.hard_hats ?? 0;
  const quest: Quest = {
    ...p.quest,
    granted: {
      build: placement ? want : null,
      tile: placement?.tile ?? null,
      bricks: p.quest.reward.bricks,
      ...(hats ? { hard_hats: hats } : {}),
    },
  };
  const updates: Record<string, unknown> = { quest_history: pushHistory(p.history, quest) };
  if (placement) {
    updates.city_map = placement.city_map;
    updates.build_order = placement.build_order;
    updates.tile_build_dates = placement.tile_build_dates;
  }
  if (hats) updates.streak_freezes = Math.min(p.freezeCap, p.streakFreezes + hats);
  return { updates, placed: placement ? want : null, quest };
}
