/**
 * Course and document HTTP routes, with DynamoDB, SSM, S3 and S3 Vectors
 * mocked. The cases that matter most are the authorization ones: no plaintext
 * token is ever stored, a bad key or token creates nothing, and an unknown
 * course is indistinguishable from a wrong token.
 */
process.env.TABLE_NAME = "backrow-test";
process.env.DOCS_BUCKET = "docs-bucket";
process.env.VECTOR_BUCKET = "vector-bucket";
process.env.CREATOR_KEY_PARAM = "/backrow/test/course-creator-key";
process.env.MAX_COURSES_PER_CREATOR_KEY = "3";
process.env.AWS_REGION = "us-east-1";
// Presigning needs credentials to sign with; these never leave the process.
process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "secret";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  S3VectorsClient,
  CreateIndexCommand,
  DeleteVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from "aws-lambda";
import { courseKey, documentKey, MAX_UPLOAD_BYTES } from "@backrow/shared";
import { sha256Hex } from "./secrets";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);
const vecMock = mockClient(S3VectorsClient);

// Imported after the mocks are installed.
import { handler } from "./handlers/courses";

const CREATOR_KEY = "k".repeat(48);
const COURSE_ID = "abcdefghjkmn";
const DOC_ID = "pqrstuvwxyz2";
const COURSE_TOKEN = "c".repeat(64);

const course = {
  entity: "course",
  orgId: "default",
  courseId: COURSE_ID,
  name: "CS 471",
  tokenHash: sha256Hex(COURSE_TOKEN),
  chunkIndex: `chunks-default-${COURSE_ID}`,
  corpusVersion: 4,
  docCount: 2,
  createdAt: 1,
};

const event = (
  routeKey: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    pathParameters?: Record<string, string>;
  } = {}
): APIGatewayProxyEventV2 =>
  ({
    routeKey,
    rawPath: "/",
    headers: opts.headers ?? {},
    pathParameters: opts.pathParameters,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: { http: { method: routeKey.split(" ")[0] } },
  }) as unknown as APIGatewayProxyEventV2;

const call = async (e: APIGatewayProxyEventV2) => {
  const res = (await handler(e)) as APIGatewayProxyResult;
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const conditionFailed = () =>
  Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  s3Mock.reset();
  vecMock.reset();
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: CREATOR_KEY } });
  ddbMock.on(GetCommand, { Key: courseKey("default", COURSE_ID) }).resolves({ Item: course });
});

describe("POST /courses", () => {
  const create = (headers: Record<string, string>, body: unknown = { name: "CS 471" }) =>
    call(event("POST /courses", { headers, body }));

  test("creates the index and course, returning the token exactly once", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    vecMock.on(CreateIndexCommand).resolves({});

    const { status, body } = await create({ "x-creator-key": CREATOR_KEY });

    expect(status).toBe(201);
    expect(body.courseId).toMatch(/^[a-z2-9]{12}$/);
    expect(body.courseToken).toMatch(/^[0-9a-f]{64}$/);

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item).toMatchObject({
      PK: `ORG#default#COURSE#${body.courseId}`,
      SK: "META",
      tokenHash: sha256Hex(body.courseToken),
      corpusVersion: 0,
    });
    // The plaintext token must not be anywhere in what was stored.
    expect(JSON.stringify(put.Item)).not.toContain(body.courseToken);
    expect(put.ConditionExpression).toBe("attribute_not_exists(PK)");

    expect(vecMock.commandCalls(CreateIndexCommand)[0].args[0].input).toMatchObject({
      vectorBucketName: "vector-bucket",
      indexName: `chunks-default-${body.courseId}`,
      dimension: 512,
      distanceMetric: "cosine",
      dataType: "float32",
      metadataConfiguration: {
        nonFilterableMetadataKeys: expect.arrayContaining(["text", "title"]),
      },
    });
  });

  test("missing or wrong creator key creates nothing", async () => {
    for (const headers of [{}, { "x-creator-key": "x".repeat(48) }] as Record<string, string>[]) {
      const { status, body } = await create(headers);
      expect(status).toBe(401);
      expect(body.code).toBe("INVALID_CREATOR_KEY");
    }
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(vecMock.commandCalls(CreateIndexCommand)).toHaveLength(0);
  });

  test("the per-key cap is enforced before any index is created", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    const { status, body } = await create({ "x-creator-key": CREATOR_KEY });

    expect(status).toBe(429);
    expect(body.code).toBe("COURSE_LIMIT");
    const claim = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(claim.ExpressionAttributeValues).toMatchObject({ ":cap": 3 });
    // The quota row is keyed by a hash prefix, never the key.
    expect(JSON.stringify(claim.Key)).not.toContain(CREATOR_KEY);
    expect(vecMock.commandCalls(CreateIndexCommand)).toHaveLength(0);
  });

  test("a failed index creation refunds the quota slot", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    vecMock.on(CreateIndexCommand).rejects(new Error("boom"));

    const { status } = await create({ "x-creator-key": CREATOR_KEY });

    expect(status).toBe(500);
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    expect(updates[1].ExpressionAttributeValues).toMatchObject({ ":minus": -1 });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("an existing index counts as created", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    vecMock.on(CreateIndexCommand).rejects(
      Object.assign(new Error("exists"), { name: "ConflictException" })
    );
    expect((await create({ "x-creator-key": CREATOR_KEY })).status).toBe(201);
  });

  test("rejects a missing name", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { status } = await create({ "x-creator-key": CREATOR_KEY }, {});
    expect(status).toBe(400);
  });
});

describe("POST /courses/{courseId}/documents", () => {
  const upload = (body: unknown, token = COURSE_TOKEN, courseId = COURSE_ID) =>
    call(
      event("POST /courses/{courseId}/documents", {
        headers: { "x-course-token": token },
        pathParameters: { courseId },
        body,
      })
    );

  test("records the document and returns a size-limited presigned POST", async () => {
    ddbMock.on(PutCommand).resolves({});

    const { status, body } = await upload({ filename: "Lecture 4.pdf", bytes: 123_456 });

    expect(status).toBe(201);
    expect(body.contentType).toBe("application/pdf");
    expect(body.upload.url).toContain("docs-bucket");
    expect(body.upload.fields["Content-Type"]).toBe("application/pdf");
    expect(body.upload.fields.key).toBe(`raw/default/${COURSE_ID}/${body.docId}.pdf`);

    const policy = JSON.parse(Buffer.from(body.upload.fields.Policy, "base64").toString("utf8"));
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ["content-length-range", 1, MAX_UPLOAD_BYTES],
        ["eq", "$Content-Type", "application/pdf"],
      ])
    );

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item).toMatchObject({
      SK: `DOC#${body.docId}`,
      status: "uploading",
      title: "Lecture 4",
      ext: "pdf",
    });
    // Abandoned uploads expire on their own.
    expect(put.Item?.ttl).toEqual(expect.any(Number));
  });

  test("slides get an export-to-PDF message", async () => {
    const { status, body } = await upload({ filename: "Week 3.pptx", bytes: 1000 });
    expect(status).toBe(415);
    expect(body.code).toBe("EXPORT_TO_PDF");
    expect(body.error).toMatch(/Export to PDF and re-upload/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("other types get a generic message", async () => {
    const { status, body } = await upload({ filename: "photo.png", bytes: 1000 });
    expect(status).toBe(415);
    expect(body.code).toBe("UNSUPPORTED_TYPE");
  });

  test("oversized files are refused up front", async () => {
    const { status, body } = await upload({ filename: "big.pdf", bytes: MAX_UPLOAD_BYTES + 1 });
    expect(status).toBe(413);
    expect(body.code).toBe("FILE_TOO_LARGE");
    expect(body.error).toMatch(/25 MB/);
  });

  test("text files have their own, smaller limit", async () => {
    const { status } = await upload({ filename: "notes.txt", bytes: 3 * 1024 * 1024 });
    expect(status).toBe(413);
  });

  test("a wrong token and an unknown course look identical", async () => {
    ddbMock.on(GetCommand, { Key: courseKey("default", "zzzzzzzzzzzz") }).resolves({});
    const wrongToken = await upload({ filename: "a.pdf", bytes: 1 }, "d".repeat(64));
    const unknown = await upload({ filename: "a.pdf", bytes: 1 }, COURSE_TOKEN, "zzzzzzzzzzzz");
    expect(wrongToken).toEqual(unknown);
    expect(wrongToken.status).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("a malformed course id is rejected before any read", async () => {
    const { status } = await upload({ filename: "a.pdf", bytes: 1 }, COURSE_TOKEN, "../etc");
    expect(status).toBe(400);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe("GET /courses/{courseId}/documents", () => {
  test("lists summaries newest first, without internal fields", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { docId: "a", title: "Old", filename: "old.pdf", status: "ready", bytes: 1, uploadedAt: 1, s3Key: "raw/x", ttl: 9 },
        { docId: "b", title: "New", filename: "new.pdf", status: "failed", failReason: "SCANNED_PDF", bytes: 2, uploadedAt: 2, s3Key: "raw/y" },
      ],
    });

    const { status, body } = await call(
      event("GET /courses/{courseId}/documents", {
        headers: { "x-course-token": COURSE_TOKEN },
        pathParameters: { courseId: COURSE_ID },
      })
    );

    expect(status).toBe(200);
    expect(body.corpusVersion).toBe(4);
    expect(body.documents.map((d: { docId: string }) => d.docId)).toEqual(["b", "a"]);
    expect(body.documents[0].failReason).toBe("SCANNED_PDF");
    expect(JSON.stringify(body)).not.toMatch(/s3Key|tokenHash|ttl/);
  });
});

describe("DELETE /courses/{courseId}/documents/{docId}", () => {
  const del = () =>
    call(
      event("DELETE /courses/{courseId}/documents/{docId}", {
        headers: { "x-course-token": COURSE_TOKEN },
        pathParameters: { courseId: COURSE_ID, docId: DOC_ID },
      })
    );

  test("removes vectors, the file and the row, and bumps the corpus version", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        orgId: "default",
        courseId: COURSE_ID,
        docId: DOC_ID,
        s3Key: `raw/default/${COURSE_ID}/${DOC_ID}.pdf`,
        status: "deleting",
        statusBeforeDelete: "ready",
        chunkCount: 3,
      },
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    vecMock.on(DeleteVectorsCommand).resolves({});

    const { status } = await del();

    expect(status).toBe(200);
    expect(vecMock.commandCalls(DeleteVectorsCommand)[0].args[0].input.keys).toEqual([
      `${DOC_ID}#0`,
      `${DOC_ID}#1`,
      `${DOC_ID}#2`,
    ]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
      `raw/default/${COURSE_ID}/${DOC_ID}.pdf`
    );
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Delete?.Key).toEqual(documentKey("default", COURSE_ID, DOC_ID));
    expect(items[1].Update?.UpdateExpression).toContain("corpusVersion");
  });

  test("a failed document is removed without touching the course counts", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        orgId: "default", courseId: COURSE_ID, docId: DOC_ID,
        s3Key: "raw/k", status: "deleting", statusBeforeDelete: "failed",
      },
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    expect((await del()).status).toBe(200);
    expect(vecMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems).toHaveLength(1);
  });

  test("a document mid-ingest can't be deleted yet", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand, { Key: documentKey("default", COURSE_ID, DOC_ID) }).resolves({
      Item: { status: "processing" },
    });
    const { status, body } = await del();
    expect(status).toBe(409);
    expect(body.code).toBe("DOCUMENT_BUSY");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  test("an unknown document is a 404", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand, { Key: documentKey("default", COURSE_ID, DOC_ID) }).resolves({});
    expect((await del()).status).toBe(404);
  });
});
