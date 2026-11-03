/**
 * S3 ObjectCreated under `raw/` -> extract, chunk, embed, store.
 *
 * Invoked asynchronously by S3, which means a throttle is queued and retried
 * rather than lost, and that the same event can arrive more than once. The
 * conditional claim in `claimForIngest` makes duplicates no-ops.
 *
 * Failure handling has two tiers:
 *
 *   - Anything this code can catch (a scanned PDF, Bedrock giving up after its
 *     retries) marks the document `failed` with a reason and returns normally.
 *     Retrying the same bytes would fail the same way, and the presenter needs a
 *     reason they can act on, not a document stuck in `processing`.
 *   - A timeout or crash can't be caught. The document is left `processing`,
 *     Lambda's async retry re-invokes, and the claim accepts it because
 *     `processingStartedAt` is older than the function timeout.
 *
 * FERPA-style logging discipline applies here too even though course material
 * is not student data: ids, counts and timings only, never extracted text.
 */
import type { S3Event, S3EventRecord } from "aws-lambda";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  parseDocumentObjectKey,
  vectorKey,
  MAX_TEXT_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  type DocumentFailReason,
} from "@backrow/shared";
import { chunkPages } from "../chunker";
import { extractDocument } from "../extract";
import { mapLimit, TitanEmbedder, type Embedder } from "../embedder";
import { S3VectorStore, type VectorStore } from "../vector-store";
import {
  claimForIngest,
  ConditionFailed,
  getCourse,
  getDocument,
  markFailed,
  markReady,
} from "../doc-repository";
import { IngestError, type Chunk, type ChunkVector, type DocumentRecord } from "../types";

/** Concurrent Titan calls per document. See `mapLimit` for why it's bounded. */
const EMBED_CONCURRENCY = 8;

/**
 * Hard ceiling on chunks per document. At ~1.6 KB per chunk this is ~5 MB of
 * text, well beyond any lecture deck, and it bounds the worst-case ingest time
 * and Bedrock spend of a single upload.
 */
export const MAX_CHUNKS = 3000;

export interface IngestDeps {
  s3: S3Client;
  embedder: Embedder;
  vectors: VectorStore;
  docsBucket: string;
  /** Matches the function timeout: older `processing` claims are presumed dead. */
  staleAfterMs: number;
  now: () => number;
}

let deps: IngestDeps | undefined;
const defaultDeps = (): IngestDeps =>
  (deps ??= {
    s3: new S3Client({}),
    embedder: new TitanEmbedder(),
    vectors: new S3VectorStore(required("VECTOR_BUCKET")),
    docsBucket: required("DOCS_BUCKET"),
    staleAfterMs: Number(process.env.INGEST_STALE_MS ?? 5 * 60 * 1000),
    now: () => Date.now(),
  });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

export async function handler(event: S3Event): Promise<void> {
  // S3 sends one record per event in practice; looping keeps it correct if not.
  for (const record of event.Records) {
    await ingestRecord(record, defaultDeps());
  }
}

export async function ingestRecord(record: S3EventRecord, d: IngestDeps): Promise<void> {
  // Keys arrive URL-encoded with "+" for spaces. Ours never contain either, but
  // decoding properly means a stray upload can't confuse the parser.
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  const ids = parseDocumentObjectKey(key);
  if (!ids) {
    console.warn("ignoring object outside the document key layout");
    return;
  }
  const { orgId, courseId, docId } = ids;
  const startedAt = d.now();

  const doc = await claimForIngest({
    orgId,
    courseId,
    docId,
    nowMs: startedAt,
    staleAfterMs: d.staleAfterMs,
  });
  if (!doc) {
    // Either a duplicate event (the row is already past `uploading`) or an
    // orphan: the upload finished after its row expired. Orphans would sit in
    // the bucket forever, so they are removed.
    if (!(await getDocument(orgId, courseId, docId))) {
      await d.s3.send(new DeleteObjectCommand({ Bucket: d.docsBucket, Key: key }));
      console.warn("deleted orphaned upload", { orgId, courseId, docId });
    } else {
      console.log("skipping duplicate ingest event", { orgId, courseId, docId });
    }
    return;
  }

  let chunkCount: number | undefined;
  let result: { pages: number; chunkCount: number };
  try {
    result = await ingest(doc, record.s3.object.size, d, (n) => (chunkCount = n));
  } catch (err) {
    const reason: DocumentFailReason = err instanceof IngestError ? err.reason : "INTERNAL";
    // Message text is ours for IngestError; for anything else keep the class
    // name only, since SDK errors can echo request content.
    console.warn("ingest failed", {
      orgId,
      courseId,
      docId,
      reason,
      detail: err instanceof IngestError ? err.message : (err as Error)?.name,
    });
    await removeVectors(doc, chunkCount, d);
    await markFailed({ orgId, courseId, docId, reason, chunkCount, nowMs: d.now() });
    return;
  }

  // Outside the failure path on purpose. If this loses its condition, another
  // attempt owns the document now and wrote the same deterministic vector keys,
  // so cleaning up here would delete *its* vectors.
  try {
    await markReady({ orgId, courseId, docId, ...result, nowMs: d.now() });
  } catch (err) {
    if (err instanceof ConditionFailed) {
      console.warn("document settled by another attempt", { orgId, courseId, docId });
      return;
    }
    throw err;
  }
  console.log("ingest complete", {
    orgId,
    courseId,
    docId,
    pages: result.pages,
    chunks: result.chunkCount,
    ms: d.now() - startedAt,
  });
}

async function ingest(
  doc: DocumentRecord,
  objectSize: number,
  d: IngestDeps,
  onChunked: (n: number) => void
): Promise<{ pages: number; chunkCount: number }> {
  const maxBytes = doc.ext === "pdf" ? MAX_UPLOAD_BYTES : MAX_TEXT_UPLOAD_BYTES;
  // The presigned policy already enforces this; checked again because the
  // bucket policy is the only thing standing between this function and an
  // arbitrarily large object.
  if (objectSize > maxBytes) throw new IngestError("TOO_LARGE", `${objectSize} bytes`);

  const course = await getCourse(doc.orgId, doc.courseId);
  if (!course) throw new IngestError("INTERNAL", "course record missing");

  const obj = await d.s3.send(new GetObjectCommand({ Bucket: d.docsBucket, Key: doc.s3Key }));
  const bytes = await obj.Body!.transformToByteArray();

  const extracted = await extractDocument(bytes, doc.ext);
  const chunks = chunkPages(extracted.pages, undefined, extracted.paged);
  if (chunks.length === 0) throw new IngestError("EMPTY_DOCUMENT", "no chunks produced");
  if (chunks.length > MAX_CHUNKS) {
    throw new IngestError("TOO_LARGE", `${chunks.length} chunks exceeds ${MAX_CHUNKS}`);
  }
  onChunked(chunks.length);

  const embeddings = await mapLimit(chunks, EMBED_CONCURRENCY, (c) =>
    d.embedder.embed(embeddingInput(doc.title, c))
  );

  const vectors: ChunkVector[] = chunks.map((c, i) => ({
    key: vectorKey(doc.docId, c.ordinal),
    embedding: embeddings[i],
    metadata: {
      docId: doc.docId,
      title: doc.title,
      text: c.text,
      ordinal: c.ordinal,
      ...(c.pageStart !== undefined ? { pageStart: c.pageStart, pageEnd: c.pageEnd } : {}),
    },
  }));
  await d.vectors.putVectors(course.chunkIndex, vectors);

  return { pages: extracted.totalPages, chunkCount: chunks.length };
}

/**
 * What gets embedded: the chunk prefixed with its document title and page.
 * Slides and notes often never restate their topic ("Lecture 4: Deadlocks"), so
 * the prefix gives each chunk the context a student's question will contain.
 * The stored `text` stays the raw chunk, so citations quote the source exactly.
 */
export function embeddingInput(title: string, chunk: Chunk): string {
  const where =
    chunk.pageStart === undefined
      ? ""
      : chunk.pageStart === chunk.pageEnd
        ? ` (p. ${chunk.pageStart})`
        : ` (pp. ${chunk.pageStart}-${chunk.pageEnd})`;
  return `${title}${where}\n${chunk.text}`;
}

/** Best-effort cleanup so a failed document leaves nothing retrievable behind. */
async function removeVectors(
  doc: DocumentRecord,
  chunkCount: number | undefined,
  d: IngestDeps
): Promise<void> {
  if (!chunkCount) return;
  try {
    const course = await getCourse(doc.orgId, doc.courseId);
    if (!course) return;
    const keys = Array.from({ length: chunkCount }, (_, i) => vectorKey(doc.docId, i));
    await d.vectors.deleteVectors(course.chunkIndex, keys);
  } catch (err) {
    // The DELETE route retries this cleanup from `chunkCount`, so it's safe to
    // leave for later rather than mask the original failure.
    console.warn("vector cleanup failed", { docId: doc.docId, err: (err as Error)?.name });
  }
}
