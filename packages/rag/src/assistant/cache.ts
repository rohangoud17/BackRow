/**
 * The answer cache, behind an interface: DynamoDB plus a per-course S3 Vectors
 * index in production, a Map in tests.
 *
 * Two tiers, cheapest first:
 *
 *   exact     normalize the question, hash it, one GetItem. ~10 ms, and it runs
 *             before the embedding call, so a repeat costs no Bedrock at all.
 *   semantic  nearest cached question by embedding, accepted only above a
 *             strict similarity threshold.
 *
 * Invalidation is by version, never by delete: entries are keyed on the
 * course's `corpusVersion`, which ingest and delete both bump. Old entries stop
 * matching and expire by TTL.
 *
 * A wrong semantic hit shows a student the answer to a different question, so
 * the threshold is deliberately high. Measured with Titan v2 at 512 dims
 * (2026-11-16): rewordings of one question scored 0.68-0.98, and the closest
 * pair of *different* questions ("What is a deadlock?" / "What is not a
 * deadlock?") scored 0.895. At 0.94 that pair is refused; the price is that
 * looser rewordings miss and are generated again.
 */
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3VectorsClient,
  CreateIndexCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import {
  answerCacheKey,
  normalizeQuestion,
  questionCacheIndexName,
  questionVectorKey,
  ttlFrom,
  ANSWER_CACHE_TTL_SECONDS,
  type AssistantSource,
  type CachedAnswerRecord,
} from "@backrow/shared";
import { doc, TABLE } from "../doc-repository";
import { EMBEDDING_DIMENSIONS } from "../embedder";

export const DEFAULT_SEMANTIC_THRESHOLD = 0.94;

/** The course fields the cache keys on. */
export interface CacheScope {
  orgId: string;
  courseId: string;
  corpusVersion: number;
}

export interface CachedAnswer {
  questionHash: string;
  answer: string;
  sources: AssistantSource[];
  citations: number[];
}

export interface AnswerCache {
  /** Hash of the normalized question; the cache entry's identity. */
  hash(question: string): string;
  getExact(scope: CacheScope, question: string): Promise<CachedAnswer | undefined>;
  findSimilar(scope: CacheScope, embedding: number[]): Promise<CachedAnswer | undefined>;
  put(
    scope: CacheScope,
    question: string,
    embedding: number[],
    answer: Omit<CachedAnswer, "questionHash">,
    nowMs: number
  ): Promise<string>;
  recordHit(scope: CacheScope, questionHash: string): Promise<void>;
}

export const hashQuestion = (question: string): string =>
  createHash("sha256").update(normalizeQuestion(question), "utf8").digest("hex");

const errorName = (err: unknown) => (err as { name?: string })?.name;

export class DynamoS3AnswerCache implements AnswerCache {
  /** Indexes this container has already created or found, to skip the call. */
  private readonly ensured = new Set<string>();

  constructor(
    private readonly vectorBucketName: string,
    private readonly threshold = DEFAULT_SEMANTIC_THRESHOLD,
    private readonly vectors = new S3VectorsClient({ maxAttempts: 3 })
  ) {}

  hash = hashQuestion;

  async getExact(scope: CacheScope, question: string): Promise<CachedAnswer | undefined> {
    return this.read(scope, hashQuestion(question));
  }

  async findSimilar(scope: CacheScope, embedding: number[]): Promise<CachedAnswer | undefined> {
    let top: { key?: string; distance?: number } | undefined;
    try {
      const res = await this.vectors.send(
        new QueryVectorsCommand({
          vectorBucketName: this.vectorBucketName,
          indexName: questionCacheIndexName(scope.orgId, scope.courseId),
          queryVector: { float32: embedding },
          topK: 1,
          returnDistance: true,
          // Only questions cached against the current material.
          filter: { corpusVersion: { $eq: scope.corpusVersion } },
        })
      );
      top = res.vectors?.[0];
    } catch (err) {
      // No question has been cached for this course yet.
      if (errorName(err) === "NotFoundException") return undefined;
      throw err;
    }
    if (!top?.key || 1 - (top.distance ?? 1) < this.threshold) return undefined;

    const prefix = questionVectorKey(scope.corpusVersion, "");
    if (!top.key.startsWith(prefix)) return undefined;
    // The row can be gone (TTL) while its vector lingers; that is just a miss.
    return this.read(scope, top.key.slice(prefix.length));
  }

  async put(
    scope: CacheScope,
    question: string,
    embedding: number[],
    answer: Omit<CachedAnswer, "questionHash">,
    nowMs: number
  ): Promise<string> {
    const questionHash = hashQuestion(question);
    const record: CachedAnswerRecord = {
      entity: "answer",
      orgId: scope.orgId,
      courseId: scope.courseId,
      corpusVersion: scope.corpusVersion,
      questionHash,
      question,
      answer: answer.answer,
      sources: answer.sources,
      citations: answer.citations,
      hits: 0,
      createdAt: nowMs,
      ttl: ttlFrom(nowMs, ANSWER_CACHE_TTL_SECONDS),
    };
    // Two students asking the same new question at once both generate and both
    // write; the answers are equally valid, so last write wins and no lock is
    // worth its cost here.
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          ...answerCacheKey(scope.orgId, scope.courseId, scope.corpusVersion, questionHash),
          ...record,
        },
      })
    );

    const indexName = questionCacheIndexName(scope.orgId, scope.courseId);
    await this.ensureIndex(indexName);
    await this.vectors.send(
      new PutVectorsCommand({
        vectorBucketName: this.vectorBucketName,
        indexName,
        vectors: [
          {
            key: questionVectorKey(scope.corpusVersion, questionHash),
            data: { float32: embedding },
            metadata: { corpusVersion: scope.corpusVersion },
          },
        ],
      })
    );
    return questionHash;
  }

  async recordHit(scope: CacheScope, questionHash: string): Promise<void> {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: TABLE(),
          Key: answerCacheKey(scope.orgId, scope.courseId, scope.corpusVersion, questionHash),
          UpdateExpression: "ADD hits :one",
          // Never resurrect an entry that expired between the read and this write.
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":one": 1 },
        })
      );
    } catch (err) {
      if (errorName(err) !== "ConditionalCheckFailedException") throw err;
    }
  }

  private async read(scope: CacheScope, questionHash: string): Promise<CachedAnswer | undefined> {
    const res = await doc.send(
      new GetCommand({
        TableName: TABLE(),
        Key: answerCacheKey(scope.orgId, scope.courseId, scope.corpusVersion, questionHash),
      })
    );
    const item = res.Item as CachedAnswerRecord | undefined;
    if (!item) return undefined;
    // DynamoDB deletes expired items lazily, sometimes days late.
    if (item.ttl * 1000 < Date.now()) return undefined;
    return {
      questionHash,
      answer: item.answer,
      sources: item.sources,
      citations: item.citations,
    };
  }

  /** The question index is created on a course's first cached answer. */
  private async ensureIndex(indexName: string): Promise<void> {
    if (this.ensured.has(indexName)) return;
    try {
      await this.vectors.send(
        new CreateIndexCommand({
          vectorBucketName: this.vectorBucketName,
          indexName,
          dataType: "float32",
          dimension: EMBEDDING_DIMENSIONS,
          distanceMetric: "cosine",
        })
      );
    } catch (err) {
      if (errorName(err) !== "ConflictException") throw err;
    }
    this.ensured.add(indexName);
  }
}
