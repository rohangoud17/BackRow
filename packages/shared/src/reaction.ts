/**
 * Reactions — the floating emoji stream.
 *
 * Reactions are the only Phase 2 feature with genuinely unbounded volume. A
 * student votes once per poll and upvotes once per question; there is no limit
 * on how many times they can tap a heart. So the design problem is different
 * from polls and Q&A, and it is not the write path — it's the fan-out.
 *
 * ## Why totals are broadcast instead of individual reactions
 *
 * Relaying each reaction the way `broadcast` relays a message would be
 * quadratic: 300 students reacting twice a second in a 300-person room is
 * ~180,000 `PostToConnection` calls per second for information nobody can read
 * at that rate. Instead every reaction lands in a sharded counter, and a
 * coalescing window broadcasts the *cumulative totals* at most once per
 * `REACTION_WINDOW_MS`. Fan-out is therefore bounded by time and room size, not
 * by how hard people are tapping.
 *
 * Cumulative totals rather than per-window deltas, deliberately. A delta frame
 * that gets dropped is lost information; a totals frame that gets dropped is
 * corrected by the next one. Clients derive their own delta by comparing
 * against the last totals they saw, which makes the protocol self-healing and
 * idempotent — and means a late joiner can be handed the current totals with no
 * special-case message.
 *
 * ## Why the emoji set is closed and indexed
 *
 * Reactions travel as an array of counts positioned by index, not as a map of
 * emoji to count. That keeps every frame the same tiny size no matter the
 * traffic, removes a moderation surface (arbitrary client-supplied emoji would
 * be arbitrary client-supplied text on everyone's screen), and makes the
 * DynamoDB attribute names a fixed, known set.
 *
 * Adding an emoji is append-only. Inserting or reordering would silently
 * re-map existing counters, since the index *is* the identity.
 */
import { sumCounters, pickShardOf } from "./counters";

/**
 * The allowed reactions, in display order. Index is identity — append only.
 */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "🎉", "🤔"] as const;

export type ReactionIndex = number;

export const REACTION_COUNT = REACTION_EMOJI.length;

/**
 * Minimum gap between reactions from one client.
 *
 * Short enough that tapping feels responsive, long enough to cap one client at
 * two reactions per second. This is the only thing bounding total write volume,
 * which is why the limit is enforced server-side and the client throttle is
 * treated as a courtesy rather than a control.
 */
export const REACTION_COOLDOWN_MS = 500;

/**
 * How often reaction totals may be pushed to a session.
 *
 * One second is about the fastest a burst of floating emoji reads as a burst
 * rather than a blur, so this is a legibility limit as much as a cost one.
 */
export const REACTION_WINDOW_MS = 1000;

/**
 * Counter shards per session.
 *
 * Eight is ample: the per-client cooldown caps a 500-person room at ~1,000
 * reactions/sec, which spread over eight partitions is ~125 writes/sec each —
 * an order of magnitude under DynamoDB's per-partition ceiling.
 */
export const REACTION_SHARDS = 8;

/**
 * Most emoji a client will float for a single totals update.
 *
 * Without a cap, a client that was backgrounded for a minute would come back to
 * a totals jump of several hundred and try to animate all of them. The cap
 * makes the animation a signal of intensity rather than a literal rendering of
 * every tap.
 */
export const MAX_REACTION_BURST = 12;

/**
 * Attribute name for one emoji's count on a shard.
 *
 * Top-level (`r0`, `r1`, …) for the same reason poll counts are: DynamoDB's
 * `ADD` cannot create a missing parent map, so a nested path fails on the first
 * write to every shard. This cost us a production error once already — see the
 * `countAttr` note in `poll.ts`.
 */
export const reactionAttr = (index: number): string => `r${index}`;

export const isReactionIndex = (index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < REACTION_COUNT;

/** Sum reaction shards into per-emoji totals. */
export const sumReactions = (
  shards: Array<Record<string, unknown> | undefined>
): number[] => sumCounters(shards, REACTION_COUNT, reactionAttr);

/** Pick a reaction shard to write to. */
export const pickReactionShard = (random?: () => number): number =>
  pickShardOf(REACTION_SHARDS, random);

/**
 * The window a timestamp belongs to.
 *
 * Used as part of a claim key so exactly one invocation per window broadcasts.
 * Bucketing by time rather than comparing against a stored `lastAt` means each
 * window is a distinct item, so consecutive windows never contend with each
 * other and no single key stays hot across the whole session.
 */
export const reactionWindow = (
  nowMs: number,
  windowMs: number = REACTION_WINDOW_MS
): number => Math.floor(nowMs / windowMs);

/**
 * How many emoji a client should float, given totals it just received and the
 * totals it had before.
 *
 * Clamped at zero per emoji because totals must never appear to go backwards:
 * two totals frames can arrive out of order, and a negative delta would
 * otherwise render as nothing while corrupting the client's baseline.
 */
export function reactionDeltas(
  previous: number[] | undefined,
  totals: number[],
  cap: number = MAX_REACTION_BURST
): number[] {
  return totals.map((total, i) => {
    const before = previous?.[i] ?? 0;
    return Math.min(Math.max(total - before, 0), cap);
  });
}

export const totalReactions = (totals: number[]): number =>
  totals.reduce((a, b) => a + b, 0);
