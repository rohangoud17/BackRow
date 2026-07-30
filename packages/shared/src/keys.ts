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

/** Entity discriminator stored on every item, for clarity when browsing. */
export type EntityType = "session" | "connection" | "membership";

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
