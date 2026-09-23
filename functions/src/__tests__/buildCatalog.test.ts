import * as fs from "fs";
import * as path from "path";
import {
  CATALOG,
  isBuildable,
  isKnownBuild,
  daysFor,
  labelFor,
  buildableIds,
  isCatalogId,
  LEGACY_DAYS,
  TIER_MIN_BUILDINGS,
  tierFor,
  minBuildingsFor,
} from "../buildCatalog";

describe("build catalog", () => {
  it("has unique ids", () => {
    const ids = CATALOG.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets the SHIPPED app keep starting builds", () => {
    // v1.0 is in the App Store sending 'house' | 'apartment' | 'skyscraper',
    // and there is no forced update. If these stop being startable, every
    // existing user loses "Pick a building" the moment it deploys.
    for (const legacy of Object.keys(LEGACY_DAYS)) {
      expect(isBuildable(legacy)).toBe(true);
      expect(isKnownBuild(legacy)).toBe(true);
    }
    for (const id of CATALOG.map((i) => i.id)) expect(isBuildable(id)).toBe(true);
    expect(buildableIds()).toEqual(expect.arrayContaining(["house", "house_a"]));
    expect(isBuildable("spaceport")).toBe(false);
    expect(isKnownBuild("spaceport")).toBe(false);
  });

  it("still distinguishes current vocabulary from legacy", () => {
    expect(isCatalogId("house_a")).toBe(true);
    expect(isCatalogId("house")).toBe(false);
  });

  it("resolves days and labels for catalog and legacy alike", () => {
    expect(daysFor("house_a")).toBe(1);
    expect(daysFor("park_large")).toBe(7);
    // An in-flight build started before the catalog shipped must still know
    // its own length, or its "Day x of y" push names the wrong number.
    expect(daysFor("apartment")).toBe(3);
    expect(daysFor("skyscraper")).toBe(7);
    expect(daysFor("spaceport")).toBeUndefined();
    expect(labelFor("park_small")).toBe("Park");
    expect(labelFor("spaceport")).toBe("building");
  });

  it("gates every startable id behind its tier's city size", () => {
    expect(TIER_MIN_BUILDINGS).toEqual({ easy: 0, medium: 10, challenge: 20 });
    expect(minBuildingsFor("house_a")).toBe(0);
    expect(minBuildingsFor("apartment_c")).toBe(10);
    expect(minBuildingsFor("tenement_g")).toBe(20);
    expect(minBuildingsFor("park_large")).toBe(20);
    // The 1.1 client has no picker lock and still sends the old names; they
    // must obey the same thresholds or the gate has a hole in it.
    expect(tierFor("house")).toBe("easy");
    expect(minBuildingsFor("apartment")).toBe(10);
    expect(minBuildingsFor("skyscraper")).toBe(20);
    expect(minBuildingsFor("spaceport")).toBeUndefined();
  });

  it("rejects junk without throwing", () => {
    for (const junk of [undefined, null, 42, {}, []]) {
      expect(isBuildable(junk)).toBe(false);
      expect(isKnownBuild(junk)).toBe(false);
    }
  });
});

/**
 * The two catalogs are separate files in separate repos. If they disagree on an
 * id or a day cost, the server rejects a build the client just offered — or
 * worse, accepts it and runs a different number of days than the app is
 * showing. Same reason gameLogic's streak maths has a parity test against
 * mobile/src/utils/streak.ts.
 */
describe("parity with the app catalog", () => {
  const appCatalogPath = path.resolve(
    __dirname,
    "../../../../bitty-city/mobile/src/api/buildCatalog.ts",
  );

  const available = fs.existsSync(appCatalogPath);
  const maybe = available ? it : it.skip;

  maybe("agrees on every id, day cost and tier", () => {
    const src = fs.readFileSync(appCatalogPath, "utf8");
    // Pull `id: 'x'` / `tier: 't'` / `days: N` straight out of the app's CATALOG.
    const app = new Map<string, string>();
    for (const line of src.split("\n")) {
      const id = line.match(/id:\s*'([^']+)'/);
      const tier = line.match(/tier:\s*'([^']+)'/);
      const days = line.match(/days:\s*(\d+)/);
      if (id && tier && days) app.set(id[1], `${tier[1]}:${days[1]}`);
    }
    expect(app.size).toBeGreaterThan(0);

    const server = new Map(CATALOG.map((i) => [i.id, `${i.tier}:${i.days}`]));
    expect([...server.keys()].sort()).toEqual([...app.keys()].sort());
    for (const [id, shape] of server) {
      expect(`${id}=${app.get(id)}`).toBe(`${id}=${shape}`);
    }
  });

  maybe("agrees on the unlock thresholds", () => {
    const src = fs.readFileSync(appCatalogPath, "utf8");
    const block = src.match(/TIER_MIN_BUILDINGS[^=]*=\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    const app: Record<string, number> = {};
    for (const m of block![1].matchAll(/(\w+):\s*(\d+)/g)) app[m[1]] = Number(m[2]);
    expect(app).toEqual(TIER_MIN_BUILDINGS);
  });

  if (!available) {
    // Don't fail CI when only the backend repo is checked out, but don't let
    // the gap pass silently either.
    // eslint-disable-next-line no-console
    console.warn(
      "[buildCatalog] app repo not present; parity with mobile/src/api/buildCatalog.ts NOT verified",
    );
  }
});
