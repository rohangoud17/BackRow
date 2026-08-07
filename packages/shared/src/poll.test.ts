import {
  canTransitionPoll,
  canTransitionSession,
  pickShard,
  sumShards,
  totalOf,
  TALLY_SHARDS,
  tallyKey,
  voteKey,
  pollKey,
  parseClientMessage,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  countAttr,
} from "./index";

describe("session state machine", () => {
  test("allows the forward path and nothing else", () => {
    expect(canTransitionSession("lobby", "active")).toBe(true);
    expect(canTransitionSession("lobby", "closed")).toBe(true);
    expect(canTransitionSession("active", "closed")).toBe(true);
  });

  test("closed is terminal", () => {
    // Reopening would let clients rejoin something the presenter moved on
    // from, and makes "did this end?" unanswerable from the record.
    expect(canTransitionSession("closed", "active")).toBe(false);
    expect(canTransitionSession("closed", "lobby")).toBe(false);
    expect(canTransitionSession("closed", "closed")).toBe(false);
  });

  test("cannot go backwards or sit still", () => {
    expect(canTransitionSession("active", "lobby")).toBe(false);
    expect(canTransitionSession("active", "active")).toBe(false);
    expect(canTransitionSession("lobby", "lobby")).toBe(false);
  });
});

describe("poll state machine", () => {
  test("draft can open or be abandoned straight to closed", () => {
    expect(canTransitionPoll("draft", "open")).toBe(true);
    expect(canTransitionPoll("draft", "closed")).toBe(true);
  });

  test("closed is terminal, so a tally can never reopen", () => {
    expect(canTransitionPoll("closed", "open")).toBe(false);
    expect(canTransitionPoll("open", "draft")).toBe(false);
  });
});

describe("tally sharding", () => {
  test("shard keys spread across partitions, not just sort keys", () => {
    // Sharding only the sort key would spread writes across items but keep
    // them in one partition — fixing item contention while leaving the
    // per-partition write ceiling in place.
    const a = tallyKey("p1", 0);
    const b = tallyKey("p1", 1);
    expect(a.PK).not.toBe(b.PK);
    expect(a.SK).toBe(b.SK);
  });

  test("pickShard stays in range for any random value", () => {
    for (const r of [0, 0.0001, 0.5, 0.9999]) {
      const shard = pickShard(() => r);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(TALLY_SHARDS);
    }
  });

  test("pickShard handles random() returning exactly 1", () => {
    // Math.random() is documented as < 1, but a stub or a future engine
    // quirk shouldn't produce an out-of-range shard and a lost vote.
    expect(pickShard(() => 1)).toBeLessThan(TALLY_SHARDS);
  });

  test("sums counts across shards into a dense array", () => {
    const totals = sumShards(
      [{ c0: 3, c1: 1 }, undefined, { c1: 4 }, { c2: 2 }],
      3
    );
    expect(totals).toEqual([3, 5, 2]);
    expect(totalOf(totals)).toBe(10);
  });

  test("counts are top-level attributes, not a nested map", () => {
    // DynamoDB's ADD cannot create a missing parent map, so `counts.c0` throws
    // ValidationException on the first vote to a shard. Top-level `c0` works.
    expect(countAttr(0)).toBe("c0");
    expect(countAttr(7)).toBe("c7");
    expect(countAttr(3)).not.toContain(".");
  });

  test("missing shards count as zero, not undefined", () => {
    // Shards only exist once written, so an unvoted option must read as 0.
    expect(sumShards([], 3)).toEqual([0, 0, 0]);
    expect(sumShards([undefined, undefined], 2)).toEqual([0, 0]);
  });

  test("ignores counts outside the poll's option range", () => {
    // A shard written against an older version of the poll must not corrupt
    // the current tally or blow the array out.
    expect(sumShards([{ c0: 1, c9: 99, ttl: 12345 }], 2)).toEqual([1, 0]);
  });

  test("ignores non-numeric attributes on the shard item", () => {
    // Shards carry PK/SK/entity/ttl alongside the counters.
    expect(
      sumShards([{ c0: 2, entity: "tally", PK: "POLL#x#S#0" }], 2)
    ).toEqual([2, 0]);
  });
});

describe("poll and vote keys", () => {
  test("polls live in the session partition", () => {
    expect(pollKey("ACDEFG", "p1")).toEqual({
      PK: "SESSION#ACDEFG",
      SK: "POLL#p1",
    });
  });

  test("one vote row per voter, keyed so a duplicate collides", () => {
    // The conditional put on this key is what makes double-voting impossible
    // rather than merely unlikely.
    expect(voteKey("p1", "voter-a")).toEqual({
      PK: "POLL#p1",
      SK: "VOTE#voter-a",
    });
    expect(voteKey("p1", "voter-a")).toEqual(voteKey("p1", "voter-a"));
    expect(voteKey("p1", "voter-b").SK).not.toBe(voteKey("p1", "voter-a").SK);
  });
});

describe("poll message validation", () => {
  const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

  test("accepts a well-formed poll", () => {
    expect(parse({ type: "createPoll", question: "Ok?", options: ["a", "b"] }).ok)
      .toBe(true);
  });

  test("rejects fewer than two options", () => {
    expect(parse({ type: "createPoll", question: "Q", options: ["only"] }).ok)
      .toBe(false);
    expect(parse({ type: "createPoll", question: "Q", options: [] }).ok)
      .toBe(false);
  });

  test("rejects more options than the tally can address", () => {
    const tooMany = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `o${i}`);
    expect(parse({ type: "createPoll", question: "Q", options: tooMany }).ok)
      .toBe(false);
  });

  test("accepts exactly the boundary counts", () => {
    const min = Array.from({ length: MIN_POLL_OPTIONS }, (_, i) => `o${i}`);
    const max = Array.from({ length: MAX_POLL_OPTIONS }, (_, i) => `o${i}`);
    expect(parse({ type: "createPoll", question: "Q", options: min }).ok).toBe(true);
    expect(parse({ type: "createPoll", question: "Q", options: max }).ok).toBe(true);
  });

  test("rejects empty question or empty option text", () => {
    expect(parse({ type: "createPoll", question: "", options: ["a", "b"] }).ok)
      .toBe(false);
    expect(parse({ type: "createPoll", question: "Q", options: ["a", ""] }).ok)
      .toBe(false);
  });

  test("rejects a non-integer or negative option index", () => {
    expect(parse({ type: "vote", pollId: "p1", optionIndex: 1.5 }).ok).toBe(false);
    expect(parse({ type: "vote", pollId: "p1", optionIndex: -1 }).ok).toBe(false);
  });

  test("rejects an unknown session state", () => {
    expect(parse({ type: "setSessionState", state: "paused" }).ok).toBe(false);
    expect(parse({ type: "setSessionState", state: "active" }).ok).toBe(true);
  });
});
