/**
 * Poll persistence: create, launch, close, vote, and read the tally.
 *
 * See `@backrow/shared/poll` for why tallies are sharded. The short version:
 * every vote in a lecture lands within a few seconds, and DynamoDB serializes
 * concurrent writes to a single item, so a counter attribute on the poll item
 * is the worst possible place to put them.
 */
import { randomUUID } from "node:crypto";
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  pollKey,
  pollQueryPrefix,
  voteKey,
  tallyKey,
  ttlFrom,
  SESSION_TTL_SECONDS,
  TALLY_SHARDS,
  pickShard,
  sumShards,
  countAttr,
  canTransitionPoll,
  type PollState,
} from "@backrow/shared";
import {
  doc,
  TABLE,
  ConditionFailed,
  InvalidTransition,
  isConditionalCheckFailed,
} from "./ddb";

export interface PollRecord {
  entity: "poll";
  pollId: string;
  sessionCode: string;
  question: string;
  options: string[];
  state: PollState;
  createdAt: number;
  /** Debounce marker for live result broadcasts. */
  lastBroadcastAt?: number;
  ttl: number;
}

export class AlreadyVoted extends Error {}

export async function createPoll(params: {
  sessionCode: string;
  question: string;
  options: string[];
  nowMs: number;
  pollId?: string;
}): Promise<PollRecord> {
  const { sessionCode, question, options, nowMs } = params;
  const record: PollRecord = {
    entity: "poll",
    pollId: params.pollId ?? randomUUID(),
    sessionCode,
    question,
    options,
    state: "draft",
    createdAt: nowMs,
    ttl: ttlFrom(nowMs, SESSION_TTL_SECONDS),
  };

  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { ...pollKey(sessionCode, record.pollId), ...record },
    })
  );
  return record;
}

export async function getPoll(
  sessionCode: string,
  pollId: string
): Promise<PollRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE(), Key: pollKey(sessionCode, pollId) })
  );
  return res.Item as PollRecord | undefined;
}

export async function listPolls(sessionCode: string): Promise<PollRecord[]> {
  const { PK, skPrefix } = pollQueryPrefix(sessionCode);
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": PK, ":sk": skPrefix },
    })
  );
  return (res.Items ?? []) as PollRecord[];
}

/**
 * The poll a joining client should be shown.
 *
 * Without this, a client that joins late — or simply reloads — sees no poll at
 * all while one is open, because poll state lives only in the client's memory.
 * That's the same resync problem as session membership, and it has to be solved
 * server-side for the same reason: a reconnect is routine, not exceptional.
 *
 * Drafts are withheld from the audience; a presenter gets their own draft back
 * so a reload doesn't lose the poll they were composing.
 */
export async function getActivePoll(
  sessionCode: string,
  includeDrafts: boolean
): Promise<PollRecord | undefined> {
  const polls = await listPolls(sessionCode);
  const eligible = polls.filter((p) => includeDrafts || p.state !== "draft");
  if (eligible.length === 0) return undefined;

  // An open poll always wins; otherwise show the most recent, so a late joiner
  // still sees the results of the poll that just closed.
  return (
    eligible.find((p) => p.state === "open") ??
    eligible.sort((a, b) => b.createdAt - a.createdAt)[0]
  );
}

/**
 * This voter's existing vote, if any.
 *
 * Returns the option they chose rather than a bare boolean, so a rejoining
 * client can be told exactly what it voted for instead of just "you voted".
 */
export async function getVote(
  pollId: string,
  voterId: string
): Promise<{ optionIndex: number } | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE(), Key: voteKey(pollId, voterId) })
  );
  const item = res.Item as { optionIndex?: number } | undefined;
  return typeof item?.optionIndex === "number"
    ? { optionIndex: item.optionIndex }
    : undefined;
}

/**
 * Move a poll between states.
 *
 * The legal-transition check is enforced in the condition expression, not just
 * in application code, so two presenters racing to close the same poll can't
 * both succeed. Application-level checks lose that race.
 */
export async function setPollState(params: {
  sessionCode: string;
  pollId: string;
  from: PollState;
  to: PollState;
}): Promise<void> {
  const { sessionCode, pollId, from, to } = params;
  if (!canTransitionPoll(from, to)) {
    throw new InvalidTransition(`cannot move poll from ${from} to ${to}`);
  }

  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: pollKey(sessionCode, pollId),
        UpdateExpression: "SET #s = :to",
        // Only apply if the poll is still in the state we read.
        ConditionExpression: "attribute_exists(PK) AND #s = :from",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":to": to, ":from": from },
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new InvalidTransition(
        `poll ${pollId} was no longer in state ${from}`
      );
    }
    throw err;
  }
}

/**
 * Record one vote.
 *
 * Two writes. The first is a conditional put of a per-voter row, which is what
 * makes double-voting impossible — a read-then-write check would race under a
 * burst of simultaneous votes, which is exactly the traffic shape a poll has.
 * Only if that succeeds do we increment a tally shard.
 *
 * If the process died between the two writes the voter would be recorded but
 * uncounted. That's the right way round: a lost vote is a smaller wrong than a
 * double-counted one, and the alternative (increment first) can inflate the
 * tally on any retry.
 */
export async function castVote(params: {
  pollId: string;
  voterId: string;
  optionIndex: number;
  nowMs: number;
  random?: () => number;
}): Promise<void> {
  const { pollId, voterId, optionIndex, nowMs, random } = params;
  const ttl = ttlFrom(nowMs, SESSION_TTL_SECONDS);

  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          ...voteKey(pollId, voterId),
          entity: "vote",
          pollId,
          voterId,
          optionIndex,
          votedAt: nowMs,
          ttl,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new AlreadyVoted(`${voterId} already voted in ${pollId}`);
    }
    throw err;
  }

  const shard = pickShard(random);
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: tallyKey(pollId, shard),
      // ADD on a TOP-LEVEL attribute creates both the attribute and the item if
      // absent, so no seeding pass is needed and concurrent increments merge
      // without read-modify-write. A nested path (`counts.c0`) would instead
      // throw ValidationException on the first vote to a shard, because ADD
      // cannot create a missing parent map.
      UpdateExpression: "ADD #opt :one SET entity = :e, #t = :ttl",
      ExpressionAttributeNames: {
        "#opt": countAttr(optionIndex),
        "#t": "ttl",
      },
      ExpressionAttributeValues: { ":one": 1, ":e": "tally", ":ttl": ttl },
    })
  );
}

/**
 * Sum the tally shards.
 *
 * One BatchGetItem rather than N GetItems. Reads are strongly consistent so a
 * voter sees their own vote reflected — eventual consistency here would show
 * results that appear to go backwards, which reads as a bug to a room full of
 * people watching a bar chart.
 */
export async function readTally(
  pollId: string,
  optionCount: number
): Promise<number[]> {
  const keys = Array.from({ length: TALLY_SHARDS }, (_, i) =>
    tallyKey(pollId, i)
  );

  const res = await doc.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLE()]: { Keys: keys, ConsistentRead: true },
      },
    })
  );

  const items = (res.Responses?.[TABLE()] ?? []) as Array<
    Record<string, unknown>
  >;
  return sumShards(items, optionCount);
}

/**
 * Try to claim the right to broadcast results, at most once per window.
 *
 * A 300-person poll produces 300 votes in seconds. Broadcasting after each one
 * would mean 300 fan-outs to 300 clients — 90,000 pushes for information that
 * changes faster than anyone can read it. This lets whichever invocation wins
 * the conditional update do the broadcast and the rest skip it, with no timer,
 * no queue, and no coordination beyond the single write.
 */
export async function claimBroadcast(params: {
  sessionCode: string;
  pollId: string;
  nowMs: number;
  windowMs: number;
}): Promise<boolean> {
  const { sessionCode, pollId, nowMs, windowMs } = params;
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: pollKey(sessionCode, pollId),
        UpdateExpression: "SET lastBroadcastAt = :now",
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(lastBroadcastAt) OR lastBroadcastAt < :cutoff)",
        ExpressionAttributeValues: {
          ":now": nowMs,
          ":cutoff": nowMs - windowMs,
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export { ConditionFailed, InvalidTransition };
