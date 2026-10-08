import { invitePreviewOf } from "../invites";
import { MAX_MEMBERS_PER_GROUP } from "../utils";

/**
 * The invite screen reads "Join Riley's city?" over the crew list, so the
 * founder has to be found by owner_uid (not assumed to be first) and the
 * flags have to say whether the button can work at all.
 */
const city = (over: Record<string, unknown> = {}) => ({
  group_code: "ABC123",
  group_name: "Riverside",
  group_members: ["Sam", "Riley", "Jo"],
  member_uids: ["u-sam", "u-riley", "u-jo"],
  owner_uid: "u-riley",
  daily_goal: "Walk 10k steps",
  city_map: { "0": ["house", null, "rubble"], "1": [null, "shop", null] },
  parks: [{ id: "p1" }],
  streak: 4,
  ...over,
});

describe("invitePreviewOf", () => {
  it("names the founder and lists them first", () => {
    const p = invitePreviewOf("g1", city(), "u-new", []);
    expect(p.founder).toBe("Riley");
    expect(p.members).toEqual(["Riley", "Sam", "Jo"]);
    expect(p.group_name).toBe("Riverside");
    expect(p.buildings).toBe(3); // house + shop + park; rubble isn't a building
    expect(p.game_mode).toBe("hard"); // absent = hard
    expect(p.is_member).toBe(false);
    expect(p.is_full).toBe(false);
    expect(p.at_city_limit).toBe(false);
  });

  it("has no founder once the owner has gone", () => {
    const p = invitePreviewOf("g1", city({ owner_uid: "u-gone" }), "u-new", []);
    expect(p.founder).toBeNull();
    expect(p.members).toEqual(["Sam", "Riley", "Jo"]);
  });

  it("knows when the viewer is already in", () => {
    const p = invitePreviewOf("g1", city(), "u-jo", ["g1"]);
    expect(p.is_member).toBe(true);
  });

  it("flags a full city, but not to someone already in it", () => {
    const names = Array.from({ length: MAX_MEMBERS_PER_GROUP }, (_, i) => `M${i}`);
    const uids = names.map((n) => `u-${n}`);
    const full = city({ group_members: names, member_uids: uids, owner_uid: "u-M0" });
    expect(invitePreviewOf("g1", full, "u-new", []).is_full).toBe(true);
    expect(invitePreviewOf("g1", full, "u-M3", []).is_full).toBe(false);
  });

  it("previews for a signed-out viewer", () => {
    const p = invitePreviewOf("g1", city(), null, []);
    expect(p.founder).toBe("Riley");
    expect(p.is_member).toBe(false);
    expect(p.at_city_limit).toBe(false);
  });
});
