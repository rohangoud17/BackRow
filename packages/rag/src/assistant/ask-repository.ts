/**
 * The answer Lambda's reads and writes of the ask record.
 *
 * `claimAsk` is a conditional pending -> running transition, so a duplicate
 * delivery of the same invoke finds nothing to claim and streams nothing. The
 * function has no automatic retries, so there is no takeover of a stale claim:
 * a crashed answer stays `running` until the record's TTL removes it.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { askKey, type AskRecord, type CacheTier } from "@backrow/shared";
import { doc, TABLE } from "../doc-repository";

const isConditionFailed = (err: unknown) =>
  (err as { name?: string })?.name === "ConditionalCheckFailedException";

export interface AskRepository {
  claim(sessionCode: string, queryId: string, nowMs: number): Promise<AskRecord | undefined>;
  finish(params: {
    sessionCode: string;
    queryId: string;
    outcome: NonNullable<AskRecord["outcome"]>;
    nowMs: number;
    topScore?: number;
    sourceCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheTier?: CacheTier;
    questionHash?: string;
    cacheVersion?: number;
  }): Promise<void>;
}

export const dynamoAskRepository: AskRepository = {
  async claim(sessionCode, queryId, nowMs) {
    try {
      const res = await doc.send(
        new UpdateCommand({
          TableName: TABLE(),
          Key: askKey(sessionCode, queryId),
          UpdateExpression: "SET #s = :running, startedAt = :now",
          ConditionExpression: "#s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":now": nowMs },
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes as AskRecord;
    } catch (err) {
      if (isConditionFailed(err)) return undefined;
      throw err;
    }
  },

  async finish(p) {
    const metrics: Record<string, number | string> = {};
    for (const k of [
      "topScore",
      "sourceCount",
      "inputTokens",
      "outputTokens",
      "cacheTier",
      "questionHash",
      "cacheVersion",
    ] as const) {
      const v = p[k];
      if (v !== undefined) metrics[k] = v;
    }
    const sets = ["#s = :done", "outcome = :o", "finishedAt = :now"];
    const values: Record<string, unknown> = {
      ":done": "done",
      ":running": "running",
      ":o": p.outcome,
      ":now": p.nowMs,
    };
    for (const [k, v] of Object.entries(metrics)) {
      sets.push(`${k} = :${k}`);
      values[`:${k}`] = v;
    }
    try {
      await doc.send(
        new UpdateCommand({
          TableName: TABLE(),
          Key: askKey(p.sessionCode, p.queryId),
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "#s = :running",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: values,
        })
      );
    } catch (err) {
      // Already finished, or expired. The student has their answer either way.
      if (!isConditionFailed(err)) throw err;
    }
  },
};
