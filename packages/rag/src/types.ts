/**
 * Types shared across the RAG package. Anything the frontend also needs lives
 * in @backrow/shared instead; these are backend-internal.
 */
import type {
  DocumentFailReason,
  DocumentStatus,
  UploadExtension,
} from "@backrow/shared";

/** One page of extracted text. Text uploads are a single unpaged "page". */
export interface ExtractedPage {
  /** 1-based page number, as a reader would cite it. */
  number: number;
  text: string;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  /** False for .txt/.md, where page numbers would be meaningless in a citation. */
  paged: boolean;
  /** Total pages in the source, including ones skipped for having no text. */
  totalPages: number;
}

/** A chunk ready to embed. */
export interface Chunk {
  ordinal: number;
  text: string;
  /** Present only for paged sources. */
  pageStart?: number;
  pageEnd?: number;
}

/**
 * Metadata stored with each vector.
 *
 * `docId` is the only *filterable* key (it counts toward the 2 KB filterable
 * budget and lets retrieval scope to chosen documents later). Everything else
 * is declared non-filterable at index creation, which is what allows `text` to
 * be up to a few KB: the retrieval call then returns everything the prompt and
 * the citation need, with no second read.
 */
export interface ChunkMetadata {
  docId: string;
  title: string;
  text: string;
  ordinal: number;
  pageStart?: number;
  pageEnd?: number;
}

/** Keys declared non-filterable when an index is created. Immutable after. */
export const NON_FILTERABLE_METADATA_KEYS = [
  "title",
  "text",
  "ordinal",
  "pageStart",
  "pageEnd",
] as const;

export interface ChunkVector {
  key: string;
  embedding: number[];
  metadata: ChunkMetadata;
}

export interface CourseRecord {
  entity: "course";
  orgId: string;
  courseId: string;
  name: string;
  /** SHA-256 of the course token. The plaintext is returned once and never stored. */
  tokenHash: string;
  chunkIndex: string;
  /**
   * Bumped on every document that becomes ready or is deleted. The Phase 3.2
   * answer cache keys on it, so new material invalidates cached answers without
   * deleting anything.
   */
  corpusVersion: number;
  /** Ready documents only. */
  docCount: number;
  createdAt: number;
}

export interface DocumentRecord {
  entity: "document";
  orgId: string;
  courseId: string;
  docId: string;
  title: string;
  filename: string;
  ext: UploadExtension;
  s3Key: string;
  bytes: number;
  status: DocumentStatus;
  failReason?: DocumentFailReason;
  pages?: number;
  chunkCount?: number;
  uploadedAt: number;
  processingStartedAt?: number;
  ingestedAt?: number;
  /**
   * Set only while `uploading`, so a presigned upload nobody completes expires
   * on its own. Removed when ingest claims the document.
   */
  ttl?: number;
}

/** An ingest failure the presenter can act on, as opposed to a bug. */
export class IngestError extends Error {
  constructor(
    readonly reason: DocumentFailReason,
    message: string
  ) {
    super(message);
    this.name = "IngestError";
  }
}
