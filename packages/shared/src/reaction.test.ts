import {
  REACTION_EMOJI,
  REACTION_COUNT,
  REACTION_SHARDS,
  MAX_REACTION_BURST,
  reactionAttr,
  reactionWindow,
  reactionDeltas,
  isReactionIndex,
  sumReactions,
  pickReactionShard,
  totalReactions,
  reactionKey,
  reactionClaimKey,
  cooldownKey,
  parseClientMessage,
} from "./index";

describe("the reaction set", () => {
  test("index is identity, so the set is append-only", () => {
    // If these ever change, every stored counter silently re-maps to a
    // different emoji. Pinning them makes that a failing test rather than a
    // confusing bug in a live lecture.
    expect(REACTION_EMOJI[0]).toBe("👍");
    expect(REACTION_EMOJI[REACTION_COUNT - 1]).toBe("🤔");
    expect(new Set(REACTION_EMOJI).size).toBe(REACTION_COUNT);
  });

  test("only in-range integer indices are reactions", () => {
    expect(isReactionIndex(0)).toBe(true);
    expect(isReactionIndex(REACTION_COUNT - 1)).toBe(true);
    expect(isReactionIndex(REACTION_COUNT)).toBe(false);
    expect(isReactionIndex(-1)).toBe(false);
    expect(isReactionIndex(1.5)).toBe(false);
  });
});

describe("counter attributes", () => {
  test("counts are top-level attributes, never a nested path", () => {
    // DynamoDB's ADD cannot create a missing parent map, so `counts.r0` throws
    // ValidationException on the first write to every shard. This exact mistake
    // shipped once in the poll tally.
    for (let i = 0; i < REACTION_COUNT; i++) {
      expect(reactionAttr(i)).not.toContain(".");
    }
    expect(reactionAttr(0)).toBe("r0");
  });

  test("summing skips absent shards and out-of-range attributes", () => {
    const totals = sumReactions([
      { r0: 2, r1: 1 },
      undefined,
      { r0: 3, [`r${REACTION_COUNT + 5}`]: 99 },
      { r0: "not a number" },
    ]);
    expect(totals[0]).toBe(5);
    expect(totals[1]).toBe(1);
    expect(totals).toHaveLength(REACTION_COUNT);
    expect(totalReactions(totals)).toBe(6);
  });

  test("shards stay in range for any random value", () => {
    for (const r of [0, 0.5, 0.999999, 1]) {
      const shard = pickReactionShard(() => r);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(REACTION_SHARDS);
    }
  });
});

describe("keys", () => {
  test("reaction counters live outside the session partition", () => {
    // The highest-volume writes in the system must not land on the partition
    // that every fan-out reads membership from.
    expect(reactionKey("ACDEFG", 3).PK).not.toBe("SESSION#ACDEFG");
    expect(reactionKey("ACDEFG", 3)).toEqual({
      PK: "REACT#ACDEFG#S#3",
      SK: "REACTIONS",
    });
  });

  test("each window claims a different item, so no key stays hot", () => {
    expect(reactionClaimKey("ACDEFG", 100).PK).not.toBe(
      reactionClaimKey("ACDEFG", 101).PK
    );
  });

  test("cooldown rows are partitioned by client, not by session", () => {
    // Partitioning by session would funnel every client's cooldown write into
    // one partition — ~1,000 writes/sec for a 500-person room reacting, right
    // at DynamoDB's per-partition ceiling, and invisible in a two-tab test.
    const a = cooldownKey("ACDEFG", "client-a", "react");
    const b = cooldownKey("ACDEFG", "client-b", "react");
    expect(a.PK).not.toBe(b.PK);
    expect(a.PK).not.toBe("SESSION#ACDEFG");
  });

  test("cooldowns are per action, so reacting can't throttle asking", () => {
    expect(cooldownKey("ACDEFG", "c1", "react")).not.toEqual(
      cooldownKey("ACDEFG", "c1", "ask")
    );
  });
});

describe("broadcast windows", () => {
  test("timestamps in the same window share a bucket", () => {
    expect(reactionWindow(10_000, 1000)).toBe(reactionWindow(10_999, 1000));
    expect(reactionWindow(10_999, 1000)).not.toBe(reactionWindow(11_000, 1000));
  });
});

describe("reactionDeltas", () => {
  test("animates only what changed since the last frame", () => {
    expect(reactionDeltas([1, 5, 0, 0, 0, 0], [3, 5, 2, 0, 0, 0])).toEqual([
      2, 0, 2, 0, 0, 0,
    ]);
  });

  test("caps a burst so a backgrounded tab doesn't animate hundreds", () => {
    const deltas = reactionDeltas([0, 0, 0, 0, 0, 0], [500, 0, 0, 0, 0, 0]);
    expect(deltas[0]).toBe(MAX_REACTION_BURST);
  });

  test("never goes negative when frames arrive out of order", () => {
    // Totals are monotonic, so a lower value is a stale frame. A negative delta
    // would corrupt the baseline as well as rendering nothing.
    expect(reactionDeltas([9, 0, 0, 0, 0, 0], [4, 0, 0, 0, 0, 0])[0]).toBe(0);
  });

  test("with no baseline it reports the totals, capped", () => {
    // The client, not this function, decides that a first frame is history
    // rather than an event — this only defines what "no baseline" means.
    expect(reactionDeltas(undefined, [2, 0, 0, 0, 0, 0])[0]).toBe(2);
  });
});

describe("react message validation", () => {
  const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

  test("accepts every index in the set", () => {
    for (let i = 0; i < REACTION_COUNT; i++) {
      expect(parse({ type: "react", reaction: i }).ok).toBe(true);
    }
  });

  test("rejects anything outside it", () => {
    // A reaction is an index, never an emoji character — otherwise the server
    // is putting client-supplied text on everyone else's screen.
    expect(parse({ type: "react", reaction: REACTION_COUNT }).ok).toBe(false);
    expect(parse({ type: "react", reaction: -1 }).ok).toBe(false);
    expect(parse({ type: "react", reaction: 1.5 }).ok).toBe(false);
    expect(parse({ type: "react", reaction: "👍" }).ok).toBe(false);
    expect(parse({ type: "react" }).ok).toBe(false);
  });
});
