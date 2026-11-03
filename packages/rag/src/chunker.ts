/**
 * Split extracted pages into overlapping, page-attributed chunks.
 *
 * Pure and deterministic: the same document always yields the same chunks in
 * the same order. That matters because vector keys are `<docId>#<ordinal>` — a
 * retried ingest has to overwrite the vectors it already wrote, not interleave
 * a second, different chunking of the same document.
 *
 * Sizes are in characters, using ~4 characters per token as the estimate. That
 * avoids shipping a tokenizer for a number that only has to be roughly right:
 * ~400-token chunks are small enough that one chunk is about one idea, and
 * large enough that a definition and its example usually land together.
 *
 * Splitting prefers the largest natural boundary that fits — paragraph, then
 * sentence, then word — so a chunk rarely ends mid-thought.
 */
import type { Chunk, ExtractedPage } from "./types";

export interface ChunkOptions {
  /** Stop adding units once a chunk reaches this length. */
  targetChars: number;
  /** Hard ceiling on a chunk's length, overlap included. */
  maxChars: number;
  /** Roughly how much of the previous chunk is repeated at the start of the next. */
  overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1600,
  maxChars: 2000,
  overlapChars: 200,
};

const PARAGRAPH = "\n\n";
const SENTENCE = " ";

/** A piece of text that is never split further. */
interface Unit {
  text: string;
  page: number;
  /** How this unit attaches to whatever precedes it in a chunk. */
  joiner: typeof PARAGRAPH | typeof SENTENCE;
}

export function chunkPages(
  pages: ExtractedPage[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  paged = true
): Chunk[] {
  const { targetChars, maxChars, overlapChars } = options;
  if (overlapChars < 0 || overlapChars >= targetChars || targetChars > maxChars) {
    throw new Error("chunk options must satisfy 0 <= overlap < target <= max");
  }

  // Cap units so that (overlap + joiner + one unit) always fits. This is the
  // invariant that makes "every chunk <= maxChars" hold unconditionally.
  const unitMax = maxChars - overlapChars - PARAGRAPH.length;
  const units = pages.flatMap((p) => splitToUnits(p.text, p.number, unitMax));

  const chunks: Chunk[] = [];
  let text = "";
  let fresh = 0; // units added since the last flush, i.e. not overlap
  let pageStart = 0;
  let pageEnd = 0;

  const flush = () => {
    chunks.push({
      ordinal: chunks.length,
      text,
      ...(paged ? { pageStart, pageEnd } : {}),
    });
    // Seed the next chunk with this one's tail, so a sentence straddling the
    // boundary is retrievable from either side. The overlap is attributed to
    // the page the previous chunk ended on.
    text = overlapTail(text, overlapChars);
    fresh = 0;
    pageStart = pageEnd;
  };

  for (const unit of units) {
    const joined = text ? text.length + unit.joiner.length : 0;
    if (fresh > 0 && (text.length >= targetChars || joined + unit.text.length > maxChars)) {
      flush();
    }
    if (!text) pageStart = unit.page;
    text = text ? `${text}${unit.joiner}${unit.text}` : unit.text;
    fresh++;
    pageEnd = unit.page;
  }

  // Never emit a chunk that is nothing but the previous chunk's overlap.
  if (fresh > 0) flush();

  return chunks;
}

/**
 * Break one page into units no longer than `max`: paragraphs if they fit,
 * otherwise sentences, otherwise word-boundary slices. Pieces of one paragraph
 * rejoin with a space, so prose reads as prose in a citation.
 */
function splitToUnits(text: string, page: number, max: number): Unit[] {
  const out: Unit[] = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (!para) continue;
    if (para.length <= max) {
      out.push({ text: para, page, joiner: PARAGRAPH });
      continue;
    }
    const pieces = splitSentences(para).flatMap((s) =>
      s.length <= max ? [s] : splitWords(s, max)
    );
    pieces.forEach((piece, i) =>
      out.push({ text: piece, page, joiner: i === 0 ? PARAGRAPH : SENTENCE })
    );
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'([]?[A-Z0-9])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitWords(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    // A single "word" longer than max (a URL, a hash) gets a hard cut.
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The last fewer-than-n characters of `text`, starting on a word boundary.
 * A chunk shorter than the overlap carries nothing forward — repeating a whole
 * chunk would only duplicate it.
 */
function overlapTail(text: string, n: number): string {
  if (n === 0 || text.length <= n) return "";
  const space = text.slice(text.length - n).search(/\s/);
  if (space < 0) return "";
  return text.slice(text.length - n + space).trim();
}
