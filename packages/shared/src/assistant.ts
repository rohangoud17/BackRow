/**
 * Phase 3.2 — the course assistant's shared contract: limits, table keys, the
 * ask record both Lambdas read and write, and the async hand-off payload.
 *
 *   audience ──askAssistant──▶ $default (message Lambda)
 *                                 checks, writes the ask record, invokes answer
 *                                 async with ids only, replies assistantAccepted
 *   answer Lambda ──assistantStart / Delta / Done──▶ the asker's connection only
 *
 * Student text lives in exactly one place: the ask record, in DynamoDB, with a
 * TTL. It is never in the async payload, the failure queue or a log line.
 */
import { z } from "zod";
import type { TableKey } from "./keys";
import { coursePartition } from "./course";

/** Longest question the assistant accepts. Bounds prompt size and cost. */
export const MAX_ASSISTANT_QUESTION = 500;

/** One ask per client per window. Generation is the expensive path. */
export const ASSIST_COOLDOWN_MS = 10_000;

/** Ask records (which hold question text) expire after 30 days. */
export const ASK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Default cap on answered-or-attempted asks per course per UTC day. */
export const DEFAULT_ASSISTANT_DAILY_LIMIT = 200;

export const ASK_PREFIX = "ASK#";

/**
 * One question to the assistant.
 *
 * Its own partition per session, outside `SESSION#<code>`, so assistant writes
 * stay off the partition fan-out reads membership from (the same reasoning as
 * reactions). The sort key is the query id alone so the answer Lambda can fetch
 * the record from the two ids it is handed.
 */
export const askKey = (sessionCode: string, queryId: string): TableKey => ({
  PK: `${ASK_PREFIX}${sessionCode}`,
  SK: `Q#${queryId}`,
});

/** Calendar day in UTC, `yyyy-mm-dd`. The budget resets at midnight UTC. */
export const utcDay = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

/**
 * The per-course daily ask counter. Day-scoped keys mean no reset job: tomorrow
 * is simply a different item, and yesterday's expires by TTL.
 */
export const assistantBudgetKey = (
  orgId: string,
  courseId: string,
  day: string
): TableKey => ({
  PK: `${coursePartition(orgId, courseId)}#BUDGET#${day}`,
  SK: "COUNT",
});

export type AskStatus = "pending" | "running" | "done";

/** How an ask ended. Mirrors `assistantDone.outcome`. */
export type AssistantOutcome = "answered" | "not_found" | "error";

/**
 * The ask record.
 *
 * Deliberately has no `clientId`: that id is stable across sessions, so storing
 * it here would link one student's questions over a whole term. `connectionId`
 * is per-socket and is what the answer is delivered to.
 */
export interface AskRecord {
  entity: "ask";
  queryId: string;
  sessionCode: string;
  orgId: string;
  courseId: string;
  connectionId: string;
  text: string;
  status: AskStatus;
  askedAt: number;
  ttl: number;
  startedAt?: number;
  /** `abandoned`: the asker disconnected mid-answer and generation was stopped. */
  outcome?: AssistantOutcome | "abandoned";
  finishedAt?: number;
  /** Retrieval and usage figures for tuning. Numbers only. */
  topScore?: number;
  sourceCount?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * What the message Lambda hands the answer Lambda. Ids only, validated on
 * arrival because the answer Lambda trusts nothing it didn't read itself.
 */
export const answerInvokePayloadSchema = z.object({
  sessionCode: z.string().min(1).max(16),
  queryId: z.string().min(1).max(64),
});
export type AnswerInvokePayload = z.infer<typeof answerInvokePayloadSchema>;
