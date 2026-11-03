/**
 * Turn an uploaded file's bytes into per-page text.
 *
 * The file type is re-checked from the bytes. The extension and Content-Type
 * were enforced at upload, but both are client-chosen, and a PDF parser is
 * exactly the kind of code that should only ever see PDFs.
 *
 * Scanned-PDF detection: a scanned document is images with no text layer, so
 * the extractor returns (almost) nothing for most pages. Failing fast with a
 * specific reason lets the presenter fix it ("export as a text PDF") instead of
 * getting an assistant that silently knows nothing about that document. OCR
 * (Textract) is deliberately out of scope until a pilot shows it's needed.
 */
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_PDF_PAGES, type UploadExtension } from "@backrow/shared";
import { IngestError, type ExtractedDocument, type ExtractedPage } from "./types";

/** Fewer non-whitespace characters than this and a page counts as having no text. */
export const MIN_PAGE_CHARS = 40;

/** More than this share of textless pages and the document is treated as scanned. */
export const SCANNED_PAGE_RATIO = 0.5;

export async function extractDocument(
  bytes: Uint8Array,
  ext: UploadExtension
): Promise<ExtractedDocument> {
  if (ext === "pdf") return extractPdf(bytes);
  return extractPlainText(bytes);
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  if (!isPdf(bytes)) {
    throw new IngestError("NOT_A_PDF", "file does not start with a PDF header");
  }

  let pageTexts: string[];
  try {
    const pdf = await getDocumentProxy(bytes);
    // Checked before extracting anything: page count is in the document's
    // header, so an oversized deck is rejected without paying to parse it.
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new IngestError(
        "PAGE_LIMIT",
        `${pdf.numPages} pages exceeds the ${MAX_PDF_PAGES}-page limit`
      );
    }
    ({ text: pageTexts } = await extractText(pdf, { mergePages: false }));
  } catch (err) {
    if (err instanceof IngestError) throw err;
    // Encrypted, corrupt, or exotic PDFs. The error text can quote document
    // content, so only its class name is kept.
    throw new IngestError("EXTRACT_FAILED", `PDF could not be parsed (${(err as Error)?.name})`);
  }

  return assessPages(pageTexts.map((text, i) => ({ number: i + 1, text: cleanText(text) })));
}

/**
 * Decide whether extracted pages are usable, and drop the empty ones.
 * Exported separately so the heuristic is testable without building PDFs.
 */
export function assessPages(all: ExtractedPage[]): ExtractedDocument {
  const withText = all.filter((p) => nonWhitespace(p.text) >= MIN_PAGE_CHARS);
  const textless = all.length - withText.length;

  if (all.length === 0 || withText.length === 0) {
    // A PDF with zero text everywhere is almost always a scan.
    throw new IngestError("SCANNED_PDF", "no extractable text on any page");
  }
  if (textless / all.length > SCANNED_PAGE_RATIO) {
    throw new IngestError(
      "SCANNED_PDF",
      `${textless} of ${all.length} pages have no extractable text`
    );
  }

  // Some blank pages are normal in a text PDF — section dividers, image-only
  // slides. They are skipped, not fatal; page numbers stay true to the source.
  return { pages: withText, paged: true, totalPages: all.length };
}

function extractPlainText(bytes: Uint8Array): ExtractedDocument {
  // `fatal: true` rejects invalid UTF-8 rather than silently embedding
  // replacement characters — a binary file renamed to .txt fails here.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IngestError("EXTRACT_FAILED", "file is not valid UTF-8 text");
  }
  // Strip a byte-order mark, which Windows editors add to UTF-8 files.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = cleanText(text);
  if (nonWhitespace(text) === 0) {
    throw new IngestError("EMPTY_DOCUMENT", "file contains no text");
  }
  return { pages: [{ number: 1, text }], paged: false, totalPages: 1 };
}

const isPdf = (b: Uint8Array) =>
  b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-";

const nonWhitespace = (s: string) => s.replace(/\s/g, "").length;

/**
 * Normalize extractor output: unify line endings, rejoin words hyphenated
 * across a line break ("synchro-\nnization"), and drop control characters that
 * PDFs often carry but embeddings gain nothing from.
 */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/([a-z])-\n([a-z])/g, "$1$2")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
