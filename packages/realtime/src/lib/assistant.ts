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
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  askKey,
  assistantBudgetKey,
  utcDay,
  ttlFrom,
  generateId,
  ASK_TTL_SECONDS,
  DEFAULT_ASSISTANT_DAILY_LIMIT,
  type AskRecord,
  type AnswerInvokePayload,
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
