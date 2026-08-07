/**
 * Reaction persistence: count a tap, claim a broadcast window, read totals.
 *
 * See `@backrow/shared/reaction` for the reasoning. The short version: reactions
 * are the only unbounded-volume event in the system, so the thing that has to be
 * bounded is the fan-out, not the write.
 */
import { UpdateCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import {
  reactionKey,
  reactionClaimKey,
  cooldownKey,
  ttlFrom,
  SESSION_TTL_SECONDS,
  REACTION_SHARDS,
  REACTION_COOLDOWN_MS,
  REACTION_WINDOW_MS,
  reactionAttr,
  reactionWindow,
  pickReactionShard,
  sumReactions,
} from "@backrow/shared";
import {
  doc,
  TABLE,
  claimRateLimit,
  isConditionalCheckFailed,
} from "./ddb";

/**
 * Count one reaction, or report that the client is going too fast.
 *
 * Returns false when the cooldown rejects it. The caller drops it silently
 * rather than replying — a reaction that didn't register is not worth a frame,
 * and replying to every throttled tap would spend exactly the fan-out budget the
 * coalescing window exists to protect.
 *
 * The cooldown is claimed before the counter is incremented, so a client holding
 * the button down never inflates the total it is being throttled out of.
 */
export async function recordReaction(params: {
  sessionCode: string;
  clientId: string;
  reaction: number;
  nowMs: number;
  cooldownMs?: number;
  random?: () => number;
}): Promise<boolean> {
  const { sessionCode, clientId, reaction, nowMs, random } = params;

  const allowed = await claimRateLimit({
    key: cooldownKey(sessionCode, clientId, "react"),
    nowMs,
    windowMs: params.cooldownMs ?? REACTION_COOLDOWN_MS,
  });
  if (!allowed) return false;

  const ttl = ttlFrom(nowMs, SESSION_TTL_SECONDS);
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: reactionKey(sessionCode, pickReactionShard(random)),
      // Top-level ADD: creates both attribute and item on first write. A nested
      // path would throw ValidationException on every shard's first reaction,
      // which is the bug that bit the poll tally.
      UpdateExpression: "ADD #r :one SET entity = :e, #t = :ttl",
      ExpressionAttributeNames: { "#r": reactionAttr(reaction), "#t": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":e": "reactions", ":ttl": ttl },
    })
  );

  return true;
}

/**
 * Try to win the right to broadcast totals for the current window.
 *
 * Exactly one invocation per window succeeds; every other reaction in that
 * window skips the fan-out entirely. The lock is a conditional put on a
 * window-numbered key rather than a timestamp comparison on a shared row, so
 * consecutive windows are separate items in separate partitions — nothing stays
 * hot for the length of a lecture, and the many losers' failed writes move to a
 * new row every window instead of hammering one forever.
 */
export async function claimReactionWindow(params: {
  sessionCode: string;
  nowMs: number;
  windowMs?: number;
}): Promise<boolean> {
  const { sessionCode, nowMs } = params;
  const windowMs = params.windowMs ?? REACTION_WINDOW_MS;
  const window = reactionWindow(nowMs, windowMs);

  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: reactionClaimKey(sessionCode, window),
        UpdateExpression: "SET wonAt = :now, entity = :e, #t = :ttl",
        ConditionExpression: "attribute_not_exists(PK)",
        ExpressionAttributeNames: { "#t": "ttl" },
        ExpressionAttributeValues: {
          ":now": nowMs,
          ":e": "claim",
          // Claim rows are pure garbage after their window. A short TTL keeps
          // one row per second per session from accumulating for a day.
          ":ttl": ttlFrom(nowMs, 60 * 60),
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Read cumulative totals across all shards.
 *
 * One BatchGetItem. Strongly consistent, so the client that just reacted sees a
 * total that includes its own tap — eventually-consistent reads here would make
 * the counter appear to stall or go backwards, which reads as a broken feature.
 */
export async function readReactionTotals(
  sessionCode: string
): Promise<number[]> {
  const keys = Array.from({ length: REACTION_SHARDS }, (_, i) =>
    reactionKey(sessionCode, i)
  );

  const res = await doc.send(
    new BatchGetCommand({
      RequestItems: { [TABLE()]: { Keys: keys, ConsistentRead: true } },
    })
  );

  return sumReactions(
    (res.Responses?.[TABLE()] ?? []) as Array<Record<string, unknown>>
  );
}
