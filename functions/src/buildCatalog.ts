/**
 * The build catalog — server-side mirror.
 *
 * ⚠️ Mirrors `mobile/src/api/buildCatalog.ts`. The two must agree on ids and
 * day costs, or the server rejects a build the client just offered. Parity is
 * asserted in `__tests__/buildCatalog.test.ts` on this side and in the app's
 * own catalog test on the other — same discipline as
 * `gameLogic.computeStreakWithFreezes` ↔ `utils/streak.ts`.
 *
 * The server needs four things from an item: does it exist, how many days
 * does it cost, what do we call it in a push, and which TIER it sits in —
 * because tiers unlock with city size (`TIER_MIN_BUILDINGS`) and
 * `selectBuild` is where that rule is actually enforced. The picker hides a
 * locked tier; the server refuses it, so an old or modified client can't
 * start a skyscraper on day one.
 */

export type BuildDays = 1 | 3 | 5 | 7;
export type BuildTier = "easy" | "medium" | "challenge";

export interface CatalogItem {
  id: string;
  tier: BuildTier;
  label: string;
  days: BuildDays;
  kind: "building" | "park";
  /** Parks only: lots occupied INCLUDING the perimeter wall. */
  cells?: 9 | 15;
}

export const CATALOG: CatalogItem[] = [
  { id: "house_a", tier: "easy", label: "Cottage", days: 1, kind: "building" },
  { id: "house_b", tier: "easy", label: "Townhouse", days: 1, kind: "building" },

  { id: "apartment_e", tier: "medium", label: "Corner Shop", days: 3, kind: "building" },
  { id: "apartment_f", tier: "medium", label: "Row House", days: 3, kind: "building" },
  { id: "apartment_c", tier: "medium", label: "Apartments", days: 3, kind: "building" },
  { id: "apartment_d", tier: "medium", label: "Brownstone", days: 3, kind: "building" },

  { id: "tenement_g", tier: "challenge", label: "Tenement", days: 5, kind: "building" },
  { id: "highrise_h", tier: "challenge", label: "High Rise", days: 5, kind: "building" },
  { id: "park_small", tier: "challenge", label: "Park", days: 5, kind: "park", cells: 9 },

  { id: "skyscraper_slim", tier: "challenge", label: "Skyscraper", days: 7, kind: "building" },
  { id: "skyscraper_twin", tier: "challenge", label: "Twin Towers", days: 7, kind: "building" },
  { id: "park_large", tier: "challenge", label: "Grand Park", days: 7, kind: "park", cells: 15 },
];

const BY_ID = new Map(CATALOG.map((i) => [i.id, i]));

/**
 * City-wide building count (standing buildings + parks, rubble excluded — see
 * `gameLogic.countBuildings`) a city needs before a tier may be STARTED.
 * Mirrors the app's `TIER_MIN_BUILDINGS`; the parity test pins both.
 */
export const TIER_MIN_BUILDINGS: Record<BuildTier, number> = {
  easy: 0,
  medium: 10,
  challenge: 20,
};

/**
 * Day costs for the vocabulary v1.0 shipped with.
 *
 * These are NOT deprecated aliases we can drop: cities in the wild hold these
 * values in `city_map` right now, and a build started before the catalog
 * landed is still in flight with `type: 'apartment'` on it. Accepting them is
 * what lets that build finish and its "Day x of y" push say the right number.
 */
export const LEGACY_DAYS: Record<string, BuildDays> = {
  house: 1,
  apartment: 3,
  skyscraper: 7,
};

// Title Case, matching the shipped BUILDING_LABEL exactly. These strings are
// user-visible in push copy and are fed through `withArticle`, whose
// leading-vowel test ("an Apartment") reads the label directly — so this is
// not cosmetic and must not drift.
export const LEGACY_LABEL: Record<string, string> = {
  house: "House",
  apartment: "Apartment",
  skyscraper: "Skyscraper",
};

/**
 * The v1.0 vocabulary's tiers. A 1.1 client can still send `skyscraper`;
 * without this it would walk straight past the unlock the catalog ids obey.
 */
export const LEGACY_TIER: Record<string, BuildTier> = {
  house: "easy",
  apartment: "medium",
  skyscraper: "challenge",
};

/** A current-vocabulary catalog id. */
export function isCatalogId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/**
 * Is this something a client is allowed to START building?
 *
 * Catalog ids AND the v1.0 vocabulary. The legacy names are NOT a courtesy —
 * the app in the App Store right now sends `type: 'house'`, and there is no
 * forced update. Restricting this to catalog ids would break "Pick a building"
 * for every existing user the moment it deployed, and leave them stuck until
 * they happened to update. The emulator smoke caught exactly that.
 *
 * These stay startable until the new build is broadly adopted; retiring them
 * is a later, deliberate decision with adoption numbers behind it.
 */
export function isBuildable(id: unknown): id is string {
  return isCatalogId(id) || (typeof id === "string" && id in LEGACY_DAYS);
}

/** Anything a `city_map` cell or `current_build` may legitimately hold. */
export function isKnownBuild(id: unknown): id is string {
  return isBuildable(id) || (typeof id === "string" && id in LEGACY_DAYS);
}

export function daysFor(id: string): BuildDays | undefined {
  return BY_ID.get(id)?.days ?? LEGACY_DAYS[id];
}

export function labelFor(id: string): string {
  return BY_ID.get(id)?.label ?? LEGACY_LABEL[id] ?? "building";
}

export function itemFor(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

export function tierFor(id: string): BuildTier | undefined {
  return BY_ID.get(id)?.tier ?? LEGACY_TIER[id];
}

/** Buildings a city must already hold to start `id`. Unknown ids: undefined. */
export function minBuildingsFor(id: string): number | undefined {
  const tier = tierFor(id);
  return tier === undefined ? undefined : TIER_MIN_BUILDINGS[tier];
}

/** Ids a client may pass to `selectBuild`, for the error message. */
export function buildableIds(): string[] {
  return [...CATALOG.map((i) => i.id), ...Object.keys(LEGACY_DAYS)];
}
