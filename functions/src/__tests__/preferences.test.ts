import { isTipId, mergeSeenTips, MAX_SEEN_TIPS, wantsEmailUpdates, isEmailUpdateSource } from "../preferences";

describe("seen tips", () => {
  it("accepts registry-shaped ids only", () => {
    expect(isTipId("proof_photos")).toBe(true);
    expect(isTipId("city_settings")).toBe(true);
    expect(isTipId("Proof")).toBe(false);
    expect(isTipId("a")).toBe(false);
    expect(isTipId("../x")).toBe(false);
    expect(isTipId(3)).toBe(false);
  });

  it("merges: deduped, order kept, junk dropped", () => {
    expect(mergeSeenTips(["a1", "bad id", "b2"], ["b2", "c3"])).toEqual(["a1", "b2", "c3"]);
    expect(mergeSeenTips(undefined, ["a1"])).toEqual(["a1"]);
  });

  it("stays bounded", () => {
    const many = Array.from({ length: MAX_SEEN_TIPS }, (_, i) => `t${i}`);
    const merged = mergeSeenTips(many, ["new_one"]);
    expect(merged).toHaveLength(MAX_SEEN_TIPS);
    expect(merged[merged.length - 1]).toBe("new_one");
  });
});

describe("email updates", () => {
  it("only an explicit, recorded yes counts", () => {
    expect(wantsEmailUpdates({ enabled: true, at: "x", source: "tip" })).toBe(true);
    expect(wantsEmailUpdates({ enabled: false, at: "x", source: "settings" })).toBe(false);
    expect(wantsEmailUpdates(undefined)).toBe(false);
    expect(wantsEmailUpdates(true)).toBe(false);
  });
  it("knows where consent can come from", () => {
    expect(isEmailUpdateSource("settings")).toBe(true);
    expect(isEmailUpdateSource("tip")).toBe(true);
    expect(isEmailUpdateSource("import")).toBe(false);
  });
});
