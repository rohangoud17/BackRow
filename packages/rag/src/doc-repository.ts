/**
 * DynamoDB access for courses, documents and the creator-key quota.
 *
 * Every document status change is a conditional write that asserts the state it
 * expects to leave. That is what makes the pipeline safe against the two things
 * S3 and Lambda guarantee will happen eventually: an event delivered twice, and
 * a retry arriving after a crash. A read-then-write check loses both races.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  courseKey,
  documentKey,
  documentQueryPrefix,
  creatorQuotaKey,
  ttlFrom,
  type DocumentFailReason,
} from "@backrow/shared";
import type { CourseRecord, DocumentRecord } from "./types";

const client = new DynamoDBClient({});
export const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = () => {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error("TABLE_NAME env var is not set");
  return t;
};

/**
 * A presigned upload that nobody completes leaves an `uploading` row behind.
 * It carries a TTL until ingest claims it, so abandoned uploads clean
 * themselves up. A day is far longer than the 15-minute upload URL.
 */
export const UPLOADING_TTL_SECONDS = 24 * 60 * 60;

export class ConditionFailed extends Error {}
export class DocumentNotFound extends Error {}
/** The document is mid-ingest; it can be deleted once it settles. */
export class DocumentBusy extends Error {}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

function isTransactionConditionFailure(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  return (
    e?.name === "TransactionCanceledException" &&
    (e.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed")
  );
}

// --- courses -----------------------------------------------------------------

export async function putCourse(record: CourseRecord): Promise<void> {
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { ...courseKey(record.orgId, record.courseId), ...record },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ConditionFailed(`course ${record.courseId} already exists`);
    }
    throw err;
  }
}

export async function getCourse(
  orgId: string,
  courseId: string
): Promise<CourseRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE(), Key: courseKey(orgId, courseId) })
  );
  return res.Item as CourseRecord | undefined;
}

/**
 * Take one slot from a creator key's course allowance.
 *
 * The cap is in the condition expression, so concurrent requests with the same
 * key can't both take the last slot. Returns false once the key is used up.
 */
export async function claimCreatorQuota(params: {
  orgId: string;
  keyHash: string;
  cap: number;
  nowMs: number;
}): Promise<boolean> {
  const { orgId, keyHash, cap, nowMs } = params;
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: creatorQuotaKey(orgId, keyHash),
        UpdateExpression: "ADD created :one SET entity = :e, lastAt = :now",
        ConditionExpression: "attribute_not_exists(created) OR created < :cap",
        ExpressionAttributeValues: {
          ":one": 1,
          ":cap": cap,
          ":e": "quota",
          ":now": nowMs,
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** Give a slot back when course creation fails after the claim. */
export async function refundCreatorQuota(orgId: string, keyHash: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: creatorQuotaKey(orgId, keyHash),
      UpdateExpression: "ADD created :minus",
      ConditionExpression: "created > :zero",
      ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
    })
  );
}

// --- documents ---------------------------------------------------------------

export async function createDocument(
  record: Omit<DocumentRecord, "ttl">,
  nowMs: number
): Promise<void> {
  const { orgId, courseId, docId } = record;
  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        ...documentKey(orgId, courseId, docId),
        ...record,
        ttl: ttlFrom(nowMs, UPLOADING_TTL_SECONDS),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    })
  );
}

export async function getDocument(
  orgId: string,
  courseId: string,
  docId: string
): Promise<DocumentRecord | undefined> {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLE(),
      Key: documentKey(orgId, courseId, docId),
      ConsistentRead: true,
    })
  );
  return res.Item as DocumentRecord | undefined;
}

export async function listDocuments(
  orgId: string,
  courseId: string
): Promise<DocumentRecord[]> {
  const { PK, skPrefix } = documentQueryPrefix(orgId, courseId);
  const items: DocumentRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": PK, ":sk": skPrefix },
        ExclusiveStartKey,
      })
    );
    items.push(...((res.Items ?? []) as DocumentRecord[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Claim a document for ingest. Returns the record, or undefined if this
 * invocation should do nothing.
 *
 * Succeeds from `uploading` (the normal path), or from `processing` that has
 * gone stale — an earlier attempt that crashed or timed out, retried by Lambda's
 * async retry. A duplicate S3 event arriving while the first attempt is still
 * running finds a fresh `processingStartedAt` and backs off.
 *
 * Removing `ttl` here is what stops a document mid-ingest from expiring.
 */
export async function claimForIngest(params: {
  orgId: string;
  courseId: string;
  docId: string;
  nowMs: number;
  staleAfterMs: number;
}): Promise<DocumentRecord | undefined> {
  const { orgId, courseId, docId, nowMs, staleAfterMs } = params;
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: documentKey(orgId, courseId, docId),
        UpdateExpression: "SET #s = :processing, processingStartedAt = :now REMOVE #ttl",
        ConditionExpression:
          "#s = :uploading OR (#s = :processing AND processingStartedAt < :stale)",
        ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":processing": "processing",
          ":uploading": "uploading",
          ":now": nowMs,
          ":stale": nowMs - staleAfterMs,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes as DocumentRecord;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return undefined;
    throw err;
  }
}

/**
 * Mark a document ready and bump the course's corpus version in one
 * transaction, so "document is ready" and "the course knows its corpus changed"
 * can never disagree — the answer cache (Phase 3.2) relies on the second.
 */
export async function markReady(params: {
  orgId: string;
  courseId: string;
  docId: string;
  pages: number;
  chunkCount: number;
  nowMs: number;
}): Promise<void> {
  const { orgId, courseId, docId, pages, chunkCount, nowMs } = params;
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE(),
              Key: documentKey(orgId, courseId, docId),
              UpdateExpression:
                "SET #s = :ready, pages = :pages, chunkCount = :chunks, ingestedAt = :now",
              ConditionExpression: "#s = :processing",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":ready": "ready",
                ":processing": "processing",
                ":pages": pages,
                ":chunks": chunkCount,
                ":now": nowMs,
              },
            },
          },
          {
            Update: {
              TableName: TABLE(),
              Key: courseKey(orgId, courseId),
              UpdateExpression: "ADD corpusVersion :one, docCount :one",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
        ],
      })
    );
  } catch (err) {
    if (isTransactionConditionFailure(err)) {
      throw new ConditionFailed(`document ${docId} was no longer processing`);
    }
    throw err;
  }
}

export async function markFailed(params: {
  orgId: string;
  courseId: string;
  docId: string;
  reason: DocumentFailReason;
  /** Known once chunking ran, so a later delete can clean up stray vectors. */
  chunkCount?: number;
  nowMs: number;
}): Promise<void> {
  const { orgId, courseId, docId, reason, chunkCount, nowMs } = params;
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: documentKey(orgId, courseId, docId),
        UpdateExpression:
          chunkCount === undefined
            ? "SET #s = :failed, failReason = :r, ingestedAt = :now"
            : "SET #s = :failed, failReason = :r, ingestedAt = :now, chunkCount = :c",
        ConditionExpression: "#s = :processing",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":processing": "processing",
          ":r": reason,
          ":now": nowMs,
          ...(chunkCount === undefined ? {} : { ":c": chunkCount }),
        },
      })
    );
  } catch (err) {
    // Someone else already settled it; their outcome stands.
    if (isConditionalCheckFailed(err)) return;
    throw err;
  }
}

/**
 * Move a document into `deleting`, returning its record.
 *
 * Allowed from `ready` and `failed`, and from `deleting` itself so a delete
 * that crashed halfway can simply be retried. Not allowed mid-ingest: the
 * ingest would otherwise write vectors for a document that no longer exists.
 *
 * `statusBeforeDelete` is recorded only on the first attempt, so a retried
 * delete still knows whether the document counted towards `docCount`.
 */
export async function beginDelete(
  orgId: string,
  courseId: string,
  docId: string
): Promise<DocumentRecord> {
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: documentKey(orgId, courseId, docId),
        UpdateExpression:
          "SET statusBeforeDelete = if_not_exists(statusBeforeDelete, #s), #s = :deleting",
        ConditionExpression: "attribute_exists(PK) AND #s IN (:ready, :failed, :deleting)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "deleting",
          ":ready": "ready",
          ":failed": "failed",
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes as DocumentRecord;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      const existing = await getDocument(orgId, courseId, docId);
      if (!existing) throw new DocumentNotFound(docId);
      throw new DocumentBusy(docId);
    }
    throw err;
  }
}

/**
 * Remove the document row and, if it was ready, take it out of the course's
 * counts — atomically, for the same reason as `markReady`.
 */
export async function finishDelete(
  record: DocumentRecord & { statusBeforeDelete?: string }
): Promise<void> {
  const { orgId, courseId, docId } = record;
  const wasReady = record.statusBeforeDelete === "ready";

  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE(),
            Key: documentKey(orgId, courseId, docId),
            ConditionExpression: "#s = :deleting",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":deleting": "deleting" },
          },
        },
        ...(wasReady
          ? [
              {
                Update: {
                  TableName: TABLE(),
                  Key: courseKey(orgId, courseId),
                  UpdateExpression: "ADD corpusVersion :one, docCount :minus",
                  ExpressionAttributeValues: { ":one": 1, ":minus": -1 },
                },
              },
            ]
          : []),
      ],
    })
  );
}
