/**
 * Answer Lambda. No API route: the message Lambda invokes it asynchronously
 * with `{sessionCode, queryId}` and nothing else.
 *
 * Configured with zero automatic retries (a retry would stream a second copy
 * of the answer) and a short maximum event age (an answer that arrives a
 * minute late is useless). Reserved concurrency caps how many answers run at
 * once, so a lecture hall asking together queues instead of starving the
 * realtime handlers or running up Bedrock spend.
 *
 * Config comes from environment variables only. SSM stays off this path.
 */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { answerInvokePayloadSchema } from "@backrow/shared";
import { TitanEmbedder } from "../embedder";
import { getCourse } from "../doc-repository";
import { dynamoAskRepository } from "../assistant/ask-repository";
import { S3VectorsRetriever } from "../assistant/retriever";
import { BedrockConverseLlm, DEFAULT_ANSWER_MODEL_ID } from "../assistant/llm";
import { WebSocketSink } from "../assistant/sink";
import { DynamoS3AnswerCache, DEFAULT_SEMANTIC_THRESHOLD } from "../assistant/cache";
import { guardrailFromEnv } from "../assistant/guardrail";
import { answerQuery, DEFAULT_ANSWER_CONFIG, type AnswerDeps } from "../assistant/answer";

let deps: AnswerDeps | undefined;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

/** A numeric env var, or the fallback when it is unset or not a number. */
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

const defaultDeps = (): AnswerDeps =>
  (deps ??= {
    asks: dynamoAskRepository,
    getCourse,
    // Interactive path: a couple of quick retries, not ingest's patient eight.
    embedder: new TitanEmbedder(new BedrockRuntimeClient({ maxAttempts: 3 })),
    retriever: new S3VectorsRetriever(required("VECTOR_BUCKET")),
    llm: new BedrockConverseLlm(process.env.ANSWER_MODEL_ID || DEFAULT_ANSWER_MODEL_ID),
    cache: new DynamoS3AnswerCache(
      required("VECTOR_BUCKET"),
      num("ASSISTANT_CACHE_THRESHOLD", DEFAULT_SEMANTIC_THRESHOLD)
    ),
    guardrail: guardrailFromEnv(),
    sinkFor: (connectionId) => new WebSocketSink(required("WS_ENDPOINT"), connectionId),
    now: () => Date.now(),
    config: {
      ...DEFAULT_ANSWER_CONFIG,
      minScore: num("ASSISTANT_MIN_SCORE", DEFAULT_ANSWER_CONFIG.minScore),
      topK: num("ASSISTANT_TOP_K", DEFAULT_ANSWER_CONFIG.topK),
    },
  });

export async function handler(event: unknown): Promise<void> {
  const parsed = answerInvokePayloadSchema.safeParse(event);
  if (!parsed.success) {
    console.warn("ignoring malformed answer invoke");
    return;
  }
  await answerQuery(parsed.data, defaultDeps());
}
