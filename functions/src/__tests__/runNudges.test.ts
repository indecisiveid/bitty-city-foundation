/**
 * The scheduler's send pass, end to end against an in-memory Firestore.
 *
 * Until now nothing exercised `runNudges` itself — every test was a pure
 * function. The per-person tiers live in the orchestration (pass 2), so the
 * orchestration is what has to be proven: who gets pushed, what is written
 * back, and that a person nobody should hear from stays silent across ticks.
 *
 * The fake is deliberately tiny: a Map of documents with the four operations
 * the code uses (collection.get, getAll, ref.update, ref.set merge).
 */
jest.mock("firebase-admin/firestore", () => {
  const DELETE = Symbol("delete");
  const store = new Map<string, Record<string, unknown>>();
  const isPlain = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  const deepMerge = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(from)) {
      if (v === DELETE) delete into[k];
      else if (isPlain(v) && isPlain(into[k])) deepMerge(into[k] as Record<string, unknown>, v as Record<string, unknown>);
      else into[k] = isPlain(v) ? { ...(v as Record<string, unknown>) } : v;
    }
  };
  class Snap {
    constructor(public ref: Ref, private value: Record<string, unknown> | undefined) {}
    get id() { return this.ref.id; }
    get exists() { return this.value !== undefined; }
    data() { return this.value ? { ...this.value } : undefined; }
  }
  class Ref {
    constructor(public path: string) {}
    get id() { return this.path.split("/").pop()!; }
    async get() { return new Snap(this, store.get(this.path)); }
    async update(fields: Record<string, unknown>) {
      const cur = store.get(this.path);
      if (!cur) throw new Error(`update on missing doc ${this.path}`);
      for (const [k, v] of Object.entries(fields)) {
        if (v === DELETE) delete cur[k];
        else cur[k] = v;
      }
    }
    async set(fields: Record<string, unknown>, opts?: { merge?: boolean }) {
      if (opts?.merge && store.has(this.path)) deepMerge(store.get(this.path)!, fields);
      else store.set(this.path, JSON.parse(JSON.stringify({})) && { ...fields });
    }
    collection(name: string) { return new Col(`${this.path}/${name}`); }
  }
  class Col {
    constructor(public path: string) {}
    doc(id: string) { return new Ref(`${this.path}/${id}`); }
    async get() {
      const docs: Snap[] = [];
      for (const [path, value] of store) {
        const rest = path.startsWith(`${this.path}/`) ? path.slice(this.path.length + 1) : null;
        if (rest && !rest.includes("/")) docs.push(new Snap(new Ref(path), value));
      }
      return { docs, size: docs.length };
    }
  }
  const db = {
    collection: (name: string) => new Col(name),
    getAll: async (...refs: Ref[]) => refs.map((r) => new Snap(r, store.get(r.path))),
  };
  return {
    getFirestore: () => db,
    FieldValue: {
      delete: () => DELETE,
      arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }),
      serverTimestamp: () => new Date(),
    },
    Timestamp: {
      fromDate: (d: Date) => ({ toDate: () => d, __ts: d.toISOString() }),
      now: () => ({ toDate: () => new Date() }),
    },
    __store: store,
    __reset: () => store.clear(),
  };
});

jest.mock("../push", () => ({
  ...jest.requireActual("../push"),
  sendPush: jest.fn(async () => []),
}));

import { runNudges } from "../scheduled";
import { messageFor } from "../nudgeMessages";
import { touchLastSeen, COMPLETION_MINUTES_KEPT } from "../presence";
import { sendPush } from "../push";

const fs = jest.requireMock("firebase-admin/firestore") as {
  __store: Map<string, Record<string, unknown>>;
  __reset: () => void;
};
const sent = sendPush as unknown as jest.Mock;

// 2026-09-22 in New York (EDT, UTC-4). Game date for a 00:00 reset is 2026-09-22 all day.
const MORNING = new Date("2026-09-22T12:05:00Z"); // 08:05
const MIDDAY = new Date("2026-09-22T15:35:00Z"); // 11:35
const EVENING = new Date("2026-09-22T21:35:00Z"); // 17:35
const LAST_CALL = new Date("2026-09-23T01:05:00Z"); // 21:05
const TODAY = "2026-09-22";
const daysBefore = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);

function seedGroup(id: string, over: Record<string, unknown>) {
  fs.__store.set(`groups/${id}`, {
    group_name: id,
    goal_reset_time: "00:00",
    goal_reset_timezone: "America/New_York",
    game_mode: "hard",
    completions_today: [],
    streak: 0,
    last_activity_date: TODAY,
    last_inactivity_meteor_date: null,
    current_build: null,
    ...over,
  });
}
function seedUser(uid: string, over: Record<string, unknown>) {
  fs.__store.set(`users/${uid}`, { display_name: uid, group_ids: [], push_tokens: [`tok-${uid}`], ...over });
}
const group = (id: string) => fs.__store.get(`groups/${id}`)!;
const user = (uid: string) => fs.__store.get(`users/${uid}`)!;
/** Pushes sent to a token, as [title, body] pairs. */
const pushesTo = (token: string) =>
  sent.mock.calls.filter(([tokens]) => (tokens as string[]).includes(token)).map(([, p]) => p as { title: string; body: string; data?: Record<string, unknown> });

beforeEach(() => {
  fs.__reset();
  sent.mockClear();
});

describe("runNudges — a dormant solo owner", () => {
  beforeEach(() => {
    seedGroup("Bitty Philly", { group_members: ["Nick"], member_uids: ["u-nick"], streak: 3 });
    seedUser("u-nick", { last_seen_at: daysBefore(EVENING, 20) });
  });

  it("gets exactly one farewell, and then nothing, across the day's slots", async () => {
    await runNudges(EVENING);
    const first = pushesTo("tok-u-nick");
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe("👋 We'll stop reminding you");
    expect(first[0].body).toContain("Your city Bitty Philly will be waiting");
    expect(first[0].data).toEqual({ group_id: "Bitty Philly" });

    const rem = user("u-nick").reminders as Record<string, unknown>;
    expect(rem.date).toBe(TODAY);
    expect(rem.sent).toBe(1);
    expect(rem.farewell_sent_at).toBeTruthy();
    // The city still records that it decided the slot.
    expect(group("Bitty Philly").reminders_sent_slots).toEqual(["evening"]);

    // Last call (streak 3 → the city does decide a nudge) — but not for him.
    await runNudges(LAST_CALL);
    expect(pushesTo("tok-u-nick")).toHaveLength(1);
    expect(group("Bitty Philly").reminders_sent_slots).toEqual(["evening", "lastCall"]);
  });

  it("resumes the day after he opens the app again", async () => {
    await runNudges(EVENING);
    expect(pushesTo("tok-u-nick")).toHaveLength(1);
    // He comes back (presence.ts clears the farewell and stamps him).
    await touchLastSeen("u-nick", { now: LAST_CALL });
    expect((user("u-nick").reminders as Record<string, unknown>).farewell_sent_at).toBeNull();
    await runNudges(LAST_CALL);
    const all = pushesTo("tok-u-nick");
    expect(all).toHaveLength(2);
    expect(all[1].title).toBe("⏳ Last call");
  });
});

describe("runNudges — a cooling member of a crew", () => {
  beforeEach(() => {
    seedGroup("Amitopolis", {
      group_members: ["Amit", "Jennifer"],
      member_uids: ["u-amit", "u-jen"],
      completions_today: ["Jennifer"],
      streak: 3,
    });
    seedUser("u-amit", { last_seen_at: daysBefore(EVENING, 9) });
    seedUser("u-jen", { last_seen_at: daysBefore(EVENING, 0) });
  });

  it("hears nothing in the morning or at midday", async () => {
    await runNudges(MORNING);
    await runNudges(MIDDAY);
    expect(pushesTo("tok-u-amit")).toHaveLength(0);
    expect(group("Amitopolis").reminders_sent_slots).toEqual(["morning", "midday"]);
    // Jennifer is done: nobody pushes her either.
    expect(pushesTo("tok-u-jen")).toHaveLength(0);
  });

  it("gets one evening push naming the friend who is done, then hits the cap at last call", async () => {
    await runNudges(EVENING);
    const evening = pushesTo("tok-u-amit");
    expect(evening).toHaveLength(1);
    expect(evening[0].body.startsWith("Jennifer already checked in — you're the last one. ")).toBe(true);
    expect(evening[0].body).toContain("3-day streak");
    expect((user("u-amit").reminders as Record<string, unknown>).sent).toBe(1);

    await runNudges(LAST_CALL);
    expect(pushesTo("tok-u-amit")).toHaveLength(1); // capped
    // Jennifer (active, done) is the chaser at last call and is not capped.
    const jen = pushesTo("tok-u-jen");
    expect(jen).toHaveLength(1);
    expect(jen[0].title).toBe("⏳ Last call for the crew");
    expect(jen[0].body).toContain("Amit hasn't");
  });
});

describe("runNudges — active and unknown-presence members are untouched", () => {
  beforeEach(() => {
    seedGroup("Scope Creep", {
      group_members: ["Christian", "David"],
      member_uids: ["u-chr", "u-dav"],
      completions_today: ["David"],
      streak: 2,
      current_build: { type: "house_a", days_required: 1, days_completed: 0 },
    });
    seedUser("u-chr", { last_seen_at: daysBefore(EVENING, 1) });
    seedUser("u-dav", {}); // predates the field
  });

  it("sends the active member exactly the single-city copy, stake included", async () => {
    await runNudges(EVENING);
    const [p] = pushesTo("tok-u-chr");
    const expected = messageFor(
      { kind: "streak", recipients: "incomplete", slot: "evening" },
      {
        cityName: "Scope Creep",
        streak: 2,
        build: null,
        pendingNames: ["Christian"],
        completedNames: ["David"],
        landsToday: "Cottage",
      },
    );
    expect(p.title).toBe(expected.title);
    expect(p.body).toBe(expected.body);
    expect(p.body).toContain("Finish today and your Cottage lands tonight.");
    expect(p.data).toEqual({ group_id: "Scope Creep" });
  });

  it("treats a member with no presence stamp as active rather than farewelling them", async () => {
    // Flip who is pending so the unstamped user is the recipient.
    group("Scope Creep").completions_today = ["Christian"];
    await runNudges(MORNING);
    const p = pushesTo("tok-u-dav");
    expect(p).toHaveLength(1);
    expect(p[0].title).not.toContain("stop reminding");
    expect((user("u-dav").reminders as Record<string, unknown>).sent).toBe(1);
  });
});

describe("runNudges — solo cities and quiet slots", () => {
  it("does not even claim the midday slot for an active solo city", async () => {
    seedGroup("Floresta", { group_members: ["Larissa"], member_uids: ["u-lar"] });
    seedUser("u-lar", { last_seen_at: daysBefore(MIDDAY, 0) });
    await runNudges(MIDDAY);
    expect(sent).not.toHaveBeenCalled();
    expect(group("Floresta").reminders_sent_slots).toBeUndefined();
    await runNudges(EVENING);
    expect(pushesTo("tok-u-lar")).toHaveLength(1);
    expect(group("Floresta").reminders_sent_slots).toEqual(["evening"]);
  });

  it("skips writing reminder state for a recipient with no user doc", async () => {
    seedGroup("Ghost Town", { group_members: ["Nobody"], member_uids: ["u-none"] });
    await runNudges(EVENING);
    expect(sent).not.toHaveBeenCalled();
    expect(fs.__store.has("users/u-none")).toBe(false);
  });
});

describe("touchLastSeen", () => {
  it("stamps once, throttles a repeat, and keeps completion minutes capped", async () => {
    seedUser("u-x", { reminders: { date: TODAY, sent: 1, farewell_sent_at: { toDate: () => EVENING } } });
    await touchLastSeen("u-x", { now: EVENING });
    const u = user("u-x");
    expect((u.last_seen_at as { toDate: () => Date }).toDate()).toEqual(EVENING);
    // Coming back clears the farewell but keeps the day's count.
    expect(u.reminders).toEqual({ date: TODAY, sent: 1, farewell_sent_at: null });

    // Five minutes later: no rewrite.
    const later = new Date(EVENING.getTime() + 5 * 60_000);
    await touchLastSeen("u-x", { now: later });
    expect((user("u-x").last_seen_at as { toDate: () => Date }).toDate()).toEqual(EVENING);

    // A completion forces the stamp and records its local minute.
    await touchLastSeen("u-x", { now: later, force: true, completionMinutes: 17 * 60 + 40 });
    expect((user("u-x").last_seen_at as { toDate: () => Date }).toDate()).toEqual(later);
    expect(user("u-x").completion_minutes).toEqual([17 * 60 + 40]);
    for (let i = 0; i < COMPLETION_MINUTES_KEPT + 3; i++) {
      await touchLastSeen("u-x", { now: later, completionMinutes: i });
    }
    expect(user("u-x").completion_minutes).toHaveLength(COMPLETION_MINUTES_KEPT);
  });

  it("creates the doc for a user who has none yet", async () => {
    await touchLastSeen("u-new", { now: EVENING });
    expect(fs.__store.has("users/u-new")).toBe(true);
  });
});
