/**
 * The only way the answer path writes to CloudWatch.
 *
 * Fields are an explicit allow-list of ids, numbers, enums and booleans. There
 * is no free-text field and no index signature, so passing a question, an
 * answer or a chunk is a type error, and a unit test checks the emitted lines
 * as well. Bedrock and SDK errors are reduced to their class name before they
 * get here, because their messages can echo the request.
 */
import type { AssistantOutcome } from "@backrow/shared";

export interface RagLogEvent {
  event:
    | "answer.skipped"
    | "answer.done"
    | "answer.failed"
    | "answer.abandoned";
  queryId: string;
  sessionCode?: string;
  courseId?: string;
  outcome?: AssistantOutcome;
  qLen?: number;
  topScore?: number;
  sourceCount?: number;
  deltas?: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
  ttftMs?: number;
  totalMs?: number;
  /** Error class name only, e.g. "ThrottlingException". */
  errorName?: string;
}

export function ragLog(e: RagLogEvent): void {
  const line = JSON.stringify(e);
  if (e.event === "answer.failed") console.warn(line);
  else console.log(line);
}

/**
 * Haiku 4.5 on-demand list price, USD per million tokens. An estimate for the
 * log only; billing is the source of truth.
 */
const INPUT_PER_M = 1.0;
const OUTPUT_PER_M = 5.0;

export const estimateCostUsd = (inputTokens: number, outputTokens: number): number =>
  Math.round(((inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1e6) * 1e6) / 1e6;
