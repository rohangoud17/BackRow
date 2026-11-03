/**
 * HTTP session routes, focused on attaching a course: a missing or bad course
 * token must create nothing, and an unknown course must be indistinguishable
 * from a wrong token.
 */
import { createHash } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from "aws-lambda";
import { courseKey, sessionKey } from "@backrow/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);

// Imported after the mock is installed.
import { handler } from "./handlers/sessions";

const COURSE_ID = "abcdefghjkmn";
const COURSE_TOKEN = "c".repeat(64);
const tokenHash = createHash("sha256").update(COURSE_TOKEN).digest("hex");

const http = (method: string, path: string, body?: unknown): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  }) as unknown as APIGatewayProxyEventV2;

const call = async (e: APIGatewayProxyEventV2) => {
  const res = (await handler(e)) as APIGatewayProxyResult;
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

beforeAll(() => {
  process.env.TABLE_NAME = "backrow-test";
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(GetCommand, { Key: courseKey("default", COURSE_ID) }).resolves({
    Item: { tokenHash },
  });
});

const putItem = () => ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;

describe("POST /sessions", () => {
  test("no body still creates a plain session, as before", async () => {
    const { status, body } = await call(http("POST", "/sessions"));
    expect(status).toBe(201);
    expect(body.presenterToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.courseId).toBeUndefined();
    expect(putItem()).not.toHaveProperty("courseId");
  });

  test("a valid course token attaches the course", async () => {
    const { status, body } = await call(
      http("POST", "/sessions", { courseId: COURSE_ID, courseToken: COURSE_TOKEN })
    );
    expect(status).toBe(201);
    expect(body.courseId).toBe(COURSE_ID);
    expect(putItem()).toMatchObject({ orgId: "default", courseId: COURSE_ID });
    // The course token is checked, never stored on the session.
    expect(JSON.stringify(putItem())).not.toContain(COURSE_TOKEN);
  });

  test("a course without a token is refused and nothing is created", async () => {
    const { status, body } = await call(http("POST", "/sessions", { courseId: COURSE_ID }));
    expect(status).toBe(401);
    expect(body.code).toBe("COURSE_TOKEN_REQUIRED");
    expect(putItem()).toBeUndefined();
  });

  test("a wrong token and an unknown course get the same 403, and nothing is created", async () => {
    ddbMock.on(GetCommand, { Key: courseKey("default", "zzzzzzzzzzzz") }).resolves({});
    const wrong = await call(
      http("POST", "/sessions", { courseId: COURSE_ID, courseToken: "d".repeat(64) })
    );
    const unknown = await call(
      http("POST", "/sessions", { courseId: "zzzzzzzzzzzz", courseToken: COURSE_TOKEN })
    );
    expect(wrong).toEqual(unknown);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("INVALID_COURSE_TOKEN");
    expect(putItem()).toBeUndefined();
  });

  test("presenting the stored hash instead of the token does not work", async () => {
    const { status } = await call(
      http("POST", "/sessions", { courseId: COURSE_ID, courseToken: tokenHash })
    );
    expect(status).toBe(403);
  });

  test("malformed bodies are 400s", async () => {
    for (const body of ["{not json", { courseToken: COURSE_TOKEN }, { courseId: "BAD" }]) {
      const res = await call(http("POST", "/sessions", body));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
    }
    expect(putItem()).toBeUndefined();
  });
});

describe("GET /sessions/{code}", () => {
  test("reports whether the assistant is available, without the course id", async () => {
    ddbMock.on(GetCommand, { Key: sessionKey("ACDEFG") }).resolves({
      Item: { sessionCode: "ACDEFG", state: "lobby", createdAt: 1, courseId: COURSE_ID },
    });
    const { status, body } = await call(http("GET", "/sessions/ACDEFG"));
    expect(status).toBe(200);
    expect(body.assistant).toBe(true);
    expect(JSON.stringify(body)).not.toContain(COURSE_ID);
  });

  test("a session without a course has no assistant", async () => {
    ddbMock.on(GetCommand, { Key: sessionKey("ACDEFG") }).resolves({
      Item: { sessionCode: "ACDEFG", state: "lobby", createdAt: 1 },
    });
    expect((await call(http("GET", "/sessions/ACDEFG"))).body.assistant).toBe(false);
  });
});
