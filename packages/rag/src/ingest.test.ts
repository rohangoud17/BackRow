/**
 * The ingest pipeline end to end, with DynamoDB and S3 mocked and the embedder
 * and vector store replaced by in-memory fakes. Covers the at-least-once cases
 * (duplicate events, retries after a crash, a lost race) because those are the
 * ones that would corrupt a course's index silently.
 */
process.env.TABLE_NAME = "backrow-test";
process.env.AWS_REGION = "us-east-1";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { S3EventRecord } from "aws-lambda";
import { courseKey, documentKey, MAX_UPLOAD_BYTES } from "@backrow/shared";
import { makePdf } from "./testing/make-pdf";
import type { Embedder } from "./embedder";
import type { VectorStore } from "./vector-store";
import type { ChunkVector } from "./types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

import { embeddingInput, ingestRecord, type IngestDeps } from "./handlers/ingest";

const COURSE_ID = "abcdefghjkmn";
const DOC_ID = "pqrstuvwxyz2";
const KEY = `raw/default/${COURSE_ID}/${DOC_ID}.pdf`;
const INDEX = `chunks-default-${COURSE_ID}`;
/** A phrase that must never reach a log line. */
const SECRET_PHRASE = "Banker's algorithm avoids unsafe states";

const docRecord = {
  entity: "document",
  orgId: "default",
  courseId: COURSE_ID,
  docId: DOC_ID,
  title: "Lecture 7",
  filename: "Lecture 7.pdf",
  ext: "pdf",
  s3Key: KEY,
  bytes: 1000,
  status: "processing",
  uploadedAt: 1,
};

const s3Record = (key = KEY, size = 1000): S3EventRecord =>
  ({ s3: { bucket: { name: "docs" }, object: { key, size } } }) as unknown as S3EventRecord;

class FakeVectors implements VectorStore {
  put: ChunkVector[] = [];
  deleted: string[] = [];
  async createIndex() {}
  async putVectors(_index: string, v: ChunkVector[]) {
    this.put.push(...v);
  }
  async deleteVectors(_index: string, keys: string[]) {
    this.deleted.push(...keys);
  }
}

class FakeEmbedder implements Embedder {
  inputs: string[] = [];
  constructor(private readonly failAfter = Infinity) {}
  async embed(text: string) {
    if (this.inputs.length >= this.failAfter) throw new Error("ThrottlingException");
    this.inputs.push(text);
    return new Array(512).fill(0.01);
  }
}

let vectors: FakeVectors;
let embedder: FakeEmbedder;
const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  s3: new S3Client({}),
  embedder,
  vectors,
  docsBucket: "docs",
  staleAfterMs: 300_000,
  now: () => 1_000_000,
  ...over,
});

const pdfPages = Array.from(
  { length: 6 },
  (_, i) =>
    `Deadlock avoidance, part ${i + 1}.\n${SECRET_PHRASE} by checking every request.\n` +
    "A state is safe if some ordering lets every process finish. ".repeat(12)
);

function serveObject(bytes: Uint8Array) {
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToByteArray: async () => bytes } as never,
  });
}

const conditionFailed = () =>
  Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });

const failedWith = () =>
  ddbMock
    .commandCalls(UpdateCommand)
    .map((c) => c.args[0].input)
    .find((i) => i.ExpressionAttributeValues?.[":failed"] === "failed");

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  vectors = new FakeVectors();
  embedder = new FakeEmbedder();
  // The claim is the only Update before the outcome is decided.
  ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: docRecord }).resolves({});
  ddbMock.on(GetCommand, { Key: courseKey("default", COURSE_ID) }).resolves({
    Item: { chunkIndex: INDEX },
  });
  ddbMock.on(TransactWriteCommand).resolves({});
});

describe("ingestRecord", () => {
  test("a text PDF becomes page-attributed vectors and a ready document", async () => {
    serveObject(makePdf(pdfPages));
    const logs = jest.spyOn(console, "log").mockImplementation(() => undefined);

    await ingestRecord(s3Record(), deps());

    expect(vectors.put.length).toBeGreaterThan(1);
    expect(vectors.put.map((v) => v.key)).toEqual(vectors.put.map((_, i) => `${DOC_ID}#${i}`));
    expect(vectors.put[0].metadata).toMatchObject({ docId: DOC_ID, title: "Lecture 7", pageStart: 1 });
    expect(vectors.put[vectors.put.length - 1].metadata.pageEnd).toBe(6);
    // Embedded with the title for context; stored without it.
    expect(embedder.inputs[0].startsWith("Lecture 7 (p")).toBe(true);
    expect(vectors.put[0].metadata.text.startsWith("Lecture 7")).toBe(false);

    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Update?.Key).toEqual(documentKey("default", COURSE_ID, DOC_ID));
    expect(tx[0].Update?.ExpressionAttributeValues).toMatchObject({
      ":ready": "ready",
      ":pages": 6,
      ":chunks": vectors.put.length,
    });
    expect(tx[1].Update?.UpdateExpression).toBe("ADD corpusVersion :one, docCount :one");

    // FERPA-style discipline: nothing from the document reaches a log line.
    expect(JSON.stringify(logs.mock.calls)).not.toContain(SECRET_PHRASE);
    logs.mockRestore();
  });

  test("the claim is conditional and clears the abandoned-upload TTL", async () => {
    serveObject(makePdf(pdfPages));
    await ingestRecord(s3Record(), deps());
    const claim = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(claim.ConditionExpression).toContain("#s = :uploading");
    expect(claim.UpdateExpression).toContain("REMOVE #ttl");
    expect(claim.ExpressionAttributeValues).toMatchObject({ ":stale": 1_000_000 - 300_000 });
  });

  test("a duplicate event does nothing", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand, { Key: documentKey("default", COURSE_ID, DOC_ID) }).resolves({
      Item: docRecord,
    });

    await ingestRecord(s3Record(), deps());

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(vectors.put).toHaveLength(0);
  });

  test("an upload whose row already expired is deleted as an orphan", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand, { Key: documentKey("default", COURSE_ID, DOC_ID) }).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await ingestRecord(s3Record(), deps());

    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(KEY);
  });

  test("a scanned PDF fails with a reason the presenter can act on", async () => {
    serveObject(makePdf(["", "", "", pdfPages[0]]));

    await ingestRecord(s3Record(), deps());

    expect(failedWith()?.ExpressionAttributeValues).toMatchObject({ ":r": "SCANNED_PDF" });
    expect(vectors.put).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test("an embedding failure cleans up and records the chunk count", async () => {
    serveObject(makePdf(pdfPages));
    embedder = new FakeEmbedder(2);

    await ingestRecord(s3Record(), deps());

    const failed = failedWith()!;
    expect(failed.ExpressionAttributeValues).toMatchObject({ ":r": "INTERNAL" });
    const chunkCount = failed.ExpressionAttributeValues![":c"];
    expect(chunkCount).toBeGreaterThan(2);
    // Every key this document could have written is removed.
    expect(vectors.deleted).toEqual(
      Array.from({ length: chunkCount }, (_, i) => `${DOC_ID}#${i}`)
    );
  });

  test("losing the final race to another attempt leaves its vectors alone", async () => {
    serveObject(makePdf(pdfPages));
    ddbMock.on(TransactWriteCommand).rejects(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      })
    );

    await ingestRecord(s3Record(), deps());

    expect(vectors.deleted).toHaveLength(0);
    expect(failedWith()).toBeUndefined();
  });

  test("an object over the size limit is refused without being read", async () => {
    await ingestRecord(s3Record(KEY, MAX_UPLOAD_BYTES + 1), deps());
    expect(failedWith()?.ExpressionAttributeValues).toMatchObject({ ":r": "TOO_LARGE" });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  test("objects outside the document layout are ignored", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await ingestRecord(s3Record("raw/default/notes.pdf"), deps());
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    warn.mockRestore();
  });
});

describe("embeddingInput", () => {
  test("labels single pages, spans, and unpaged text", () => {
    expect(embeddingInput("L1", { ordinal: 0, text: "t", pageStart: 3, pageEnd: 3 })).toBe("L1 (p. 3)\nt");
    expect(embeddingInput("L1", { ordinal: 0, text: "t", pageStart: 3, pageEnd: 4 })).toBe("L1 (pp. 3-4)\nt");
    expect(embeddingInput("Notes", { ordinal: 0, text: "t" })).toBe("Notes\nt");
  });
});
