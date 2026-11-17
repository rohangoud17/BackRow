/**
 * Answer one ask: check the cache, retrieve, decide whether the material covers
 * the question, stream the answer to the asker, record the outcome.
 *
 * Every frame goes to the asker's connection through a sink bound to it. The
 * frame sequence is always
 *
 *   assistantStart  -> assistantDelta x n  -> assistantDone
 *
 * whatever the outcome, cached or generated, so the client has one renderer.
 * `assistantStart` carries sources only when the answer is grounded in them.
 *
 * Order of work, cheapest first:
 *
 *   1. exact cache      one GetItem; no Bedrock call at all on a hit
 *   2. guardrail        optional input check (off by default)
 *   3. embed            Titan v2
 *   4. semantic cache + retrieval, in parallel
 *   5. score floor      nothing relevant -> canned reply, no model call
 *   6. generate         Haiku, streamed; a grounded answer is cached
 */
import type {
  AnswerInvokePayload,
  AskRecord,
  AssistantSource,
  CacheTier,
} from "@backrow/shared";
import type { Embedder } from "../embedder";
import type { CourseRecord } from "../types";
import type { AskRepository } from "./ask-repository";
import type { AnswerCache, CachedAnswer, CacheScope } from "./cache";
import type { Guardrail } from "./guardrail";
import type { LlmProvider } from "./llm";
import { ragLog, estimateCostUsd } from "./log";
import {
  SYSTEM_PROMPT,
  NOT_FOUND_TEXT,
  ERROR_TEXT,
  REFUSED_TEXT,
  selectChunks,
  toSources,
  buildUserMessage,
  parseCitations,
} from "./prompt";
import type { Retriever } from "./retriever";
import type { AnswerSink } from "./sink";
import { coalesce, DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./stream";

export interface AnswerConfig {
  /**
   * Chunks scoring below this never reach the model. Measured on dev with
   * Titan v2 at 512 dims (2026-11-04): on-topic questions scored 0.26-0.67,
   * unrelated ones 0.07-0.15, a related-but-uncovered CS question 0.22. 0.2
   * keeps the unrelated ones away from the model; the sentinel handles the
   * near misses. Re-check with `npm run eval:rag` when the corpus changes.
   */
  minScore: number;
  /** How many neighbours to fetch. */
  topK: number;
  /** How many of those may go into the prompt. */
  maxSources: number;
  maxTokens: number;
  temperature: number;
  stream: StreamOptions;
}

export const DEFAULT_ANSWER_CONFIG: AnswerConfig = {
  minScore: 0.2,
  // Chunks are ~450 characters, so eight is under 5,000 characters of context:
  // enough to cover an answer split across neighbouring chunks, and less than
  // half the prompt that six 1,600-character chunks used to be.
  topK: 8,
  maxSources: 8,
  maxTokens: 600,
  temperature: 0.2,
  stream: DEFAULT_STREAM_OPTIONS,
};

export interface AnswerDeps {
  asks: AskRepository;
  getCourse(orgId: string, courseId: string): Promise<CourseRecord | undefined>;
  embedder: Embedder;
  retriever: Retriever;
  llm: LlmProvider;
  cache: AnswerCache;
  guardrail: Guardrail;
  sinkFor(connectionId: string): AnswerSink;
  now(): number;
  config: AnswerConfig;
}

class CourseMissing extends Error {
  name = "CourseMissing";
}

type RecordedOutcome = NonNullable<AskRecord["outcome"]>;

export async function answerQuery(payload: AnswerInvokePayload, d: AnswerDeps): Promise<void> {
  const { sessionCode, queryId } = payload;
  const startedAt = d.now();

  const ask = await d.asks.claim(sessionCode, queryId, startedAt);
  if (!ask) {
    // Duplicate delivery, or a record that already expired.
    ragLog({ event: "answer.skipped", queryId, sessionCode });
    return;
  }

  const run = new AnswerRun(ask, d, startedAt);
  try {
    await run.execute();
  } catch (err) {
    await run.fail(err);
  }
}

/** State for one answer, so the success and failure paths share counters. */
class AnswerRun {
  private seq = 0;
  private started = false;
  /** The asker's socket closed. Frames stop; generation may still finish. */
  private gone = false;
  private topScore?: number;
  private sourceCount = 0;
  private inputTokens?: number;
  private outputTokens?: number;
  private ttftMs?: number;
  private cacheTier?: CacheTier;
  private questionHash?: string;
  private cacheVersion?: number;
  private readonly sink: AnswerSink;

  constructor(
    private readonly ask: AskRecord,
    private readonly d: AnswerDeps,
    private readonly startedAt: number
  ) {
    this.sink = d.sinkFor(ask.connectionId);
  }

  async execute(): Promise<void> {
    const { ask, d } = this;
    const cfg = d.config;

    const course = await d.getCourse(ask.orgId, ask.courseId);
    if (!course) throw new CourseMissing();
    const scope: CacheScope = {
      orgId: course.orgId,
      courseId: course.courseId,
      corpusVersion: course.corpusVersion,
    };

    // A cache failure must never cost the student their answer: every cache
    // call degrades to a miss, with the error class logged.
    const exact = await this.quietly("cache.exact", () => d.cache.getExact(scope, ask.text));
    if (exact) return this.replay(scope, exact, "exact");

    // After the exact tier on purpose: a cached question already passed.
    if ((await d.guardrail.check(ask.text)) === "block") {
      await this.cannedReply(REFUSED_TEXT, "refused");
      return;
    }

    const embedding = await d.embedder.embed(ask.text);
    const [similar, found] = await Promise.all([
      this.quietly("cache.semantic", () => d.cache.findSimilar(scope, embedding)),
      d.retriever.search(course.chunkIndex, embedding, cfg.topK),
    ]);
    if (similar) return this.replay(scope, similar, "semantic");
    this.cacheTier = "miss";

    if (found.length) this.topScore = round(Math.max(...found.map((c) => c.score)));
    const chunks = selectChunks(found, cfg.minScore, cfg.maxSources);
    if (chunks.length === 0) {
      // Hard grounding gate: nothing relevant, so no model call at all.
      await this.cannedReply(NOT_FOUND_TEXT, "not_found");
      return;
    }
    const sources = toSources(chunks);
    this.sourceCount = sources.length;

    const events = d.llm.stream({
      system: SYSTEM_PROMPT,
      user: buildUserMessage(ask.text, chunks),
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
    });
    const onUsage = (inputTokens: number, outputTokens: number) => {
      this.inputTokens = inputTokens;
      this.outputTokens = outputTokens;
    };
    const tokens = (async function* () {
      for await (const e of events) {
        if (e.type === "text") yield e.text;
        else onUsage(e.inputTokens, e.outputTokens);
      }
    })();

    const result = await coalesce(
      tokens,
      async (text) => {
        if (!this.started) {
          this.ttftMs = d.now() - this.startedAt;
          await this.start(sources, false);
        }
        await this.delta(text);
        // Always keep reading. If the asker has gone, the rest of the answer
        // costs a fraction of a cent and lands in the cache, so their retry
        // after reconnecting is instant.
        return true;
      },
      d.now,
      cfg.stream
    );

    if (result.kind === "not_found") {
      // Soft grounding gate: the model judged the sources insufficient.
      await this.cannedReply(NOT_FOUND_TEXT, "not_found");
      return;
    }

    const citations = parseCitations(result.text, sources.length);
    const stored = await this.quietly("cache.put", () =>
      d.cache.put(scope, ask.text, embedding, { answer: result.text, sources, citations }, d.now())
    );
    if (stored) {
      this.questionHash = stored;
      this.cacheVersion = scope.corpusVersion;
    }

    await this.done("answered", citations);
    await this.record(this.gone ? "abandoned" : "answered", this.gone ? "answer.abandoned" : "answer.done");
  }

  async fail(err: unknown): Promise<void> {
    const errorName = (err as Error)?.name ?? "Unknown";
    try {
      if (!this.started) {
        await this.cannedReply(ERROR_TEXT, "error", errorName);
        return;
      }
      // Part of an answer is already on screen; close it out rather than
      // appending an apology to half a sentence.
      await this.done("error", []);
      await this.record("error", "answer.failed", errorName);
    } catch (inner) {
      ragLog({
        event: "answer.failed",
        queryId: this.ask.queryId,
        sessionCode: this.ask.sessionCode,
        errorName: (inner as Error)?.name ?? errorName,
      });
    }
  }

  /** Serve a cached answer through the same frames as a generated one. */
  private async replay(scope: CacheScope, hit: CachedAnswer, tier: "exact" | "semantic"): Promise<void> {
    const { d } = this;
    this.cacheTier = tier;
    this.questionHash = hit.questionHash;
    this.cacheVersion = scope.corpusVersion;
    this.sourceCount = hit.sources.length;
    this.ttftMs = d.now() - this.startedAt;

    await this.start(hit.sources, true);
    const size = d.config.stream.maxChars;
    for (let i = 0; i < hit.answer.length; i += size) {
      await this.delta(hit.answer.slice(i, i + size));
    }
    await this.done("answered", hit.citations);
    await this.quietly("cache.hit", () => d.cache.recordHit(scope, hit.questionHash));
    await this.record(this.gone ? "abandoned" : "answered", this.gone ? "answer.abandoned" : "answer.done");
  }

  /** A fixed reply with no sources: start, one delta, done. */
  private async cannedReply(
    text: string,
    outcome: "not_found" | "error" | "refused",
    errorName?: string
  ): Promise<void> {
    await this.start([], false);
    await this.delta(text);
    await this.done(outcome, []);
    await this.record(outcome, outcome === "error" ? "answer.failed" : "answer.done", errorName);
  }

  // --- frames. Each is a no-op once the asker has gone. --------------------

  private async start(sources: AssistantSource[], cached: boolean): Promise<void> {
    this.started = true;
    await this.send({ type: "assistantStart", queryId: this.ask.queryId, sources, cached });
  }

  private async delta(text: string): Promise<void> {
    await this.send({
      type: "assistantDelta",
      queryId: this.ask.queryId,
      seq: this.seq++,
      text,
    });
  }

  private async done(
    outcome: "answered" | "not_found" | "error" | "refused",
    citations: number[]
  ): Promise<void> {
    await this.send({
      type: "assistantDone",
      queryId: this.ask.queryId,
      seq: this.seq,
      outcome,
      citations,
    });
  }

  private async send(message: Parameters<AnswerSink["send"]>[0]): Promise<void> {
    if (this.gone) return;
    if ((await this.sink.send(message)) === "gone") this.gone = true;
  }

  /** Run a cache call; on failure log the error class and carry on as a miss. */
  private async quietly<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      ragLog({
        event: "answer.cache_error",
        queryId: this.ask.queryId,
        sessionCode: this.ask.sessionCode,
        step,
        errorName: (err as Error)?.name ?? "Unknown",
      });
      return undefined;
    }
  }

  private async record(
    outcome: RecordedOutcome,
    event: "answer.done" | "answer.failed" | "answer.abandoned",
    errorName?: string
  ): Promise<void> {
    const { ask, d } = this;
    const finishedAt = d.now();
    try {
      await d.asks.finish({
        sessionCode: ask.sessionCode,
        queryId: ask.queryId,
        outcome,
        nowMs: finishedAt,
        topScore: this.topScore,
        sourceCount: this.sourceCount,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cacheTier: this.cacheTier,
        questionHash: this.questionHash,
        cacheVersion: this.cacheVersion,
      });
    } catch (err) {
      // The student already has their reply; a lost bookkeeping write must not
      // turn into a second, contradictory assistantDone.
      errorName ??= `record:${(err as Error)?.name ?? "Unknown"}`;
    }
    ragLog({
      event,
      queryId: ask.queryId,
      sessionCode: ask.sessionCode,
      courseId: ask.courseId,
      outcome: outcome === "abandoned" ? undefined : outcome,
      cacheTier: this.cacheTier,
      qLen: ask.text.length,
      topScore: this.topScore,
      sourceCount: this.sourceCount,
      deltas: this.seq,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estCostUsd:
        this.inputTokens !== undefined
          ? estimateCostUsd(this.inputTokens, this.outputTokens ?? 0)
          : undefined,
      ttftMs: this.ttftMs,
      totalMs: finishedAt - this.startedAt,
      errorName,
    });
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
