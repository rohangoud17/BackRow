import { MAX_PDF_PAGES } from "@backrow/shared";
import { assessPages, cleanText, extractDocument, MIN_PAGE_CHARS } from "./extract";
import { makePdf } from "./testing/make-pdf";
import { IngestError } from "./types";

const textPage = (n: number) =>
  `Page ${n} covers process scheduling.\nRound robin gives each process a fixed time slice.`;

async function failure(p: Promise<unknown>): Promise<IngestError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(IngestError);
    return err as IngestError;
  }
  throw new Error("expected an IngestError");
}

describe("extractDocument: PDF", () => {
  test("extracts text per page with true page numbers", async () => {
    const doc = await extractDocument(makePdf([textPage(1), textPage(2), textPage(3)]), "pdf");
    expect(doc.paged).toBe(true);
    expect(doc.totalPages).toBe(3);
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(doc.pages[1].text).toContain("Page 2 covers process scheduling.");
  });

  test("skips a few blank pages without failing, keeping numbering", async () => {
    const doc = await extractDocument(makePdf([textPage(1), "", textPage(3), textPage(4)]), "pdf");
    expect(doc.pages.map((p) => p.number)).toEqual([1, 3, 4]);
    expect(doc.totalPages).toBe(4);
  });

  test("a PDF that is mostly textless is reported as scanned", async () => {
    const err = await failure(extractDocument(makePdf(["", "", textPage(3)]), "pdf"));
    expect(err.reason).toBe("SCANNED_PDF");
  });

  test("a PDF with no text at all is reported as scanned", async () => {
    const err = await failure(extractDocument(makePdf(["", ""]), "pdf"));
    expect(err.reason).toBe("SCANNED_PDF");
  });

  test("rejects documents over the page limit before extracting", async () => {
    const big = makePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => "x"));
    const err = await failure(extractDocument(big, "pdf"));
    expect(err.reason).toBe("PAGE_LIMIT");
  });

  test("rejects bytes that are not a PDF, whatever the extension says", async () => {
    const err = await failure(extractDocument(new TextEncoder().encode("PK\u0003\u0004 zip"), "pdf"));
    expect(err.reason).toBe("NOT_A_PDF");
  });

  test("a corrupt PDF fails cleanly", async () => {
    const err = await failure(extractDocument(new TextEncoder().encode("%PDF-1.4\ngarbage"), "pdf"));
    expect(err.reason).toBe("EXTRACT_FAILED");
  });
});

describe("extractDocument: text", () => {
  test("a text file is one unpaged page", async () => {
    const withBom = String.fromCharCode(0xfeff) + "# Syllabus\r\n\r\nWeek 1";
    const doc = await extractDocument(new TextEncoder().encode(withBom), "md");
    expect(doc).toEqual({
      pages: [{ number: 1, text: "# Syllabus\n\nWeek 1" }],
      paged: false,
      totalPages: 1,
    });
  });

  test("an empty text file is reported as empty", async () => {
    const err = await failure(extractDocument(new TextEncoder().encode("  \n "), "txt"));
    expect(err.reason).toBe("EMPTY_DOCUMENT");
  });

  test("binary content renamed to .txt is rejected", async () => {
    const err = await failure(extractDocument(Uint8Array.from([0xff, 0xfe, 0x00, 0xc3]), "txt"));
    expect(err.reason).toBe("EXTRACT_FAILED");
  });
});

describe("assessPages", () => {
  const page = (number: number, chars: number) => ({ number, text: "a".repeat(chars) });

  test("exactly half textless is still accepted", () => {
    const doc = assessPages([page(1, 100), page(2, 0), page(3, 100), page(4, MIN_PAGE_CHARS - 1)]);
    expect(doc.pages.map((p) => p.number)).toEqual([1, 3]);
  });

  test("more than half textless is scanned", () => {
    expect(() => assessPages([page(1, 100), page(2, 0), page(3, 5)])).toThrow(IngestError);
  });
});

describe("cleanText", () => {
  test("rejoins hyphenated words and normalizes line endings", () => {
    expect(cleanText("synchro-\r\nnization\r\n\r\n\r\n\r\nnext")).toBe("synchronization\n\nnext");
  });

  test("keeps real hyphens", () => {
    expect(cleanText("round-robin and Wait-\nFor")).toBe("round-robin and Wait-\nFor");
  });
});
