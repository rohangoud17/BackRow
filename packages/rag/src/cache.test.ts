/**
 * The production answer cache and the optional Bedrock guardrail, with
 * DynamoDB, S3 Vectors and Bedrock mocked.
 *
 * The cases that matter are the ones that would show a student the wrong
 * answer: a semantic match accepted below the threshold, an entry from an
 * older corpus version, or an expired row that DynamoDB hasn't deleted yet.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3VectorsClient,
  CreateIndexCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { BedrockRuntimeClient, ApplyGuardrailCommand } from "@aws-sdk/client-bedrock-runtime";
import { answerCacheKey, normalizeQuestion } from "@backrow/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);
const vectorsMock = mockClient(S3VectorsClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

import { DynamoS3AnswerCache, hashQuestion, type CacheScope } from "./assistant/cache";
import { BedrockGuardrail, guardrailFromEnv, noGuardrail } from "./assistant/guardrail";

const SCOPE: CacheScope = { orgId: "default", courseId: "course1", corpusVersion: 3 };
const QUESTION = "What does the knapsack table hold?";
const HASH = hashQuestion(QUESTION);
const EMBEDDING = new Array(512).fill(0.01);
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400;

const row = (over: Record<string, unknown> = {}) => ({
  entity: "answer",
  questionHash: HASH,
  corpusVersion: 3,
  question: QUESTION,
  answer: "K[i][w] holds the best value [1].",
  sources: [{ n: 1, docId: "d1", title: "lecture-04", page: 4 }],
  citations: [1],
  hits: 0,
  ttl: FAR_FUTURE,
  ...over,
});

const named = (name: string) => Object.assign(new Error(name), { name });

beforeAll(() => {
  process.env.TABLE_NAME = "backrow-test";
});

let cache: DynamoS3AnswerCache;
beforeEach(() => {
  ddbMock.reset();
  vectorsMock.reset();
  bedrockMock.reset();
  cache = new DynamoS3AnswerCache("vectors-test", 0.94);
});

describe("question normalization", () => {
  test("case, punctuation and spacing don't change the hash", () => {
    for (const variant of [
      "what does the knapsack table hold",
      "  What does the KNAPSACK table hold??  ",
      "What does   the knapsack\ttable hold?",
    ]) {
      expect(hashQuestion(variant)).toBe(HASH);
    }
  });

  test("different questions hash differently, including a negation", () => {
    expect(hashQuestion("What is a deadlock?")).not.toBe(hashQuestion("What is not a deadlock?"));
  });

  test("non-English letters and digits are kept", () => {
    expect(normalizeQuestion("¿Qué es O(n²)?")).toBe("qué es o n2");
    expect(normalizeQuestion("0/1 knapsack")).toBe("0 1 knapsack");
  });
});

describe("exact tier", () => {
  test("reads the entry for this course, version and question", async () => {
    ddbMock.on(GetCommand).resolves({ Item: row() });
    const hit = await cache.getExact(SCOPE, QUESTION);
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual(
      answerCacheKey("default", "course1", 3, HASH)
    );
    expect(hit).toEqual({
      questionHash: HASH,
      answer: "K[i][w] holds the best value [1].",
      sources: [{ n: 1, docId: "d1", title: "lecture-04", page: 4 }],
      citations: [1],
    });
  });

  test("the corpus version is part of the key, so new material means a miss", async () => {
    ddbMock.on(GetCommand).resolves({});
    await cache.getExact({ ...SCOPE, corpusVersion: 4 }, QUESTION);
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key!.PK).toBe(
      "ORG#default#COURSE#course1#ANS#V4"
    );
  });

  test("an expired row DynamoDB hasn't deleted yet is a miss", async () => {
    ddbMock.on(GetCommand).resolves({ Item: row({ ttl: Math.floor(Date.now() / 1000) - 10 }) });
    expect(await cache.getExact(SCOPE, QUESTION)).toBeUndefined();
  });
});

describe("semantic tier", () => {
  const match = (distance: number, key = `v3#${HASH}`) =>
    vectorsMock.on(QueryVectorsCommand).resolves({ vectors: [{ key, distance }] });

  test("accepts a match at or above the threshold and reads its entry", async () => {
    match(0.05);
    ddbMock.on(GetCommand).resolves({ Item: row() });
    const hit = await cache.findSimilar(SCOPE, EMBEDDING);
    expect(hit?.questionHash).toBe(HASH);
    expect(vectorsMock.commandCalls(QueryVectorsCommand)[0].args[0].input).toMatchObject({
      vectorBucketName: "vectors-test",
      indexName: "qcache-default-course1",
      topK: 1,
      filter: { corpusVersion: { $eq: 3 } },
    });
  });

  test("refuses a close-but-different question (0.895, the measured deadlock negation)", async () => {
    match(1 - 0.895);
    expect(await cache.findSimilar(SCOPE, EMBEDDING)).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("a course with no cached questions yet (no index) is a miss, not an error", async () => {
    vectorsMock.on(QueryVectorsCommand).rejects(named("NotFoundException"));
    expect(await cache.findSimilar(SCOPE, EMBEDDING)).toBeUndefined();
  });

  test("other failures surface, so the caller can log them", async () => {
    vectorsMock.on(QueryVectorsCommand).rejects(named("ThrottlingException"));
    await expect(cache.findSimilar(SCOPE, EMBEDDING)).rejects.toMatchObject({ name: "ThrottlingException" });
  });

  test("a vector from another corpus version is ignored even if returned", async () => {
    match(0.01, `v2#${HASH}`);
    expect(await cache.findSimilar(SCOPE, EMBEDDING)).toBeUndefined();
  });

  test("a vector whose row has expired is a miss", async () => {
    match(0.01);
    ddbMock.on(GetCommand).resolves({});
    expect(await cache.findSimilar(SCOPE, EMBEDDING)).toBeUndefined();
  });

  test("an empty index is a miss", async () => {
    vectorsMock.on(QueryVectorsCommand).resolves({ vectors: [] });
    expect(await cache.findSimilar(SCOPE, EMBEDDING)).toBeUndefined();
  });
});

describe("put", () => {
  const answer = { answer: "A [1].", sources: [{ n: 1, docId: "d1", title: "t" }], citations: [1] };

  test("stores the row with a 30-day TTL and no identity, then the question vector", async () => {
    const now = 1_800_000_000_000;
    const hash = await cache.put(SCOPE, QUESTION, EMBEDDING, answer, now);
    expect(hash).toBe(HASH);

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({
      ...answerCacheKey("default", "course1", 3, HASH),
      entity: "answer",
      question: QUESTION,
      answer: "A [1].",
      hits: 0,
      ttl: now / 1000 + 30 * 86400,
    });
    for (const identity of ["connectionId", "clientId", "sessionCode", "queryId"]) {
      expect(item).not.toHaveProperty(identity);
    }

    expect(vectorsMock.commandCalls(PutVectorsCommand)[0].args[0].input).toMatchObject({
      indexName: "qcache-default-course1",
      vectors: [{ key: `v3#${HASH}`, metadata: { corpusVersion: 3 } }],
    });
  });

  test("creates the question index once per container, tolerating one that exists", async () => {
    vectorsMock.on(CreateIndexCommand).rejects(named("ConflictException"));
    await cache.put(SCOPE, QUESTION, EMBEDDING, answer, 1);
    await cache.put(SCOPE, "another question", EMBEDDING, answer, 1);
    expect(vectorsMock.commandCalls(CreateIndexCommand)).toHaveLength(1);
    expect(vectorsMock.commandCalls(CreateIndexCommand)[0].args[0].input).toMatchObject({
      indexName: "qcache-default-course1",
      dimension: 512,
      distanceMetric: "cosine",
    });
    expect(vectorsMock.commandCalls(PutVectorsCommand)).toHaveLength(2);
  });
});

describe("recordHit", () => {
  test("increments hits only if the entry still exists", async () => {
    await cache.recordHit(SCOPE, HASH);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: answerCacheKey("default", "course1", 3, HASH),
      UpdateExpression: "ADD hits :one",
      ConditionExpression: "attribute_exists(PK)",
    });
  });

  test("an entry that expired meanwhile is not resurrected and not an error", async () => {
    ddbMock.on(UpdateCommand).rejects(named("ConditionalCheckFailedException"));
    await expect(cache.recordHit(SCOPE, HASH)).resolves.toBeUndefined();
  });
});

describe("guardrail", () => {
  test("none by default", async () => {
    expect(guardrailFromEnv({})).toBe(noGuardrail);
    expect(await noGuardrail.check("anything")).toBe("allow");
  });

  test("configured from the environment", () => {
    expect(guardrailFromEnv({ ASSISTANT_GUARDRAIL_ID: "gr-1", ASSISTANT_GUARDRAIL_VERSION: "2" })).toBeInstanceOf(
      BedrockGuardrail
    );
  });

  test("checks the question as INPUT and maps the verdict", async () => {
    const guardrail = new BedrockGuardrail("gr-1", "2");
    bedrockMock.on(ApplyGuardrailCommand).resolves({ action: "NONE" } as never);
    expect(await guardrail.check(QUESTION)).toBe("allow");
    expect(bedrockMock.commandCalls(ApplyGuardrailCommand)[0].args[0].input).toMatchObject({
      guardrailIdentifier: "gr-1",
      guardrailVersion: "2",
      source: "INPUT",
      content: [{ text: { text: QUESTION } }],
    });

    bedrockMock.on(ApplyGuardrailCommand).resolves({ action: "GUARDRAIL_INTERVENED" } as never);
    expect(await guardrail.check(QUESTION)).toBe("block");
  });

  test("an error propagates, so the caller fails closed", async () => {
    bedrockMock.on(ApplyGuardrailCommand).rejects(named("ThrottlingException"));
    await expect(new BedrockGuardrail("gr-1", "2").check(QUESTION)).rejects.toMatchObject({
      name: "ThrottlingException",
    });
  });
});
