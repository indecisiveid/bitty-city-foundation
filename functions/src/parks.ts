/**
 * Parks — recorded ALONGSIDE `city_map`, never inside it.
 *
 * Two reasons the grid can't hold them:
 *
 *  - `slotIndexToCell` (app) treats any non-null cell as a build slot, so a
 *    park value would shift every later building's slot index — silently
 *    breaking `tile_build_dates` and the camera fly-to. Same class of bug as
 *    the "Built a while ago" one.
 *  - `countBuildings` counts every non-null, non-rubble cell, so a 15-cell
 *    park would report as fifteen buildings instead of one.
 *
 * A park stores its SIZE, not coordinates. That is the subtle part: `city_map`
 * row/col are bookkeeping, NOT geometry. `computeCityLayout` never reads them —
 * it derives every position from the block plan, which is a pure function of
 * how many slots exist. Server-side coordinates would therefore be
 * unrenderable, so the client places the park itself, deterministically from
 * `park_id`, which is what keeps every crew member seeing the same city.
 */

import { itemFor } from "./buildCatalog";

export interface Park {
  park_id: string;
  /** Footprint in cells: 9 (3×3) or 15 (3×5). */
  cells: 9 | 15;
  /** Park-local cell index → damage level. Absent key = intact. */
  damage: Record<string, 1 | 2>;
  built_on: string;
}

/**
 * Footprint for a park id. Both are three deep so one layout rule covers both:
 * the wall is part of the count, so interior = (rows-2) × (cols-2) — 1 cell at
 * 3×3 and 3 at 3×5, which is exactly one junction's worth of room either way.
 */
export function parkFootprint(
  id: string,
): { rows: number; cols: number } | undefined {
  const item = itemFor(id);
  if (!item || item.kind !== "park") return undefined;
  if (item.cells === 9) return { rows: 3, cols: 3 };
  if (item.cells === 15) return { rows: 3, cols: 5 };
  return undefined;
}

export function isParkId(id: unknown): id is string {
  return typeof id === "string" && parkFootprint(id) !== undefined;
}

export function parkCellCount(id: string): 9 | 15 | undefined {
  const f = parkFootprint(id);
  if (!f) return undefined;
  return (f.rows * f.cols) as 9 | 15;
}

export function normalizeParks(raw: unknown): Park[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is Park =>
      !!p &&
      typeof p === "object" &&
      typeof (p as Park).park_id === "string" &&
      ((p as Park).cells === 9 || (p as Park).cells === 15),
  );
}

export function makeParkId(): string {
  return `park_${Math.random().toString(36).slice(2, 10)}`;
}
