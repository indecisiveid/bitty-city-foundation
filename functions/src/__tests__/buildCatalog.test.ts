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

  maybe("agrees on every id and day cost", () => {
    const src = fs.readFileSync(appCatalogPath, "utf8");
    // Pull `id: 'x'` / `days: N` pairs straight out of the app's CATALOG.
    const app = new Map<string, number>();
    for (const line of src.split("\n")) {
      const id = line.match(/id:\s*'([^']+)'/);
      const days = line.match(/days:\s*(\d+)/);
      if (id && days) app.set(id[1], Number(days[1]));
    }
    expect(app.size).toBeGreaterThan(0);

    const server = new Map(CATALOG.map((i) => [i.id, i.days as number]));
    expect([...server.keys()].sort()).toEqual([...app.keys()].sort());
    for (const [id, days] of server) {
      expect(`${id}:${app.get(id)}`).toBe(`${id}:${days}`);
    }
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
