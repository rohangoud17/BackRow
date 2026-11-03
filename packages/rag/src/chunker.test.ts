import { chunkPages, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "./chunker";
import type { ExtractedPage } from "./types";

/** Deterministic prose: numbered sentences so overlap and order are checkable. */
const prose = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `Sentence number ${from + i} explains one more property of the system.`
  ).join(" ");

const pages = (...texts: string[]): ExtractedPage[] =>
  texts.map((text, i) => ({ number: i + 1, text }));

describe("chunkPages", () => {
  test("a short document is one chunk with its page span", () => {
    const chunks = chunkPages(pages("Deadlock needs four conditions."));
    expect(chunks).toEqual([
      { ordinal: 0, text: "Deadlock needs four conditions.", pageStart: 1, pageEnd: 1 },
    ]);
  });

  test("never exceeds maxChars, including overlap", () => {
    const doc = pages(prose(0, 200), prose(200, 5), "x".repeat(5000), prose(300, 80));
    const chunks = chunkPages(doc);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
      expect(c.text.trim()).not.toBe("");
    }
  });

  test("holds the bound for any option set that satisfies the invariant", () => {
    const options: ChunkOptions[] = [
      { targetChars: 300, maxChars: 400, overlapChars: 50 },
      { targetChars: 100, maxChars: 100, overlapChars: 0 },
      { targetChars: 800, maxChars: 1000, overlapChars: 299 },
    ];
    const doc = pages(prose(0, 120), "word ".repeat(900), prose(500, 40));
    for (const o of options) {
      for (const c of chunkPages(doc, o)) expect(c.text.length).toBeLessThanOrEqual(o.maxChars);
    }
  });

  test("consecutive chunks overlap", () => {
    const chunks = chunkPages(pages(prose(0, 120)));
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-60);
      expect(chunks[i].text).toContain(prevTail.slice(prevTail.indexOf(" ") + 1));
    }
  });

  test("ordinals are sequential and output is deterministic", () => {
    const doc = pages(prose(0, 150), prose(150, 150));
    const a = chunkPages(doc);
    expect(a.map((c) => c.ordinal)).toEqual(a.map((_, i) => i));
    expect(chunkPages(doc)).toEqual(a);
  });

  test("page spans are monotonic and cover the pages that had text", () => {
    const doc = pages(prose(0, 30), prose(30, 30), prose(60, 30), prose(90, 30));
    const chunks = chunkPages(doc);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[chunks.length - 1].pageEnd).toBe(4);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].pageStart!).toBeLessThanOrEqual(chunks[i].pageEnd!);
      if (i > 0) expect(chunks[i].pageStart!).toBeGreaterThanOrEqual(chunks[i - 1].pageStart!);
    }
  });

  test("short slide pages are packed together rather than one chunk each", () => {
    const slides = pages(...Array.from({ length: 12 }, (_, i) => `Slide ${i + 1}\nOne bullet about topic ${i + 1}.`));
    const chunks = chunkPages(slides);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 12 });
  });

  test("prefers paragraph breaks, and rejoins a split paragraph with spaces", () => {
    const text = `${prose(0, 5)}\n\n${prose(5, 60)}`;
    const chunks = chunkPages(pages(text));
    // The first paragraph stays intact at the start of the first chunk.
    expect(chunks[0].text.startsWith(`${prose(0, 5)}\n\n`)).toBe(true);
    // Sentence pieces of the long paragraph are joined with a space, not "\n\n".
    expect(chunks[0].text.split("\n\n")).toHaveLength(2);
  });

  test("a single overlong token is hard-cut rather than looping", () => {
    const chunks = chunkPages(pages("y".repeat(10_000)));
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((c) => c.text).join("").replace(/\s/g, "")).toContain("y".repeat(1000));
  });

  test("unpaged sources carry no page numbers", () => {
    const [chunk] = chunkPages(pages("Some notes."), DEFAULT_CHUNK_OPTIONS, false);
    expect(chunk).toEqual({ ordinal: 0, text: "Some notes." });
  });

  test("empty input yields no chunks", () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages(pages("   \n\n  "))).toEqual([]);
  });

  test("rejects option sets that would break the size bound", () => {
    expect(() => chunkPages([], { targetChars: 100, maxChars: 200, overlapChars: 100 })).toThrow();
    expect(() => chunkPages([], { targetChars: 300, maxChars: 200, overlapChars: 10 })).toThrow();
  });
});
