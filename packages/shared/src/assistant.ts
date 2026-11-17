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

/** Cached answers expire after 30 days, or sooner when the corpus changes. */
export const ANSWER_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * A topic is shown to the presenter only once asks from this many different
 * connections share it, so a single student's private question is never
 * surfaced on its own.
 */
export const MIN_TOPIC_ASKS = 2;

/** At most this many topics in one insights reply. */
export const MAX_INSIGHT_TOPICS = 10;

/**
 * Canonical form of a question for exact-match caching: lowercase, punctuation
 * dropped, whitespace collapsed. "What is DP?" and "what is dp" are one entry.
 * Callers hash the result; hashing needs Node's crypto, which this package
 * avoids so it can run in the browser too.
 */
export const normalizeQuestion = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Cached answers for one course at one corpus version.
 *
 * The version is in the partition key, so new or deleted material invalidates
 * every cached answer at once without deleting anything: lookups simply move
 * to a new, empty partition and the old one expires by TTL.
 */
export const answerCacheKey = (
  orgId: string,
  courseId: string,
  corpusVersion: number,
  questionHash: string
): TableKey => ({
  PK: `${coursePartition(orgId, courseId)}#ANS#V${corpusVersion}`,
  SK: `Q#${questionHash}`,
});

/** The per-course S3 Vectors index of cached question embeddings. */
export const questionCacheIndexName = (orgId: string, courseId: string): string =>
  `qcache-${orgId}-${courseId}`;

/** Key of one cached question's vector. Carries the version for cheap filtering by eye. */
export const questionVectorKey = (corpusVersion: number, questionHash: string): string =>
  `v${corpusVersion}#${questionHash}`;

/** How an ask was served. */
export type CacheTier = "exact" | "semantic" | "miss";

/**
 * One cached answer. Holds the first asker's wording of the question and no
 * identity of any kind: no session, connection or client id.
 */
export interface CachedAnswerRecord {
  entity: "answer";
  orgId: string;
  courseId: string;
  corpusVersion: number;
  questionHash: string;
  question: string;
  answer: string;
  sources: Array<{ n: number; docId: string; title: string; page?: number }>;
  citations: number[];
  /** Times served from cache, not counting the ask that created it. */
  hits: number;
  createdAt: number;
  ttl: number;
}

export type AskStatus = "pending" | "running" | "done";

/** How an ask ended. Mirrors `assistantDone.outcome`. */
export type AssistantOutcome = "answered" | "not_found" | "refused" | "error";

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
  /**
   * The cached answer this ask was served from or created, and the corpus
   * version it belongs to. Asks sharing both are one topic in the presenter's
   * insights. Absent when nothing was cached (not found, error).
   */
  cacheTier?: CacheTier;
  questionHash?: string;
  cacheVersion?: number;
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
