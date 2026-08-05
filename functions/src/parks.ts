/**
 * Parks — multi-cell regions that live ALONGSIDE `city_map`, never inside it.
 *
 * That separation is the load-bearing decision (see the park design spec), and
 * it exists because two helpers would otherwise misread a park sentinel:
 *
 *  - `slotIndexToCell` (app) treats any non-null cell as a build slot, so a
 *    park value in `city_map` would shift every later building's slot index —
 *    silently breaking `tile_build_dates` and the camera fly-to. Same class of
 *    bug as the "Built a while ago" one.
 *  - `countBuildings` counts every non-null, non-rubble cell, so a 15-cell
 *    park would report as fifteen buildings.
 *
 * So `city_map` keeps `null` at park cells and the park is recorded here. The
 * cost is one new coupling, enforced in `findEmptyTiles`: building placement
 * must exclude park cells, or a house lands on the lawn.
 */

import { itemFor } from "./buildCatalog";

/** One placed park. Firestore rejects nested arrays, hence {row,col} objects. */
export interface Park {
  park_id: string;
  cells: Array<{ row: number; col: number }>;
  /** "row,col" → damage level. Absent key = intact. */
  damage: Record<string, 1 | 2>;
  built_on: string;
}

/**
 * Footprint for a park id. Both are three deep so one layout rule covers both:
 * the wall is part of the count, so interior = (rows-2) × (cols-2), which is
 * 1 cell at 3×3 and 3 at 3×5 — exactly one junction's worth of room either way.
 */
export function parkFootprint(id: string): { rows: number; cols: number } | undefined {
  const item = itemFor(id);
  if (!item || item.kind !== "park") return undefined;
  if (item.cells === 9) return { rows: 3, cols: 3 };
  if (item.cells === 15) return { rows: 3, cols: 5 };
  return undefined;
}

export function isParkId(id: unknown): id is string {
  return typeof id === "string" && parkFootprint(id) !== undefined;
}

/** Every cell any park occupies, as "row,col" keys. */
export function parkCellKeys(parks: Park[] | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const p of parks ?? []) {
    for (const c of p.cells) keys.add(`${c.row},${c.col}`);
  }
  return keys;
}

export function normalizeParks(raw: unknown): Park[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is Park =>
      !!p &&
      typeof p === "object" &&
      typeof (p as Park).park_id === "string" &&
      Array.isArray((p as Park).cells),
  );
}

/**
 * Find a free rows×cols block for a new park.
 *
 * "Free" means every cell in the rectangle exists in the map, holds nothing a
 * user built (null or rubble — rubble is a cleared lot, and paving it over is
 * exactly what a park is for), and belongs to no existing park.
 *
 * Scanned in row-major order and the FIRST fit wins, deliberately: placement
 * has to be deterministic given a map, or the same completed build would land
 * somewhere different on a retry and the two writes would disagree.
 *
 * Returns null when the city has no room — the caller must treat that as
 * "cannot land yet" rather than dropping the build on the floor.
 */
export function allocateParkRegion(
  cityMap: Record<string, (string | null)[]>,
  parks: Park[] | null | undefined,
  rows: number,
  cols: number,
): Array<{ row: number; col: number }> | null {
  const taken = parkCellKeys(parks);
  const rowKeys = Object.keys(cityMap)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const free = (r: number, c: number): boolean => {
    const row = cityMap[String(r)];
    if (!row || c < 0 || c >= row.length) return false;
    if (taken.has(`${r},${c}`)) return false;
    return row[c] === null || row[c] === "rubble";
  };

  for (const r0 of rowKeys) {
    const width = cityMap[String(r0)]?.length ?? 0;
    for (let c0 = 0; c0 + cols <= width; c0++) {
      let fits = true;
      for (let dr = 0; dr < rows && fits; dr++) {
        for (let dc = 0; dc < cols && fits; dc++) {
          if (!free(r0 + dr, c0 + dc)) fits = false;
        }
      }
      if (fits) {
        const cells: Array<{ row: number; col: number }> = [];
        for (let dr = 0; dr < rows; dr++) {
          for (let dc = 0; dc < cols; dc++) {
            cells.push({ row: r0 + dr, col: c0 + dc });
          }
        }
        return cells;
      }
    }
  }
  return null;
}

export function makeParkId(): string {
  return `park_${Math.random().toString(36).slice(2, 10)}`;
}
