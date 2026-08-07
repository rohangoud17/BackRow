/**
 * DynamoDB single-table key design.
 *
 * One table, adjacency-list pattern. Three item shapes:
 *
 *   SESSION#<code>  / SESSION#<code>   -> the session record
 *   CONN#<connId>   / CONN#<connId>    -> the connection record (reverse lookup)
 *   SESSION#<code>  / CONN#<connId>    -> membership edge (fan-out list)
 *
 * Why the duplication: fan-out needs "every connection in session X", which the
 * membership edges give us as a single Query on PK = SESSION#<code> with SK
 * begins_with CONN#. Disconnect needs the opposite — "which session was this
 * connection in?" — which the connection record answers without a scan or a
 * GSI. Two small writes on join buys us one cheap read on every broadcast.
 *
 * Every item carries a numeric `ttl` so abandoned sessions and leaked
 * connection records expire on their own instead of accumulating forever.
 */

export interface TableKey {
  PK: string;
  SK: string;
}

export const SESSION_PREFIX = "SESSION#";
export const CONN_PREFIX = "CONN#";

/** The session record itself. */
export const sessionKey = (sessionCode: string): TableKey => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  SK: `${SESSION_PREFIX}${sessionCode}`,
});

/** The connection record — reverse lookup from connectionId to session. */
export const connectionKey = (connectionId: string): TableKey => ({
  PK: `${CONN_PREFIX}${connectionId}`,
  SK: `${CONN_PREFIX}${connectionId}`,
});

/** A membership edge — one per connection per session, used for fan-out. */
export const membershipKey = (
  sessionCode: string,
  connectionId: string
): TableKey => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  SK: `${CONN_PREFIX}${connectionId}`,
});

/** Query prefix for "all membership edges in this session". */
export const membershipQueryPrefix = (sessionCode: string) => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  skPrefix: CONN_PREFIX,
});

/** A poll belongs to a session, so it shares the session partition. */
export const POLL_PREFIX = "POLL#";
export const VOTE_PREFIX = "VOTE#";

export const pollKey = (sessionCode: string, pollId: string): TableKey => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  SK: `${POLL_PREFIX}${pollId}`,
});

/** Query prefix for "every poll in this session". */
export const pollQueryPrefix = (sessionCode: string) => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  skPrefix: POLL_PREFIX,
});

/**
 * One row per voter, used purely to reject a second vote. Writing it with
 * `attribute_not_exists` is what makes double-voting impossible rather than
 * merely unlikely — checking-then-writing would race under a burst.
 */
export const voteKey = (pollId: string, voterId: string): TableKey => ({
  PK: `${POLL_PREFIX}${pollId}`,
  SK: `${VOTE_PREFIX}${voterId}`,
});

/**
 * A tally shard.
 *
 * The shard index is in the PARTITION key, not the sort key. Sharding the sort
 * key would spread writes across items but keep them all in one partition,
 * fixing item-level contention while leaving the per-partition write ceiling
 * untouched. This spreads both.
 */
export const tallyKey = (pollId: string, shard: number): TableKey => ({
  PK: `${POLL_PREFIX}${pollId}#S#${shard}`,
  SK: "TALLY",
});

export const QUESTION_PREFIX = "QA#";
export const UPVOTE_PREFIX = "UP#";
export const COOLDOWN_PREFIX = "COOL#";

/** A question belongs to a session, so it shares the session partition. */
export const questionKey = (
  sessionCode: string,
  questionId: string
): TableKey => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  SK: `${QUESTION_PREFIX}${questionId}`,
});

/** Query prefix for "every question in this session". */
export const questionQueryPrefix = (sessionCode: string) => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  skPrefix: QUESTION_PREFIX,
});

/**
 * One row per upvoter per question, so a duplicate upvote collides on write.
 * Same mechanism as poll votes: a conditional put, not a read-then-check.
 */
export const upvoteKey = (questionId: string, voterId: string): TableKey => ({
  PK: `${QUESTION_PREFIX}${questionId}`,
  SK: `${UPVOTE_PREFIX}${voterId}`,
});

/**
 * Rate-limit marker for one client in one session.
 *
 * Holds a `lastAt` timestamp updated conditionally, rather than a row that
 * expires — DynamoDB TTL deletion is asynchronous and can lag by hours, so it
 * cannot implement a short cooldown.
 */
export const cooldownKey = (
  sessionCode: string,
  clientId: string,
  action: string
): TableKey => ({
  PK: `${SESSION_PREFIX}${sessionCode}`,
  SK: `${COOLDOWN_PREFIX}${action}#${clientId}`,
});

/** Entity discriminator stored on every item, for clarity when browsing. */
export type EntityType =
  | "session"
  | "connection"
  | "membership"
  | "poll"
  | "vote"
  | "tally"
  | "question"
  | "upvote"
  | "cooldown";

/**
 * Compute an absolute epoch-seconds TTL.
 *
 * Pass `now` explicitly — handlers get it from the Lambda invocation so tests
 * stay deterministic and nothing here depends on a hidden clock.
 */
export const ttlFrom = (nowMs: number, seconds: number): number =>
  Math.floor(nowMs / 1000) + seconds;

/** A WebSocket connection can't outlive API Gateway's 2-hour cap; pad it. */
export const CONNECTION_TTL_SECONDS = 3 * 60 * 60;

/** Sessions expire a day after creation unless something refreshes them. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
