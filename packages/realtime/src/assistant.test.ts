/**
 * askAssistant in the $default handler: admission checks, what gets written,
 * and what is handed to the answer Lambda. DynamoDB, Lambda and the management
 * API are mocked.
 *
 * The properties that matter most fail silently in production: a refusal that
 * still spends budget, question text leaking into the invoke payload or a log,
 * and a stored `clientId` that would link one student's questions across a term.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { sessionKey, connectionKey, askKey, utcDay } from "@backrow/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const lambdaMock = mockClient(LambdaClient);

import { handler } from "./handlers/message";

const SESSION = "ACDEFG";
const QUESTION = "What is the recurrence for the knapsack table?";

beforeAll(() => {
  process.env.TABLE_NAME = "backrow-test";
  process.env.ANSWER_FUNCTION_NAME = "backrow-test-answer";
  process.env.ASSISTANT_DAILY_LIMIT = "50";
});

let logs: string[];
beforeEach(() => {
  ddbMock.reset();
  apiMock.reset();
  lambdaMock.reset();
  apiMock.on(PostToConnectionCommand).resolves({});
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

const ask = (text = QUESTION, connectionId = "conn-1") =>
  handler(
    {
      requestContext: {
        routeKey: "$default",
        connectionId,
        domainName: "example.execute-api.us-east-1.amazonaws.com",
        stage: "dev",
      },
      body: JSON.stringify({ type: "askAssistant", text, requestId: "r1" }),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyWebsocketEventV2
  );

const pushed = () =>
  apiMock.commandCalls(PostToConnectionCommand).map((c) => ({
    connectionId: c.args[0].input.ConnectionId,
    body: JSON.parse(Buffer.from(c.args[0].input.Data as Uint8Array).toString()),
  }));

/** Stub the asker's connection and the session; `course` false means no course attached. */
function stub(course = true) {
  ddbMock.on(GetCommand, { Key: connectionKey("conn-1") }).resolves({
    Item: {
      entity: "connection",
      connectionId: "conn-1",
      sessionCode: SESSION,
      role: "audience",
      clientId: "client-abcdefgh",
      connectedAt: 1,
      ttl: 2,
    },
  });
  ddbMock.on(GetCommand, { Key: sessionKey(SESSION) }).resolves({
    Item: {
      entity: "session",
      sessionCode: SESSION,
      presenterToken: "t".repeat(64),
      state: "active",
      createdAt: 1,
      ttl: 2,
      ...(course ? { orgId: "default", courseId: "course123456" } : {}),
    },
  });
}

const conditionFailed = () =>
  Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

const updatesTo = (pkPrefix: string) =>
  ddbMock
    .commandCalls(UpdateCommand)
    .filter((c) => String(c.args[0].input.Key?.PK).startsWith(pkPrefix));

describe("askAssistant", () => {
  test("accepted: records the ask, invokes with ids only, replies to the asker alone", async () => {
    stub();
    await ask();

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item!;
    expect(item).toMatchObject({
      entity: "ask",
      sessionCode: SESSION,
      orgId: "default",
      courseId: "course123456",
      connectionId: "conn-1",
      text: QUESTION,
      status: "pending",
    });
    expect(item).toMatchObject(askKey(SESSION, item.queryId as string));
    // A stable client id would link one student's questions across sessions.
    expect(item).not.toHaveProperty("clientId");
    // 30 days, give or take the clock.
    expect((item.ttl as number) - Math.floor((item.askedAt as number) / 1000)).toBe(30 * 86400);

    const invokes = lambdaMock.commandCalls(InvokeCommand);
    expect(invokes).toHaveLength(1);
    expect(invokes[0].args[0].input).toMatchObject({
      FunctionName: "backrow-test-answer",
      InvocationType: "Event",
    });
    const payload = JSON.parse(Buffer.from(invokes[0].args[0].input.Payload as Uint8Array).toString());
    expect(payload).toEqual({ sessionCode: SESSION, queryId: item.queryId });

    expect(pushed()).toEqual([
      {
        connectionId: "conn-1",
        body: { type: "assistantAccepted", queryId: item.queryId, requestId: "r1" },
      },
    ]);
  });

  test("the daily budget is claimed against today's course counter with the configured cap", async () => {
    stub();
    await ask();
    const [budget] = updatesTo("ORG#default#COURSE#course123456#BUDGET#");
    expect(budget.args[0].input.Key).toEqual({
      PK: `ORG#default#COURSE#course123456#BUDGET#${utcDay(Date.now())}`,
      SK: "COUNT",
    });
    expect(budget.args[0].input.ExpressionAttributeValues).toMatchObject({ ":limit": 50 });
  });

  test("a session without a course gets ASSISTANT_UNAVAILABLE and spends nothing", async () => {
    stub(false);
    await ask();
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "ASSISTANT_UNAVAILABLE", requestId: "r1" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("a second ask inside the cooldown is RATE_LIMITED and spends no budget", async () => {
    stub();
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    await ask();
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    expect(updatesTo("ORG#")).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("the cooldown is per client, keyed off the session partition", async () => {
    stub();
    await ask();
    const [cool] = updatesTo("COOL#");
    expect(cool.args[0].input.Key).toEqual({
      PK: `COOL#${SESSION}#client-abcdefgh`,
      SK: "COOL#assist",
    });
  });

  test("an exhausted daily budget is ASSISTANT_BUSY and nothing is recorded or invoked", async () => {
    stub();
    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { Key: { PK: string } }) => {
        if (input.Key.PK.includes("#BUDGET#")) throw conditionFailed();
        return {};
      });
    await ask();
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "ASSISTANT_BUSY" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("not joined: NOT_JOINED, nothing else happens", async () => {
    ddbMock.on(GetCommand).resolves({});
    await ask();
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "NOT_JOINED" });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("questions over 500 characters are rejected before any read", async () => {
    stub();
    await ask("x".repeat(501));
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "BAD_REQUEST" });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test("a whitespace-only question is rejected", async () => {
    stub();
    await ask("    ");
    expect(pushed()[0].body).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  });

  test("no log line contains the question, on success or on failure", async () => {
    stub();
    await ask();
    // Fail the invoke with an error whose message echoes the request, as SDK
    // validation errors can.
    lambdaMock.on(InvokeCommand).rejects(Object.assign(new Error(`bad payload: ${QUESTION}`), { name: "InvalidRequestContentException" }));
    await ask();
    expect(pushed().at(-1)!.body).toMatchObject({ type: "error", code: "INTERNAL" });
    expect(logs.join("\n")).not.toContain("knapsack");
    expect(logs.join("\n")).toContain("InvalidRequestContentException");
  });
});
