/**
 * Polls and the session state machine.
 *
 * The interesting problem here is counting votes without a hot key.
 *
 * A poll in a 300-person lecture takes every vote within a few seconds. The
 * naive design — one counter attribute per option on the poll item — makes
 * every vote a write to the *same* DynamoDB item, and DynamoDB serializes
 * concurrent writes to a single item. Under a burst that produces contention,
 * retries, and eventually throttling, on the one item you can least afford to
 * lose writes to.
 *
 * So tallies are sharded. Each vote does an atomic ADD to one randomly chosen
 * shard, and reading results sums the shards. The shard index lives in the
 * PARTITION key, not the sort key: sharding the sort key would spread writes
 * across items but leave them all in one partition, which fixes item-level
 * contention while leaving the 1,000 WCU/s per-partition ceiling in place.
 *
 * Honest note on scale: at 500 students voting over 30 seconds — roughly 17
 * writes/sec — a single unsharded item would cope fine. Sharding earns its
 * keep at a few hundred writes/sec and up. It's here because the cost is a few
 * lines and retrofitting a counter design after data exists is genuinely
 * unpleasant.
 */

/** Number of tally shards per poll. Powers of two keep the modulo cheap. */
export const TALLY_SHARDS = 8;

/** Poll lifecycle. Votes are only accepted while `open`. */
export type PollState = "draft" | "open" | "closed";

export const MAX_POLL_OPTIONS = 8;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_QUESTION = 280;
export const MAX_POLL_OPTION = 120;

/** Legal poll transitions. Terminal at `closed`, like a session. */
const POLL_TRANSITIONS: Record<PollState, PollState[]> = {
  draft: ["open", "closed"],
  open: ["closed"],
  closed: [],
};

export function canTransitionPoll(from: PollState, to: PollState): boolean {
  return POLL_TRANSITIONS[from].includes(to);
}

/** Pick a shard for a write. Injected randomness keeps tests deterministic. */
export function pickShard(
  random: () => number = Math.random,
  shards: number = TALLY_SHARDS
): number {
  return Math.floor(random() * shards) % shards;
}

/**
 * Attribute name holding the count for one option on a tally shard.
 *
 * Counts are **top-level** attributes (`c0`, `c1`, …), not keys inside a
 * `counts` map. That is not cosmetic: DynamoDB's `ADD` on a nested path
 * (`counts.c0`) fails with a ValidationException when the parent map doesn't
 * exist, which is precisely the state of every shard before its first vote.
 * A top-level `ADD c0 :one` creates the attribute — and the item — on demand,
 * so a vote is one atomic write with no seeding pass.
 */
export const countAttr = (optionIndex: number): string => `c${optionIndex}`;

/** Sum per-option counts across shards into a dense array. */
export function sumShards(
  shards: Array<Record<string, unknown> | undefined>,
  optionCount: number
): number[] {
  const totals = new Array<number>(optionCount).fill(0);
  for (const shard of shards) {
    if (!shard) continue;
    for (let i = 0; i < optionCount; i++) {
      const value = shard[countAttr(i)];
      // Reading only in-range attributes means a shard written against an
      // older version of the poll can't corrupt the current tally.
      if (typeof value === "number") totals[i] += value;
    }
  }
  return totals;
}

export interface PollResults {
  pollId: string;
  counts: number[];
  totalVotes: number;
}

export const totalOf = (counts: number[]): number =>
  counts.reduce((a, b) => a + b, 0);
