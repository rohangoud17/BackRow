/**
 * HTTP API — courses and their documents.
 *
 *   POST   /courses                            create a course       (x-creator-key)
 *   POST   /courses/{courseId}/documents       start an upload       (x-course-token)
 *   GET    /courses/{courseId}/documents       list documents        (x-course-token)
 *   DELETE /courses/{courseId}/documents/{id}  delete a document     (x-course-token)
 *
 * File bytes never pass through here. An upload returns a presigned S3 POST and
 * the browser sends the file straight to S3; the S3 event then triggers ingest.
 * That sidesteps the HTTP API's 10 MB payload cap and Lambda's 6 MB one, and
 * keeps this function fast and cheap.
 *
 * Presigned POST rather than PUT because only a POST policy can enforce
 * `content-length-range`. A presigned PUT would let a holder upload any size.
 */
import { randomBytes } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from "aws-lambda";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  DEFAULT_ORG_ID,
  COURSE_TOKEN_HEADER,
  CREATOR_KEY_HEADER,
  chunkIndexName,
  classifyUpload,
  createCourseRequestSchema,
  createDocumentRequestSchema,
  documentObjectKey,
  generateId,
  isValidId,
  vectorKey,
  type DocumentSummary,
} from "@backrow/shared";
import {
  beginDelete,
  claimCreatorQuota,
  createDocument,
  DocumentBusy,
  DocumentNotFound,
  finishDelete,
  getCourse,
  listDocuments,
  putCourse,
  refundCreatorQuota,
} from "../doc-repository";
import {
  CreatorKeyNotConfigured,
  CreatorKeySource,
  generateCourseToken,
  sha256Hex,
  verifySecret,
} from "../secrets";
import { S3VectorStore, type VectorStore } from "../vector-store";
import type { CourseRecord, DocumentRecord } from "../types";

const bytes = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

/** Upload URLs are short-lived: long enough for a slow connection, no longer. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Courses one creator key may create. Bounds what a leaked key can do. */
const maxCoursesPerKey = () => Number(process.env.MAX_COURSES_PER_CREATOR_KEY ?? 20);

const s3 = new S3Client({});
const creatorKey = new CreatorKeySource(process.env.CREATOR_KEY_PARAM);
let vectors: VectorStore | undefined;
const vectorStore = () => (vectors ??= new S3VectorStore(env("VECTOR_BUCKET")));

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    // Same origin story as /sessions; Phase 4 replaces "*" with an allow-list.
    "access-control-allow-origin": "*",
  },
  body: JSON.stringify(body),
});

/** Errors carry a stable `code` so the presenter UI branches without string matching. */
const fail = (statusCode: number, code: string, error: string) =>
  json(statusCode, { error, code });

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResult> {
  const route = event.routeKey;
  try {
    switch (route) {
      case "POST /courses":
        return await createCourse(event);
      case "POST /courses/{courseId}/documents":
        return await startUpload(event);
      case "GET /courses/{courseId}/documents":
        return await listCourseDocuments(event);
      case "DELETE /courses/{courseId}/documents/{docId}":
        return await deleteDocument(event);
      default:
        return fail(404, "NOT_FOUND", "not found");
    }
  } catch (err) {
    // Log the error class only — request bodies here can hold course names and
    // file titles, and nothing user-supplied belongs in CloudWatch.
    console.error("request failed", { route, err: (err as Error)?.name });
    return fail(500, "INTERNAL", "internal error");
  }
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// --- POST /courses -------------------------------------------------------------

async function createCourse(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
  let keyHash: string;
  try {
    keyHash = await creatorKey.currentHash();
  } catch (err) {
    if (err instanceof CreatorKeyNotConfigured) {
      return fail(503, "NOT_CONFIGURED", "course creation is not configured");
    }
    throw err;
  }
  if (!verifySecret(event.headers[CREATOR_KEY_HEADER], keyHash)) {
    return fail(401, "INVALID_CREATOR_KEY", "missing or invalid creator key");
  }

  const parsed = createCourseRequestSchema.safeParse(parseBody(event));
  if (!parsed.success) return fail(400, "BAD_REQUEST", "body must be {\"name\": string}");

  const orgId = DEFAULT_ORG_ID;
  const nowMs = Date.now();

  // Claimed before any resource exists, so a leaked key that hits the cap
  // can't create even one more index.
  const allowed = await claimCreatorQuota({ orgId, keyHash, cap: maxCoursesPerKey(), nowMs });
  if (!allowed) {
    return fail(429, "COURSE_LIMIT", "this creator key has reached its course limit");
  }

  const courseId = generateId(bytes);
  const courseToken = generateCourseToken();
  const record: CourseRecord = {
    entity: "course",
    orgId,
    courseId,
    name: parsed.data.name,
    tokenHash: sha256Hex(courseToken),
    chunkIndex: chunkIndexName(orgId, courseId),
    corpusVersion: 0,
    docCount: 0,
    createdAt: nowMs,
  };

  try {
    // Index first: a course row pointing at an index that doesn't exist would
    // fail every upload. An orphaned empty index costs nothing.
    await vectorStore().createIndex(record.chunkIndex);
    await putCourse(record);
  } catch (err) {
    await refundCreatorQuota(orgId, keyHash).catch(() => undefined);
    throw err;
  }

  console.log("course created", { orgId, courseId });
  return json(201, {
    orgId,
    courseId,
    name: record.name,
    createdAt: nowMs,
    // Returned once, never again — only its hash is stored.
    courseToken,
  });
}

// --- course-token routes --------------------------------------------------------

/**
 * Resolve the course and check its token. Unknown course and wrong token get the
 * same answer, so the endpoint can't be used to discover which course ids exist.
 */
async function authorizeCourse(
  event: APIGatewayProxyEventV2
): Promise<CourseRecord | APIGatewayProxyResult> {
  const courseId = event.pathParameters?.courseId ?? "";
  if (!isValidId(courseId)) return fail(400, "BAD_REQUEST", "malformed course id");

  const course = await getCourse(DEFAULT_ORG_ID, courseId);
  const token = event.headers[COURSE_TOKEN_HEADER];
  if (!course || !verifySecret(token, course.tokenHash)) {
    return fail(403, "INVALID_COURSE_TOKEN", "unknown course or invalid course token");
  }
  return course;
}

const isResponse = (x: unknown): x is APIGatewayProxyResult =>
  typeof x === "object" && x !== null && "statusCode" in x;

async function startUpload(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
  const course = await authorizeCourse(event);
  if (isResponse(course)) return course;

  const parsed = createDocumentRequestSchema.safeParse(parseBody(event));
  if (!parsed.success) {
    return fail(400, "BAD_REQUEST", "body must be {filename: string, bytes: number, title?: string}");
  }
  const { filename, bytes: size } = parsed.data;

  const kind = classifyUpload(filename);
  if (!kind.ok) return fail(415, kind.code, kind.message);

  if (size > kind.maxBytes) {
    const mb = Math.round(kind.maxBytes / (1024 * 1024));
    return fail(413, "FILE_TOO_LARGE", `files of this type can be at most ${mb} MB`);
  }

  const { orgId, courseId } = course;
  const docId = generateId(bytes);
  const s3Key = documentObjectKey(orgId, courseId, docId, kind.ext);
  const nowMs = Date.now();

  await createDocument(
    {
      entity: "document",
      orgId,
      courseId,
      docId,
      title: parsed.data.title ?? filename.replace(/\.[^.]+$/, ""),
      filename,
      ext: kind.ext,
      s3Key,
      bytes: size,
      status: "uploading",
      uploadedAt: nowMs,
    },
    nowMs
  );

  const upload = await createPresignedPost(s3, {
    Bucket: env("DOCS_BUCKET"),
    Key: s3Key,
    Conditions: [
      // The real size limit. The declared `bytes` above is only a courtesy check.
      ["content-length-range", 1, kind.maxBytes],
      ["eq", "$Content-Type", kind.contentType],
    ],
    Fields: { "Content-Type": kind.contentType },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });

  console.log("upload started", { orgId, courseId, docId, ext: kind.ext, bytes: size });
  return json(201, {
    docId,
    contentType: kind.contentType,
    maxBytes: kind.maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    // POST these as multipart form fields, with the file appended last.
    upload: { url: upload.url, fields: upload.fields },
  });
}

async function listCourseDocuments(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResult> {
  const course = await authorizeCourse(event);
  if (isResponse(course)) return course;

  const docs = await listDocuments(course.orgId, course.courseId);
  docs.sort((a, b) => b.uploadedAt - a.uploadedAt);

  return json(200, {
    courseId: course.courseId,
    name: course.name,
    corpusVersion: course.corpusVersion,
    documents: docs.map(toSummary),
  });
}

function toSummary(d: DocumentRecord): DocumentSummary {
  return {
    docId: d.docId,
    title: d.title,
    filename: d.filename,
    status: d.status,
    failReason: d.failReason,
    bytes: d.bytes,
    pages: d.pages,
    chunkCount: d.chunkCount,
    uploadedAt: d.uploadedAt,
    ingestedAt: d.ingestedAt,
  };
}

/**
 * Delete a document: vectors, then the raw file, then the row. The row goes
 * last so that if anything fails midway, the document is still listed as
 * `deleting` and the same DELETE can be retried to finish the job.
 */
async function deleteDocument(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResult> {
  const course = await authorizeCourse(event);
  if (isResponse(course)) return course;

  const docId = event.pathParameters?.docId ?? "";
  if (!isValidId(docId)) return fail(400, "BAD_REQUEST", "malformed document id");

  let record: DocumentRecord;
  try {
    record = await beginDelete(course.orgId, course.courseId, docId);
  } catch (err) {
    if (err instanceof DocumentNotFound) return fail(404, "DOCUMENT_NOT_FOUND", "no such document");
    if (err instanceof DocumentBusy) {
      return fail(409, "DOCUMENT_BUSY", "document is still uploading or processing; try again shortly");
    }
    throw err;
  }

  // Keys are deterministic, so every vector this document could have written is
  // computable without listing the index.
  const keys = Array.from({ length: record.chunkCount ?? 0 }, (_, i) => vectorKey(docId, i));
  if (keys.length > 0) await vectorStore().deleteVectors(course.chunkIndex, keys);
  await s3.send(new DeleteObjectCommand({ Bucket: env("DOCS_BUCKET"), Key: record.s3Key }));
  await finishDelete(record);

  console.log("document deleted", { orgId: course.orgId, courseId: course.courseId, docId });
  return json(200, { docId, status: "deleted" });
}
