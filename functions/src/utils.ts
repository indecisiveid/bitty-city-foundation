import { HttpsError } from "firebase-functions/v2/https";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateGroupCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return code;
}

export const GRID_ROWS = 10;
export const GRID_COLS = 10;

export const EMPTY_CITY: Record<string, (string | null)[]> = Object.fromEntries(
  Array.from({ length: GRID_ROWS }, (_, i) => [String(i), Array(GRID_COLS).fill(null)]),
);

export const MAX_MEMBERS_PER_GROUP = 4;
export const MAX_GROUPS_PER_USER = 100;

// --- Input validation (server-side mirror of the client rules) ---

export function requireTrimmed(
  value: unknown,
  field: string,
  minLen: number,
  maxLen: number,
): string {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen) {
    throw new HttpsError(
      "invalid-argument",
      minLen <= 1
        ? `${field} is required`
        : `${field} must be at least ${minLen} characters`,
    );
  }
  if (trimmed.length > maxLen) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be at most ${maxLen} characters`,
    );
  }
  return trimmed;
}

export function requireResetTime(value: unknown): string {
  const v = typeof value === "string" ? value : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    throw new HttpsError(
      "invalid-argument",
      "goal_reset_time must be HH:MM (24h)",
    );
  }
  return v;
}

// --- Shared response shape (used by group + demo handlers) ---

export function groupToResponse(
  groupId: string,
  data: FirebaseFirestore.DocumentData,
) {
  return {
    group_id: groupId,
    group_code: data.group_code,
    group_name: data.group_name,
    group_members: data.group_members,
    owner_uid: data.owner_uid ?? null,
    member_uids: data.member_uids ?? [],
    daily_goal: data.daily_goal,
    goal_reset_time: data.goal_reset_time,
    goal_reset_timezone: data.goal_reset_timezone ?? "UTC",
    completions_today: data.completions_today,
    streak: data.streak,
    streak_freezes: data.streak_freezes ?? 0,
    frozen_dates: data.frozen_dates ?? [],
    broken_streak: data.broken_streak ?? null,
    last_activity_date: data.last_activity_date ?? null,
    current_build: data.current_build ?? null,
    abandoned_build: data.abandoned_build ?? null,
    city_map: data.city_map,
    last_processed_date: data.last_processed_date ?? null,
    pending_event: data.pending_event ?? null,
    building_completions: data.building_completions ?? [],
    kudos_today: data.kudos_today ?? null,
    created_at:
      data.created_at?.toDate?.()?.toISOString?.() ?? new Date().toISOString(),
  };
}
