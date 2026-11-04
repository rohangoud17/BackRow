/**
 * Turn a token stream into a few well-sized frames.
 *
 * One PostToConnection per token would be ~300 sequential calls for a short
 * answer, enough to fall behind the model. Tokens are buffered and flushed when
 * the buffer reaches `maxChars` or `intervalMs` has passed since the last
 * flush, whichever comes first. The check runs as each token arrives, so there
 * is no timer to leak.
 *
 * Before the first flush, at least `holdChars` are held back (or the whole
 * reply, if shorter) so the not-in-sources sentinel is recognised before any of
 * it reaches the student.
 */
import { NOT_IN_SOURCES } from "./prompt";

export interface StreamOptions {
  intervalMs: number;
  maxChars: number;
  holdChars: number;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  intervalMs: 120,
  maxChars: 512,
  holdChars: 24,
};

export type StreamOutcome =
  /** The model answered; `text` is everything emitted. */
  | { kind: "answered"; text: string; deltas: number }
  /** The model said the sources don't cover it. Nothing was emitted. */
  | { kind: "not_found"; deltas: 0 }
  /** The consumer stopped accepting frames (the asker went away). */
  | { kind: "abandoned"; text: string; deltas: number };

/**
 * @param tokens  the model's text, in pieces
 * @param emit    sends one frame; returns false to stop (connection gone)
 */
export async function coalesce(
  tokens: AsyncIterable<string>,
  emit: (text: string) => Promise<boolean>,
  now: () => number,
  opts: StreamOptions = DEFAULT_STREAM_OPTIONS
): Promise<StreamOutcome> {
  let buffer = "";
  let emitted = "";
  let deltas = 0;
  let lastFlush = now();
  let started = false;

  const flush = async (): Promise<boolean> => {
    if (!buffer) return true;
    const text = buffer;
    buffer = "";
    lastFlush = now();
    emitted += text;
    deltas++;
    return emit(text);
  };

  for await (const token of tokens) {
    buffer += token;

    if (!started) {
      const head = buffer.trimStart();
      if (head.length < opts.holdChars && NOT_IN_SOURCES.startsWith(head)) continue;
      if (head.startsWith(NOT_IN_SOURCES)) return { kind: "not_found", deltas: 0 };
      if (head.length < opts.holdChars) continue;
      started = true;
      buffer = head;
    }

    if (buffer.length >= opts.maxChars || now() - lastFlush >= opts.intervalMs) {
      if (!(await flush())) return { kind: "abandoned", text: emitted, deltas };
    }
  }

  if (!started) {
    const head = buffer.trim();
    if (!head || head.startsWith(NOT_IN_SOURCES)) return { kind: "not_found", deltas: 0 };
    buffer = head;
  }
  if (!(await flush())) return { kind: "abandoned", text: emitted, deltas };
  return { kind: "answered", text: emitted, deltas };
}
