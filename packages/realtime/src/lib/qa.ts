/**
 * Q&A persistence: ask, upvote, moderate.
 *
 * See `@backrow/shared/qa` for why upvotes use a plain counter while poll votes
 * are sharded, and why ordering happens on the client.
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
  questionKey,
  questionQueryPrefix,
  upvoteKey,
  cooldownKey,
  ttlFrom,
  SESSION_TTL_SECONDS,
  ASK_COOLDOWN_MS,
  stateAfterModeration,
  type QuestionState,
  type ModerationAction,
} from "@backrow/shared";
import {
  doc,
  TABLE,
  claimRateLimit,
  isConditionalCheckFailed,
} from "./ddb";

export interface QuestionRecord {
  entity: "question";
  questionId: string;
  sessionCode: string;
  text: string;
  displayName?: string;
  /** Voter id of the asker, so a client can recognise its own question. */
  askedBy: string;
  upvotes: number;
  state: QuestionState;
  askedAt: number;
  ttl: number;
}

export class AlreadyUpvoted extends Error {}
export class RateLimited extends Error {}

/**
 * Submit a question, subject to a per-client cooldown.
 *
 * The cooldown is claimed *before* the write, so a client hammering the button
 * can't create a burst of rows and then be told off afterwards.
 */
export async function askQuestion(params: {
  sessionCode: string;
  text: string;
  displayName?: string;
  askedBy: string;
  nowMs: number;
  questionId?: string;
  cooldownMs?: number;
}): Promise<QuestionRecord> {
  const { sessionCode, text, displayName, askedBy, nowMs } = params;

  const allowed = await claimRateLimit({
    key: cooldownKey(sessionCode, askedBy, "ask"),
    nowMs,
    windowMs: params.cooldownMs ?? ASK_COOLDOWN_MS,
  });
  if (!allowed) {
    throw new RateLimited("asking too quickly");
  }

  const record: QuestionRecord = {
    entity: "question",
    questionId: params.questionId ?? randomUUID(),
    sessionCode,
    text,
    displayName,
    askedBy,
    upvotes: 0,
    state: "open",
    askedAt: nowMs,
    ttl: ttlFrom(nowMs, SESSION_TTL_SECONDS),
  };

  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { ...questionKey(sessionCode, record.questionId), ...record },
    })
  );
  return record;
}

export async function getQuestion(
  sessionCode: string,
  questionId: string
): Promise<QuestionRecord | undefined> {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLE(),
      Key: questionKey(sessionCode, questionId),
    })
  );
  return res.Item as QuestionRecord | undefined;
}

/** Every question in a session, unsorted — callers sort with sortQuestions. */
export async function listQuestions(
  sessionCode: string
): Promise<QuestionRecord[]> {
  const { PK, skPrefix } = questionQueryPrefix(sessionCode);
  const out: QuestionRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": PK, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
      })
    );
    out.push(...((res.Items ?? []) as QuestionRecord[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return out;
}

/**
 * Add one upvote and return the new total.
 *
 * Dedup is a conditional put of a per-voter row, exactly as for poll votes — a
 * read-then-check would let two rapid clicks both through. The counter update
 * returns the new value so we can broadcast without a follow-up read.
 *
 * If the process died between the two writes the upvoter would be recorded but
 * uncounted. That's the safe direction: an undercount is better than a count
 * that inflates on every retry.
 */
export async function upvoteQuestion(params: {
  sessionCode: string;
  questionId: string;
  voterId: string;
  nowMs: number;
}): Promise<number> {
  const { sessionCode, questionId, voterId, nowMs } = params;

  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          ...upvoteKey(questionId, voterId),
          entity: "upvote",
          questionId,
          voterId,
          upvotedAt: nowMs,
          ttl: ttlFrom(nowMs, SESSION_TTL_SECONDS),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new AlreadyUpvoted(`${voterId} already upvoted ${questionId}`);
    }
    throw err;
  }

  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: questionKey(sessionCode, questionId),
      // Top-level ADD, for the same reason as the poll tally: it creates the
      // attribute if absent instead of failing on a missing path.
      UpdateExpression: "ADD upvotes :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );

  const upvotes = (res.Attributes as { upvotes?: number } | undefined)?.upvotes;
  return typeof upvotes === "number" ? upvotes : 1;
}

/** Which of these questions has this voter already upvoted? */
export async function upvotedBy(
  questionIds: string[],
  voterId: string
): Promise<string[]> {
  if (questionIds.length === 0) return [];

  const found: string[] = [];
  // BatchGetItem caps at 100 keys per request.
  for (let i = 0; i < questionIds.length; i += 100) {
    const chunk = questionIds.slice(i, i + 100);
    const res = await doc.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE()]: {
            Keys: chunk.map((id) => upvoteKey(id, voterId)),
            ProjectionExpression: "questionId",
          },
        },
      })
    );
    for (const item of (res.Responses?.[TABLE()] ?? []) as Array<{
      questionId?: string;
    }>) {
      if (item.questionId) found.push(item.questionId);
    }
  }
  return found;
}

/**
 * Mark a question answered, hide it, or restore it.
 *
 * `attribute_exists` guards against moderating a question that's already gone,
 * which would otherwise silently create a half-populated item.
 */
export async function moderateQuestion(params: {
  sessionCode: string;
  questionId: string;
  action: ModerationAction;
}): Promise<QuestionState> {
  const { sessionCode, questionId, action } = params;
  const next = stateAfterModeration(action);

  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: questionKey(sessionCode, questionId),
      UpdateExpression: "SET #s = :next",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#s": "state" },
      ExpressionAttributeValues: { ":next": next },
    })
  );

  return next;
}
