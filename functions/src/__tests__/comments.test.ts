import {
  MAX_COMMENTS_PER_PROOF,
  MAX_COMMENT_LENGTH,
  ProofComment,
  applyComment,
  cleanCommentText,
  commentPreview,
  commentRecipients,
  commentsFor,
  isGameDate,
  removeComment,
  withoutMemberComments,
} from "../comments";

const c = (id: string, from: string, text = "hi"): ProofComment => ({ id, from, text, at: "2026-10-07T12:00:00Z" });

describe("commentsFor", () => {
  it("reads one proof's list and drops malformed entries", () => {
    const raw = { Tom: [c("1", "Amit"), { id: 2 }, null, c("3", "Sam")] };
    expect(commentsFor(raw, "Tom").map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("is empty for a missing map, owner, or non-array", () => {
    expect(commentsFor(undefined, "Tom")).toEqual([]);
    expect(commentsFor({}, "Tom")).toEqual([]);
    expect(commentsFor({ Tom: "x" }, "Tom")).toEqual([]);
  });
});

describe("cleanCommentText", () => {
  it("trims and collapses runs of blank lines", () => {
    expect(cleanCommentText("  nice  \r\n\r\n\r\n\r\nwork ")).toBe("nice\n\nwork");
  });

  it("refuses empty, non-string and over-long text", () => {
    expect(cleanCommentText("   \n ")).toBeNull();
    expect(cleanCommentText(42)).toBeNull();
    expect(cleanCommentText("a".repeat(MAX_COMMENT_LENGTH + 1))).toBeNull();
    expect(cleanCommentText("a".repeat(MAX_COMMENT_LENGTH))).toHaveLength(MAX_COMMENT_LENGTH);
  });

  it("counts emoji as one character each", () => {
    expect(cleanCommentText("🔥".repeat(MAX_COMMENT_LENGTH))).not.toBeNull();
  });
});

describe("applyComment", () => {
  it("appends in order", () => {
    const r = applyComment([c("1", "Amit")], c("2", "Sam"));
    expect(r.ok && r.comments.map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("refuses once a proof is full", () => {
    const full = Array.from({ length: MAX_COMMENTS_PER_PROOF }, (_, i) => c(String(i), "Amit"));
    expect(applyComment(full, c("x", "Sam"))).toEqual({ ok: false, reason: "full" });
  });
});

describe("removeComment", () => {
  const list = [c("1", "Amit"), c("2", "Sam")];

  it("lets the author remove their own", () => {
    const r = removeComment(list, "1", "Tom", "Amit");
    expect(r.ok && r.comments.map((x) => x.id)).toEqual(["2"]);
  });

  it("lets the proof's owner remove anyone's", () => {
    expect(removeComment(list, "2", "Tom", "Tom").ok).toBe(true);
  });

  it("refuses a third member, and an unknown id", () => {
    expect(removeComment(list, "1", "Tom", "Sam")).toEqual({ ok: false, reason: "not-allowed" });
    expect(removeComment(list, "9", "Tom", "Tom")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("commentRecipients", () => {
  const members = ["Tom", "Amit", "Sam", "Jo"];

  it("the owner hears it; earlier commenters hear the thread; never the author", () => {
    const before = [c("1", "Amit"), c("2", "Sam"), c("3", "Amit"), c("4", "Tom")];
    expect(commentRecipients(before, "Tom", "Jo", members)).toEqual({ owner: "Tom", thread: ["Amit", "Sam"] });
    expect(commentRecipients(before, "Tom", "Amit", members)).toEqual({ owner: "Tom", thread: ["Sam"] });
  });

  it("the owner answering under their own proof pings the thread only", () => {
    expect(commentRecipients([c("1", "Amit")], "Tom", "Tom", members)).toEqual({ owner: null, thread: ["Amit"] });
  });

  it("skips people who have left the city", () => {
    expect(commentRecipients([c("1", "Gone")], "Tom", "Amit", members)).toEqual({ owner: "Tom", thread: [] });
    expect(commentRecipients([], "Gone", "Amit", members)).toEqual({ owner: null, thread: [] });
  });
});

describe("withoutMemberComments", () => {
  it("drops their proof's thread and what they wrote elsewhere", () => {
    const raw = { Amit: [c("1", "Tom")], Tom: [c("2", "Amit"), c("3", "Sam")], Sam: [c("4", "Amit")] };
    expect(withoutMemberComments(raw, "Amit")).toEqual({ Tom: [c("3", "Sam")] });
  });

  it("is null when the day has nothing of theirs", () => {
    expect(withoutMemberComments({ Tom: [c("1", "Sam")] }, "Amit")).toBeNull();
    expect(withoutMemberComments(undefined, "Amit")).toBeNull();
  });
});

describe("helpers", () => {
  it("isGameDate", () => {
    expect(isGameDate("2026-10-07")).toBe(true);
    expect(isGameDate("2026-10-7")).toBe(false);
    expect(isGameDate(null)).toBe(false);
  });

  it("commentPreview takes the first non-blank line and cuts long ones", () => {
    expect(commentPreview("\n  hey there \nmore")).toBe("hey there");
    expect(commentPreview("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
