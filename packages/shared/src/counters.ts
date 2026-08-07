/**
 * The sharded-counter pattern, factored out because Phase 2 uses it twice.
 *
 * Poll tallies and reaction totals have the same shape: many concurrent writers
 * doing atomic `ADD` on a small set of numeric attributes, spread across N
 * items so no single item serializes the burst. They differ only in the
 * attribute prefix and the shard count, so the summing logic lives here rather
 * than being copy-pasted with a one-character difference.
 */

/**
 * Sum per-index counters across shard items into a dense array.
 *
 * Only in-range attributes are read, so a shard written against an older
 * version of the poll (or an older emoji set) can't corrupt the current total.
 * Missing shards are skipped rather than treated as zero-length: a shard item
 * doesn't exist until its first `ADD`, which is the normal state for most
 * shards early on.
 */
export function sumCounters(
  shards: Array<Record<string, unknown> | undefined>,
  count: number,
  attr: (index: number) => string
): number[] {
  const totals = new Array<number>(count).fill(0);
  for (const shard of shards) {
    if (!shard) continue;
    for (let i = 0; i < count; i++) {
      const value = shard[attr(i)];
      if (typeof value === "number") totals[i] += value;
    }
  }
  return totals;
}

/**
 * Pick a shard for a write.
 *
 * Randomness is injected rather than reaching for `Math.random` internally so
 * tests can pin the shard without stubbing globals.
 */
export function pickShardOf(
  shards: number,
  random: () => number = Math.random
): number {
  return Math.floor(random() * shards) % shards;
}
