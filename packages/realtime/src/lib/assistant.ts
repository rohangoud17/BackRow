/**
 * The message Lambda's half of the course assistant: admit the question, record
 * it, and hand it to the answer Lambda.
 *
 * Generation never runs here. It takes seconds, API Gateway gives a WebSocket
 * integration 29, and a throttled synchronous invoke from API Gateway is simply
 * dropped. An async invoke is queued by Lambda instead, so a burst of questions
 * waits rather than vanishes, and this handler returns in milliseconds.
 */
import { randomBytes } from "node:crypto";
import {
  PutCommand,
  UpdateCommand,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  askKey,
  answerCacheKey,
  assistantBudgetKey,
  ASK_PREFIX,
  MIN_TOPIC_ASKS,
  MAX_INSIGHT_TOPICS,
  utcDay,
  ttlFrom,
  generateId,
  ASK_TTL_SECONDS,
  DEFAULT_ASSISTANT_DAILY_LIMIT,
  type AskRecord,
  type AnswerInvokePayload,
  type AssistantInsightsMessage,
  type CachedAnswerRecord,
} from "@backrow/shared";
import { doc, TABLE, isConditionalCheckFailed } from "./ddb";

let lambda: LambdaClient | undefined;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/** Budget rows outlive their day by one, then expire. */
const BUDGET_TTL_SECONDS = 2 * 24 * 60 * 60;

export const dailyLimit = (): number => {
  const raw = Number(process.env.ASSISTANT_DAILY_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ASSISTANT_DAILY_LIMIT;
};

/**
 * Take one ask from the course's allowance for today.
 *
 * The cap is in the condition expression, so a lecture hall asking at once
 * can't overshoot it. This is the cost ceiling: at roughly half a cent per
 * answer, the default of 200 bounds a course at about $1 a day.
 */
export async function claimAssistantBudget(params: {
  orgId: string;
  courseId: string;
  nowMs: number;
  limit: number;
}): Promise<boolean> {
  const { orgId, courseId, nowMs, limit } = params;
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: assistantBudgetKey(orgId, courseId, utcDay(nowMs)),
        UpdateExpression: "ADD #n :one SET entity = :e, #t = :ttl",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
        ExpressionAttributeNames: { "#n": "asked", "#t": "ttl" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":limit": limit,
          ":e": "budget",
          ":ttl": ttlFrom(nowMs, BUDGET_TTL_SECONDS),
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** Write the pending ask. The only place question text is stored. */
export async function recordAsk(params: {
  sessionCode: string;
  orgId: string;
  courseId: string;
  connectionId: string;
  text: string;
  nowMs: number;
}): Promise<AskRecord> {
  const record: AskRecord = {
    entity: "ask",
    queryId: generateId((n) => new Uint8Array(randomBytes(n))),
    sessionCode: params.sessionCode,
    orgId: params.orgId,
    courseId: params.courseId,
    connectionId: params.connectionId,
    text: params.text,
    status: "pending",
    askedAt: params.nowMs,
    ttl: ttlFrom(params.nowMs, ASK_TTL_SECONDS),
  };
  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { ...askKey(record.sessionCode, record.queryId), ...record },
    })
  );
  return record;
}

/**
 * Hand the ask to the answer Lambda. `Event` invocation returns once Lambda
 * has queued it; the payload is ids only, so no student text sits in Lambda's
 * internal queue or the failure queue.
 */
export async function invokeAnswer(payload: AnswerInvokePayload): Promise<void> {
  const functionName = process.env.ANSWER_FUNCTION_NAME;
  if (!functionName) throw new Error("ANSWER_FUNCTION_NAME env var is not set");
  await lambdaClient().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

/** Upper bound on asks read for one insights request (~3 pages). */
const MAX_INSIGHT_ASKS = 3000;

type Insights = Omit<AssistantInsightsMessage, "type" | "requestId">;

/**
 * Aggregate what a session has asked the assistant, for its presenter.
 *
 * The projection leaves out question text, so no individual question can reach
 * the presenter through this path even by mistake. The connection id is read
 * only to count distinct askers and is never returned.
 *
 * Topics are asks that were answered by the same cached answer. A topic is
 * returned only when asks from at least `MIN_TOPIC_ASKS` different connections
 * share it, so one student repeating a question doesn't surface it. (A student
 * who reconnects gets a new connection id and can count twice; a stable id is
 * deliberately not stored on asks.) The label is the cached entry's wording.
 */
export async function readAssistantInsights(params: {
  sessionCode: string;
  orgId: string;
  courseId: string;
}): Promise<Insights> {
  const { sessionCode, orgId, courseId } = params;
  const totals = { asked: 0, answered: 0, notFound: 0, failed: 0, inProgress: 0 };
  const byTopic = new Map<
    string,
    { version: number; hash: string; count: number; askers: Set<string> }
  >();

  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `${ASK_PREFIX}${sessionCode}` },
        ProjectionExpression: "#s, outcome, questionHash, cacheVersion, connectionId",
        ExpressionAttributeNames: { "#s": "status" },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of (page.Items ?? []) as Partial<AskRecord>[]) {
      totals.asked++;
      if (item.status !== "done") totals.inProgress++;
      else if (item.outcome === "answered") totals.answered++;
      else if (item.outcome === "not_found") totals.notFound++;
      else totals.failed++;

      // Any ask tied to a cached answer counts toward its topic, including one
      // whose asker disconnected before the answer finished.
      if (item.questionHash && item.cacheVersion !== undefined) {
        const id = `${item.cacheVersion}#${item.questionHash}`;
        const topic = byTopic.get(id) ?? {
          version: item.cacheVersion,
          hash: item.questionHash,
          count: 0,
          askers: new Set<string>(),
        };
        topic.count++;
        if (item.connectionId) topic.askers.add(item.connectionId);
        byTopic.set(id, topic);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey && totals.asked < MAX_INSIGHT_ASKS);

  const top = [...byTopic.values()]
    .filter((t) => t.askers.size >= MIN_TOPIC_ASKS)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_INSIGHT_TOPICS);
  if (top.length === 0) return { sessionCode, ...totals, topics: [] };

  // One batch read for the wording of each topic. At most MAX_INSIGHT_TOPICS keys.
  const keys = top.map((t) => answerCacheKey(orgId, courseId, t.version, t.hash));
  const res = await doc.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLE()]: { Keys: keys, ProjectionExpression: "questionHash, corpusVersion, question" },
      },
    })
  );
  const wording = new Map<string, string>();
  for (const item of (res.Responses?.[TABLE()] ?? []) as Partial<CachedAnswerRecord>[]) {
    if (item.question) wording.set(`${item.corpusVersion}#${item.questionHash}`, item.question);
  }

  return {
    sessionCode,
    ...totals,
    // A topic whose cached entry has expired has no wording left to show.
    topics: top.flatMap((t) => {
      const question = wording.get(`${t.version}#${t.hash}`);
      return question ? [{ question, count: t.count }] : [];
    }),
  };
}
