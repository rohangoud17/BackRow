/**
 * Courses and course documents — the RAG ingestion contract.
 *
 * Shared because both sides need it: the presenter UI uploads documents and
 * renders their status, and the backend owns the keys and limits. Like the
 * rest of this package it stays free of Node-only imports, since it also runs
 * in a browser bundle. Token hashing therefore lives server-side.
 *
 * Tenancy: course-scoped keys carry `ORG#<orgId>` above `COURSE#<courseId>`
 * even though there is exactly one org today. Retrofitting a tenant level into
 * partition keys after real data exists means migrating every item; carrying a
 * constant costs a few bytes. Pre-existing session keys are deliberately left
 * alone — they are short-lived and already in use.
 */
import { z } from "zod";
import type { TableKey } from "./keys";

/** The only org until institutional (LTI) installs exist. */
export const DEFAULT_ORG_ID = "default";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Lowercase alphanumerics only. Course ids end up inside S3 Vectors index
 * names, which allow only lowercase letters, digits, hyphens and dots — so the
 * id alphabet is chosen to make every id a valid index-name fragment.
 */
export const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const ID_LENGTH = 12;

/**
 * 32^12 = 2^60 possible ids: unguessable enough that knowing one id tells you
 * nothing about another, and every write that creates one is conditional anyway.
 * `randomBytes` is injected for the same reason as `generateSessionCode`.
 */
export function generateId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = "";
  // 256 % 32 === 0, so the modulo introduces no bias.
  for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[bytes[i] % 32];
  return out;
}

const ID_PATTERN = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

/** Cheap shape check before spending a read on a path parameter. */
export const isValidId = (id: string): boolean => ID_PATTERN.test(id);

// ---------------------------------------------------------------------------
// Table keys
// ---------------------------------------------------------------------------

export const coursePartition = (orgId: string, courseId: string): string =>
  `ORG#${orgId}#COURSE#${courseId}`;

/** The course record: name, token hash, index name, corpus version. */
export const courseKey = (orgId: string, courseId: string): TableKey => ({
  PK: coursePartition(orgId, courseId),
  SK: "META",
});

export const DOCUMENT_PREFIX = "DOC#";

/**
 * A document shares its course's partition, so "list this course's documents"
 * is one Query. Writes are a handful per upload, so the partition never runs hot.
 */
export const documentKey = (
  orgId: string,
  courseId: string,
  docId: string
): TableKey => ({
  PK: coursePartition(orgId, courseId),
  SK: `${DOCUMENT_PREFIX}${docId}`,
});

export const documentQueryPrefix = (orgId: string, courseId: string) => ({
  PK: coursePartition(orgId, courseId),
  skPrefix: DOCUMENT_PREFIX,
});

/**
 * How many courses one creator key has made.
 *
 * Keyed by a hash *prefix* of the key, never the key itself, so the table holds
 * nothing that authorizes anything. Rotating the key starts a fresh count,
 * which is the point: the cap exists to bound what one leaked key can do.
 */
export const creatorQuotaKey = (orgId: string, keyHash: string): TableKey => ({
  PK: `ORG#${orgId}#CREATOR#${keyHash.slice(0, 16)}`,
  SK: "QUOTA",
});

// ---------------------------------------------------------------------------
// Storage naming
// ---------------------------------------------------------------------------

/** One S3 Vectors index per course: deleting a course is dropping an index. */
export const chunkIndexName = (orgId: string, courseId: string): string =>
  `chunks-${orgId}-${courseId}`;

/** Raw uploads live under `raw/` — the prefix the ingest trigger listens on. */
export const RAW_PREFIX = "raw/";

/**
 * Every id the ingest Lambda needs is encoded in the object key, so it works
 * from the S3 event alone: no lookup, and no trust in client-set metadata.
 */
export const documentObjectKey = (
  orgId: string,
  courseId: string,
  docId: string,
  ext: UploadExtension
): string => `${RAW_PREFIX}${orgId}/${courseId}/${docId}.${ext}`;

export interface ParsedObjectKey {
  orgId: string;
  courseId: string;
  docId: string;
  ext: UploadExtension;
}

/** Inverse of `documentObjectKey`. Anything else under the bucket is ignored. */
export function parseDocumentObjectKey(key: string): ParsedObjectKey | undefined {
  const m = /^raw\/([a-z0-9-]{1,32})\/([a-z0-9]+)\/([a-z0-9]+)\.(pdf|txt|md)$/.exec(
    key
  );
  if (!m) return undefined;
  const [, orgId, courseId, docId, ext] = m;
  if (!isValidId(courseId) || !isValidId(docId)) return undefined;
  return { orgId, courseId, docId, ext: ext as UploadExtension };
}

/**
 * A chunk's vector key. Deterministic, so a retried ingest overwrites instead
 * of duplicating, and a delete can compute every key from `chunkCount` without
 * listing the index.
 */
export const vectorKey = (docId: string, ordinal: number): string =>
  `${docId}#${ordinal}`;

// ---------------------------------------------------------------------------
// Upload rules
// ---------------------------------------------------------------------------

/** 25 MB covers a long lecture deck exported to PDF. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Plain text is dense: 2 MB is several textbooks' worth of notes. */
export const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Bounds ingest time (extraction + one embedding call per chunk) safely inside
 * the ingest Lambda's timeout, and bounds what one upload can cost.
 */
export const MAX_PDF_PAGES = 300;

export type UploadExtension = "pdf" | "txt" | "md";

export type UploadRejection = "EXPORT_TO_PDF" | "UNSUPPORTED_TYPE";

export type UploadClassification =
  | {
      ok: true;
      ext: UploadExtension;
      /** The Content-Type the presigned POST will require. */
      contentType: string;
      maxBytes: number;
    }
  | { ok: false; code: UploadRejection; message: string };

const ACCEPTED: Record<UploadExtension, { contentType: string; maxBytes: number }> = {
  pdf: { contentType: "application/pdf", maxBytes: MAX_UPLOAD_BYTES },
  txt: { contentType: "text/plain", maxBytes: MAX_TEXT_UPLOAD_BYTES },
  md: { contentType: "text/markdown", maxBytes: MAX_TEXT_UPLOAD_BYTES },
};

/**
 * Office and slide formats get their own message. Lecture slides are the most
 * likely upload, and "export to PDF" is an action the presenter can take in ten
 * seconds; "unsupported type" sends them looking for one.
 */
const EXPORTABLE = new Set([
  "ppt", "pptx", "pps", "ppsx", "key", "odp",
  "doc", "docx", "odt", "rtf", "pages",
]);

/**
 * Decide from the file name, not the browser's content type: browsers report
 * `.md` as "", "text/x-markdown" or "application/octet-stream" depending on OS.
 * The ingest Lambda sniffs the bytes anyway, so this is about routing, not trust.
 */
export function classifyUpload(filename: string): UploadClassification {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";

  if (ext in ACCEPTED) {
    const { contentType, maxBytes } = ACCEPTED[ext as UploadExtension];
    return { ok: true, ext: ext as UploadExtension, contentType, maxBytes };
  }
  if (EXPORTABLE.has(ext)) {
    return {
      ok: false,
      code: "EXPORT_TO_PDF",
      message: `.${ext} files aren't supported yet. Export to PDF and re-upload.`,
    };
  }
  return {
    ok: false,
    code: "UNSUPPORTED_TYPE",
    message: "Upload a PDF, .txt or .md file.",
  };
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/**
 *   uploading -> processing -> ready | failed
 *   ready | failed -> deleting -> (row removed)
 *
 * Every transition is a conditional write, the same pattern as the session
 * state machine, so duplicate S3 events and racing deletes can't interleave.
 */
export type DocumentStatus =
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "deleting";

/** Closed set, so the presenter UI maps each to a sentence it controls. */
export type DocumentFailReason =
  | "SCANNED_PDF"
  | "PAGE_LIMIT"
  | "TOO_LARGE"
  | "NOT_A_PDF"
  | "EMPTY_DOCUMENT"
  | "EXTRACT_FAILED"
  | "INTERNAL";

/** What `GET /courses/{id}/documents` returns per document. */
export interface DocumentSummary {
  docId: string;
  title: string;
  filename: string;
  status: DocumentStatus;
  failReason?: DocumentFailReason;
  bytes: number;
  pages?: number;
  chunkCount?: number;
  uploadedAt: number;
  ingestedAt?: number;
}

// ---------------------------------------------------------------------------
// HTTP request bodies
// ---------------------------------------------------------------------------

export const createCourseRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const createDocumentRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  /** Display title for citations; defaults to the file name minus extension. */
  title: z.string().trim().min(1).max(200).optional(),
  /** Declared size, checked up front. The presigned policy enforces the truth. */
  bytes: z.number().int().positive(),
});

/**
 * Optional course binding at session creation. The token is required whenever
 * a course id is given: without it, anyone who learned a course id could open
 * sessions that spend that course's assistant budget.
 */
export const createSessionRequestSchema = z
  .object({
    courseId: z.string().refine(isValidId, "malformed course id").optional(),
    courseToken: z.string().min(1).max(128).optional(),
  })
  .refine((b) => !b.courseToken || b.courseId, {
    message: "courseToken given without courseId",
    path: ["courseToken"],
  });

export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

/** Header names, lowercase because HTTP API v2 lowercases incoming headers. */
export const CREATOR_KEY_HEADER = "x-creator-key";
export const COURSE_TOKEN_HEADER = "x-course-token";
