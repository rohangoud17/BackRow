/**
 * Answer one ask: retrieve, decide whether the material covers it, stream the
 * answer to the asker, record the outcome.
 *
 * Every frame goes to the asker's connection through a sink bound to it. The
 * frame sequence is always
 *
 *   assistantStart  -> assistantDelta x n  -> assistantDone
 *
 * whatever the outcome, so the client has one renderer. `assistantStart`
 * carries sources only when the answer is grounded in them.
 */
import type { AnswerInvokePayload, AskRecord } from "@backrow/shared";
import type { Embedder } from "../embedder";
import type { CourseRecord } from "../types";
import type { AskRepository } from "./ask-repository";
import type { LlmProvider } from "./llm";
import { ragLog, estimateCostUsd } from "./log";
import {
  SYSTEM_PROMPT,
  NOT_FOUND_TEXT,
  ERROR_TEXT,
  selectChunks,
  toSources,
  buildUserMessage,
  parseCitations,
} from "./prompt";
import type { Retriever } from "./retriever";
import type { AnswerSink } from "./sink";
import { coalesce, DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./stream";

export interface AnswerConfig {
  /** Chunks scoring below this never reach the model. Tuned with the eval set. */
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
  minScore: 0.3,
  topK: 6,
  maxSources: 6,
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
  sinkFor(connectionId: string): AnswerSink;
  now(): number;
  config: AnswerConfig;
}

class CourseMissing extends Error {
  name = "CourseMissing";
}

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
  private topScore?: number;
  private sourceCount = 0;
  private inputTokens?: number;
  private outputTokens?: number;
  private ttftMs?: number;
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

    const embedding = await d.embedder.embed(ask.text);
    const found = await d.retriever.search(course.chunkIndex, embedding, cfg.topK);
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
          this.started = true;
          this.ttftMs = d.now() - this.startedAt;
          if ((await this.sink.send({ type: "assistantStart", queryId: ask.queryId, sources })) === "gone") {
            return false;
          }
        }
        return (await this.delta(text)) !== "gone";
      },
      d.now,
      cfg.stream
    );

    if (result.kind === "not_found") {
      // Soft grounding gate: the model judged the sources insufficient.
      await this.cannedReply(NOT_FOUND_TEXT, "not_found");
      return;
    }
    if (result.kind === "abandoned") {
      await this.record("abandoned", "answer.abandoned");
      return;
    }

    await this.sink.send({
      type: "assistantDone",
      queryId: ask.queryId,
      seq: this.seq,
      outcome: "answered",
      citations: parseCitations(result.text, sources.length),
    });
    await this.record("answered", "answer.done");
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
      await this.sink.send({
        type: "assistantDone",
        queryId: this.ask.queryId,
        seq: this.seq,
        outcome: "error",
        citations: [],
      });
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

  /** A fixed reply with no sources: start, one delta, done. */
  private async cannedReply(
    text: string,
    outcome: "not_found" | "error",
    errorName?: string
  ): Promise<void> {
    const { ask } = this;
    this.started = true;
    await this.sink.send({ type: "assistantStart", queryId: ask.queryId, sources: [] });
    await this.delta(text);
    await this.sink.send({
      type: "assistantDone",
      queryId: ask.queryId,
      seq: this.seq,
      outcome,
      citations: [],
    });
    await this.record(outcome, outcome === "error" ? "answer.failed" : "answer.done", errorName);
  }

  private delta(text: string) {
    return this.sink.send({
      type: "assistantDelta",
      queryId: this.ask.queryId,
      seq: this.seq++,
      text,
    });
  }

  private async record(
    outcome: "answered" | "not_found" | "error" | "abandoned",
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
