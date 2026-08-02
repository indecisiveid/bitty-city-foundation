/**
 * The build catalog — server-side mirror.
 *
 * ⚠️ Mirrors `mobile/src/api/buildCatalog.ts`. The two must agree on ids and
 * day costs, or the server rejects a build the client just offered. Parity is
 * asserted in `__tests__/buildCatalog.test.ts` on this side and in the app's
 * own catalog test on the other — same discipline as
 * `gameLogic.computeStreakWithFreezes` ↔ `utils/streak.ts`.
 *
 * The server only ever needs three things from an item: does it exist, how
 * many days does it cost, and what do we call it in a push. Tier is a
 * client-side presentation concept and is deliberately absent here.
 */

export type BuildDays = 1 | 3 | 5 | 7;

export interface CatalogItem {
  id: string;
  label: string;
  days: BuildDays;
  kind: "building" | "park";
  /** Parks only: lots occupied INCLUDING the perimeter wall. */
  cells?: 9 | 15;
}

export const CATALOG: CatalogItem[] = [
  { id: "house_a", label: "Cottage", days: 1, kind: "building" },
  { id: "house_b", label: "Townhouse", days: 1, kind: "building" },

  { id: "apartment_e", label: "Corner Shop", days: 3, kind: "building" },
  { id: "apartment_f", label: "Row House", days: 3, kind: "building" },
  { id: "apartment_c", label: "Apartments", days: 3, kind: "building" },
  { id: "apartment_d", label: "Brownstone", days: 3, kind: "building" },

  { id: "tenement_g", label: "Tenement", days: 5, kind: "building" },
  { id: "highrise_h", label: "High Rise", days: 5, kind: "building" },
  { id: "park_small", label: "Park", days: 5, kind: "park", cells: 9 },

  { id: "skyscraper_slim", label: "Skyscraper", days: 7, kind: "building" },
  { id: "skyscraper_twin", label: "Twin Towers", days: 7, kind: "building" },
  { id: "park_large", label: "Grand Park", days: 7, kind: "park", cells: 15 },
];

const BY_ID = new Map(CATALOG.map((i) => [i.id, i]));

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

/** Is this something a client is allowed to start building? */
export function isBuildable(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
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

/** Ids a client may pass to `selectBuild`, for the error message. */
export function buildableIds(): string[] {
  return CATALOG.map((i) => i.id);
}
