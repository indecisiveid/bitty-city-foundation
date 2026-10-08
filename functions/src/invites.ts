/**
 * PURE — what an invite link shows before you join.
 *
 * An invite link (www.bitty.city/join/<code>) opens the app on "Join
 * Riley's city?" with the crew underneath and one button. That screen needs
 * the city's name, who founded it and who's in it, from a city the viewer
 * isn't a member of yet — which the member-only getGroup and the Firestore
 * rules rightly refuse. So the preview is its own, much smaller shape: the
 * code already lets you join, so showing the names of the people you'd join
 * gives nothing away that joining wouldn't.
 */
import { countBuildings } from "./gameLogic";
import { normalizeGameMode, GameMode } from "./gameMode";
import { MAX_MEMBERS_PER_GROUP, MAX_GROUPS_PER_USER } from "./utils";

export interface InvitePreview {
  group_id: string;
  group_code: string;
  group_name: string;
  /** The founder's name in this city, or null if they've gone. */
  founder: string | null;
  /** Everyone in the city now, founder first. */
  members: string[];
  max_members: number;
  daily_goal: string;
  game_mode: GameMode;
  buildings: number;
  streak: number;
  /** The viewer is already in this city — open it instead of offering to join. */
  is_member: boolean;
  is_full: boolean;
  /** The viewer is at their own city cap, so joining would be refused. */
  at_city_limit: boolean;
}

export function invitePreviewOf(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
  uid: string,
  viewerGroupIds: readonly string[],
): InvitePreview {
  const names: string[] = data.group_members ?? [];
  const uids: string[] = data.member_uids ?? [];
  const founderIndex = data.owner_uid ? uids.indexOf(data.owner_uid) : -1;
  const founder = founderIndex >= 0 ? names[founderIndex] ?? null : null;
  const members = founder ? [founder, ...names.filter((_, i) => i !== founderIndex)] : [...names];
  const isMember = uids.includes(uid);

  return {
    group_id: groupId,
    group_code: data.group_code,
    group_name: data.group_name,
    founder,
    members,
    max_members: MAX_MEMBERS_PER_GROUP,
    daily_goal: data.daily_goal ?? "",
    game_mode: normalizeGameMode(data.game_mode),
    buildings: countBuildings(data.city_map, data.parks),
    streak: data.streak ?? 0,
    is_member: isMember,
    is_full: !isMember && names.length >= MAX_MEMBERS_PER_GROUP,
    at_city_limit: !isMember && viewerGroupIds.length >= MAX_GROUPS_PER_USER,
  };
}
