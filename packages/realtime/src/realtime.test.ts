/**
 * Unit tests for the Phase 1 realtime layer, with DynamoDB and the API Gateway
 * Management API mocked. These run in CI with no AWS account.
 *
 * The cases that matter most are the ones that fail silently in production:
 * fan-out excluding the sender, and the 410-Gone prune. A stale connection is
 * normal on a WebSocket API (10-minute idle drop, 2-hour hard cap), so if
 * pruning regresses, the connection table grows without any visible error.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import {
  sessionKey,
  connectionKey,
  membershipKey,
  pollKey,
  voteKey,
} from "@backrow/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);

// Imported after the mocks are installed.
import { handler as messageHandler } from "./handlers/message";
import { handler as connectHandler } from "./handlers/connect";
import { handler as disconnectHandler } from "./handlers/disconnect";
import { fanOutToSession, pushTo } from "./lib/broadcast";

const SESSION = "ACDEFG";
const TOKEN = "a".repeat(64);
const ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/dev";

beforeAll(() => {
  process.env.TABLE_NAME = "backrow-test";
});

beforeEach(() => {
  ddbMock.reset();
  apiMock.reset();
  apiMock.on(PostToConnectionCommand).resolves({});
});

/** Build a $default WebSocket event carrying a JSON body. */
const wsEvent = (
  body: unknown,
  connectionId = "conn-sender",
  routeKey = "$default"
): APIGatewayProxyWebsocketEventV2 =>
  ({
    requestContext: {
      routeKey,
      connectionId,
      domainName: "example.execute-api.us-east-1.amazonaws.com",
      stage: "dev",
      apiId: "example",
      eventType: routeKey === "$default" ? "MESSAGE" : "CONNECT",
      messageDirection: "IN",
      connectedAt: 1,
      requestTimeEpoch: 1,
      requestId: "r",
      messageId: "m",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyWebsocketEventV2;

/** Every message pushed to a client during a test. */
const pushed = () =>
  apiMock.commandCalls(PostToConnectionCommand).map((c) => ({
    connectionId: c.args[0].input.ConnectionId,
    body: JSON.parse(Buffer.from(c.args[0].input.Data as Uint8Array).toString()),
  }));

/** Stub a session lookup and a connection lookup. */
function stubSession(state: "lobby" | "active" | "closed" = "active") {
  ddbMock
    .on(GetCommand, { Key: sessionKey(SESSION) })
    .resolves({
      Item: {
        entity: "session",
        sessionCode: SESSION,
        presenterToken: TOKEN,
        state,
        createdAt: 1,
        ttl: 2,
      },
    });
}

function stubMembers(connectionIds: string[]) {
  ddbMock.on(QueryCommand).resolves({
    Items: connectionIds.map((connectionId) => ({
      entity: "membership",
      sessionCode: SESSION,
      connectionId,
      role: "audience",
      joinedAt: 1,
      ttl: 2,
    })),
  });
}

describe("pushTo", () => {
  test("reports 'gone' on 410 instead of throwing", async () => {
    apiMock.on(PostToConnectionCommand).rejects({
      name: "GoneException",
      $metadata: { httpStatusCode: 410 },
    });
    await expect(
      pushTo(ENDPOINT, "dead", { type: "presence", sessionCode: SESSION, memberCount: 0 })
    ).resolves.toBe("gone");
  });

  test("reports 'failed' on other errors without throwing", async () => {
    apiMock.on(PostToConnectionCommand).rejects({
      name: "InternalServerError",
      $metadata: { httpStatusCode: 500 },
    });
    await expect(
      pushTo(ENDPOINT, "x", { type: "presence", sessionCode: SESSION, memberCount: 0 })
    ).resolves.toBe("failed");
  });
});

describe("fanOutToSession", () => {
  test("delivers to every member and excludes the sender", async () => {
    stubMembers(["a", "b", "c"]);
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const result = await fanOutToSession({
      endpoint: ENDPOINT,
      sessionCode: SESSION,
      message: { type: "presence", sessionCode: SESSION, memberCount: 3 },
      exclude: "b",
    });

    expect(result).toEqual({ sent: 2, pruned: 0, failed: 0 });
    expect(pushed().map((p) => p.connectionId).sort()).toEqual(["a", "c"]);
  });

  test("prunes connections that return 410", async () => {
    stubMembers(["alive", "dead"]);
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    apiMock.on(PostToConnectionCommand).callsFake((input) => {
      if (input.ConnectionId === "dead") {
        return Promise.reject({
          name: "GoneException",
          $metadata: { httpStatusCode: 410 },
        });
      }
      return Promise.resolve({});
    });

    const result = await fanOutToSession({
      endpoint: ENDPOINT,
      sessionCode: SESSION,
      message: { type: "presence", sessionCode: SESSION, memberCount: 2 },
    });

    expect(result).toEqual({ sent: 1, pruned: 1, failed: 0 });

    // Both the membership edge and the connection record must be deleted.
    const deletedKeys = ddbMock
      .commandCalls(DeleteCommand)
      .map((c) => JSON.stringify(c.args[0].input.Key));
    expect(deletedKeys).toContain(JSON.stringify(membershipKey(SESSION, "dead")));
    expect(deletedKeys).toContain(JSON.stringify(connectionKey("dead")));
    // The live connection must be left alone.
    expect(deletedKeys).not.toContain(JSON.stringify(connectionKey("alive")));
  });

  test("follows pagination so large sessions aren't truncated", async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sessionCode: SESSION, connectionId: "p1", role: "audience" }],
        LastEvaluatedKey: { PK: "x", SK: "y" },
      })
      .resolves({
        Items: [{ sessionCode: SESSION, connectionId: "p2", role: "audience" }],
      });

    const result = await fanOutToSession({
      endpoint: ENDPOINT,
      sessionCode: SESSION,
      message: { type: "presence", sessionCode: SESSION, memberCount: 2 },
    });

    expect(result.sent).toBe(2);
  });
});

describe("$connect", () => {
  test("records the connection and accepts the handshake", async () => {
    ddbMock.on(PutCommand).resolves({});
    const res = await connectHandler(wsEvent("", "conn-1", "$connect"));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("refuses the handshake if the connection can't be recorded", async () => {
    ddbMock.on(PutCommand).rejects(new Error("table gone"));
    const res = await connectHandler(wsEvent("", "conn-1", "$connect"));
    // An untracked connection could never be broadcast to or cleaned up.
    expect(res.statusCode).toBe(500);
  });
});

describe("$disconnect", () => {
  test("removes the connection and its membership edge", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { entity: "connection", connectionId: "conn-1", sessionCode: SESSION },
    });
    ddbMock.on(DeleteCommand).resolves({});
    stubMembers([]);

    const res = await disconnectHandler(wsEvent("", "conn-1", "$disconnect"));

    expect(res.statusCode).toBe(200);
    const deleted = ddbMock
      .commandCalls(DeleteCommand)
      .map((c) => JSON.stringify(c.args[0].input.Key));
    expect(deleted).toContain(JSON.stringify(membershipKey(SESSION, "conn-1")));
    expect(deleted).toContain(JSON.stringify(connectionKey("conn-1")));
  });

  test("still returns 200 when cleanup fails", async () => {
    ddbMock.on(GetCommand).rejects(new Error("boom"));
    const res = await disconnectHandler(wsEvent("", "conn-1", "$disconnect"));
    // There's no client left to tell, and a 5xx would pollute error alarms.
    expect(res.statusCode).toBe(200);
  });
});

describe("$default routing", () => {
  test("ping gets a pong", async () => {
    await messageHandler(wsEvent({ type: "ping", requestId: "r1" }));
    const msgs = pushed();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body.type).toBe("pong");
    expect(msgs[0].body.requestId).toBe("r1");
  });

  test("malformed JSON gets BAD_REQUEST, not a 500", async () => {
    const res = await messageHandler(wsEvent("not json"));
    expect(res.statusCode).toBe(200);
    expect(pushed()[0].body).toMatchObject({
      type: "error",
      code: "BAD_REQUEST",
    });
  });

  test("unknown message type gets BAD_REQUEST", async () => {
    await messageHandler(wsEvent({ type: "definitely-not-a-thing" }));
    expect(pushed()[0].body.code).toBe("BAD_REQUEST");
  });

  test("join to a missing session gets SESSION_NOT_FOUND", async () => {
    ddbMock.on(GetCommand).resolves({});
    await messageHandler(wsEvent({ type: "join", sessionCode: SESSION }));
    expect(pushed()[0].body.code).toBe("SESSION_NOT_FOUND");
  });

  test("join to a closed session is rejected", async () => {
    stubSession("closed");
    await messageHandler(wsEvent({ type: "join", sessionCode: SESSION }));
    expect(pushed()[0].body.code).toBe("SESSION_CLOSED");
  });

  test("audience join succeeds and reports member count", async () => {
    stubSession("active");
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    stubMembers(["conn-sender", "other"]);

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, displayName: "Rohan" })
    );

    const joined = pushed().find((p) => p.body.type === "joined");
    expect(joined?.body).toMatchObject({
      type: "joined",
      sessionCode: SESSION,
      role: "audience",
      memberCount: 2,
    });

    // Everyone else is told the count changed; the joiner isn't double-notified.
    const presence = pushed().filter((p) => p.body.type === "presence");
    expect(presence.map((p) => p.connectionId)).toEqual(["other"]);
  });

  test("an absent displayName is REMOVEd, never stored as null", async () => {
    stubSession("active");
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    stubMembers(["conn-sender"]);

    await messageHandler(wsEvent({ type: "join", sessionCode: SESSION }));

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toContain("REMOVE displayName");
    // Storing null would leak `"displayName": null` onto the wire, which
    // contradicts the `displayName?: string` contract.
    expect(JSON.stringify(update.ExpressionAttributeValues)).not.toContain(
      "null"
    );
  });

  test("a present displayName is stored normally", async () => {
    stubSession("active");
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    stubMembers(["conn-sender"]);

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, displayName: "Rohan" })
    );

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    // displayName is SET, not REMOVEd. (clientId is separately REMOVEd here,
    // since this join didn't supply one — that's correct and unrelated.)
    expect(update.UpdateExpression).toContain("displayName = :d");
    expect(update.UpdateExpression).not.toMatch(/REMOVE[^]*displayName/);
    expect(update.ExpressionAttributeValues?.[":d"]).toBe("Rohan");
  });

  test("relayed message omits displayName rather than sending null", async () => {
    ddbMock.on(GetCommand, { Key: connectionKey("conn-sender") }).resolves({
      // Simulate a row written before the fix, holding an explicit null.
      Item: {
        entity: "connection",
        connectionId: "conn-sender",
        sessionCode: SESSION,
        role: "audience",
        displayName: null,
      },
    });
    ddbMock.on(DeleteCommand).resolves({});
    stubMembers(["peer-1"]);

    await messageHandler(wsEvent({ type: "broadcast", text: "hi" }));

    const relayed = pushed().find((p) => p.body.type === "message");
    expect(relayed?.body).not.toHaveProperty("displayName");
  });

  test("presenterJoin with a wrong token is FORBIDDEN", async () => {
    stubSession("active");
    await messageHandler(
      wsEvent({
        type: "presenterJoin",
        sessionCode: SESSION,
        presenterToken: "b".repeat(64),
      })
    );
    expect(pushed()[0].body.code).toBe("FORBIDDEN");
    // Must not have been recorded as a presenter.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("presenterJoin with the right token succeeds", async () => {
    stubSession("active");
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    stubMembers(["conn-sender"]);

    await messageHandler(
      wsEvent({
        type: "presenterJoin",
        sessionCode: SESSION,
        presenterToken: TOKEN,
      })
    );

    expect(pushed().find((p) => p.body.type === "joined")?.body.role).toBe(
      "presenter"
    );
  });

  test("broadcast before joining gets NOT_JOINED", async () => {
    ddbMock.on(GetCommand, { Key: connectionKey("conn-sender") }).resolves({
      Item: { entity: "connection", connectionId: "conn-sender" },
    });
    await messageHandler(wsEvent({ type: "broadcast", text: "hi" }));
    expect(pushed()[0].body.code).toBe("NOT_JOINED");
  });

  test("broadcast after joining reaches other members only", async () => {
    ddbMock.on(GetCommand, { Key: connectionKey("conn-sender") }).resolves({
      Item: {
        entity: "connection",
        connectionId: "conn-sender",
        sessionCode: SESSION,
        role: "audience",
        displayName: "Rohan",
      },
    });
    ddbMock.on(DeleteCommand).resolves({});
    stubMembers(["conn-sender", "peer-1", "peer-2"]);

    await messageHandler(wsEvent({ type: "broadcast", text: "hello room" }));

    const relayed = pushed().filter((p) => p.body.type === "message");
    expect(relayed.map((p) => p.connectionId).sort()).toEqual([
      "peer-1",
      "peer-2",
    ]);
    expect(relayed[0].body).toMatchObject({
      text: "hello room",
      from: "conn-sender",
      fromRole: "audience",
      displayName: "Rohan",
    });
  });

  test("a session code on the message body cannot override the joined session", async () => {
    // Guards against a client claiming membership in someone else's session.
    ddbMock.on(GetCommand, { Key: connectionKey("conn-sender") }).resolves({
      Item: {
        entity: "connection",
        connectionId: "conn-sender",
        sessionCode: SESSION,
        role: "audience",
      },
    });
    ddbMock.on(DeleteCommand).resolves({});
    stubMembers(["peer-1"]);

    await messageHandler(
      wsEvent({ type: "broadcast", text: "x", sessionCode: "XXXXXX" })
    );

    const queried = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(
      (queried.ExpressionAttributeValues as Record<string, string>)[":pk"]
    ).toBe(sessionKey(SESSION).PK);
  });
});

/**
 * Poll tests.
 *
 * The cases that matter are the ones that fail quietly: a second vote being
 * counted, an audience member driving the poll, and the debounce silently
 * dropping the final tally.
 */
describe("polls", () => {
  const POLL = "poll-1";
  const CONDITIONAL_FAIL = { name: "ConditionalCheckFailedException" };

  /** Make requireMember() see a joined connection. */
  function stubMember(opts: {
    role?: "audience" | "presenter";
    clientId?: string;
  } = {}) {
    ddbMock.on(GetCommand, { Key: connectionKey("conn-sender") }).resolves({
      Item: {
        entity: "connection",
        connectionId: "conn-sender",
        sessionCode: SESSION,
        role: opts.role ?? "audience",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
      },
    });
  }

  function stubPoll(state: "draft" | "open" | "closed") {
    ddbMock.on(GetCommand, { Key: pollKey(SESSION, POLL) }).resolves({
      Item: {
        entity: "poll",
        pollId: POLL,
        sessionCode: SESSION,
        question: "Which one?",
        options: ["A", "B", "C"],
        state,
        createdAt: 1,
        ttl: 2,
      },
    });
  }

  /** Shard items carry top-level c0..c7 counters. */
  function stubTally(shards: Record<string, number>[]) {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { "backrow-test": shards.map((s) => ({ entity: "tally", ...s })) },
    });
  }

  beforeEach(() => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    stubMembers(["conn-sender", "peer-1"]);
  });

  describe("authorization", () => {
    test("an audience member cannot create a poll", async () => {
      stubMember({ role: "audience" });
      await messageHandler(
        wsEvent({ type: "createPoll", question: "Q", options: ["A", "B"] })
      );
      expect(pushed()[0].body.code).toBe("FORBIDDEN");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("an audience member cannot launch or close a poll", async () => {
      stubMember({ role: "audience" });
      stubPoll("draft");
      await messageHandler(wsEvent({ type: "launchPoll", pollId: POLL }));
      expect(pushed()[0].body.code).toBe("FORBIDDEN");
    });

    test("an audience member cannot change session state", async () => {
      stubMember({ role: "audience" });
      await messageHandler(wsEvent({ type: "setSessionState", state: "closed" }));
      expect(pushed()[0].body.code).toBe("FORBIDDEN");
    });

    test("the presenter can create a poll", async () => {
      stubMember({ role: "presenter" });
      await messageHandler(
        wsEvent({ type: "createPoll", question: "Which one?", options: ["A", "B"] })
      );
      const poll = pushed().find((p) => p.body.type === "poll");
      expect(poll?.body).toMatchObject({ state: "draft", question: "Which one?" });
    });

    test("a draft poll is not revealed to the room", async () => {
      stubMember({ role: "presenter" });
      await messageHandler(
        wsEvent({ type: "createPoll", question: "Q", options: ["A", "B"] })
      );
      // Only the author sees it; the audience shouldn't see a question the
      // presenter hasn't launched yet.
      expect(pushed().map((p) => p.connectionId)).toEqual(["conn-sender"]);
    });
  });

  describe("voting", () => {
    test("rejects a vote on a poll that isn't open", async () => {
      stubMember();
      stubPoll("draft");
      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 0 })
      );
      expect(pushed()[0].body.code).toBe("POLL_NOT_OPEN");
    });

    test("rejects a vote on a closed poll", async () => {
      stubMember();
      stubPoll("closed");
      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 0 })
      );
      expect(pushed()[0].body.code).toBe("POLL_NOT_OPEN");
    });

    test("rejects an option index past the end of the poll", async () => {
      stubMember();
      stubPoll("open");
      // Schema allows 0..7; this poll only has 3 options.
      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 5 })
      );
      expect(pushed()[0].body.code).toBe("BAD_REQUEST");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("a second vote is rejected, not counted", async () => {
      stubMember();
      stubPoll("open");
      // The conditional put on the per-voter row is what enforces this.
      ddbMock.on(PutCommand).rejects(CONDITIONAL_FAIL);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 1 })
      );

      expect(pushed()[0].body.code).toBe("ALREADY_VOTED");
      // Critically, no tally increment happened.
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("uses clientId as voter identity so a reconnect can't vote twice", async () => {
      stubMember({ clientId: "browser-abc" });
      stubPoll("open");
      stubTally([{ c1: 1 }]);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 1 })
      );

      const voteRow = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as {
        SK: string;
      };
      // connectionId changes on every reconnect; clientId does not.
      expect(voteRow.SK).toBe("VOTE#browser-abc");
      expect(voteRow.SK).not.toContain("conn-sender");
    });

    test("falls back to connectionId when no clientId was supplied", async () => {
      stubMember();
      stubPoll("open");
      stubTally([{ c0: 1 }]);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 0 })
      );

      const voteRow = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as {
        SK: string;
      };
      expect(voteRow.SK).toBe("VOTE#conn-sender");
    });

    test("increments a tally shard, never a counter on the poll item", async () => {
      stubMember();
      stubPoll("open");
      stubTally([{ c2: 1 }]);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 2 })
      );

      const tallyWrite = ddbMock
        .commandCalls(UpdateCommand)
        .map((c) => c.args[0].input)
        .find((i) => String(i.UpdateExpression).startsWith("ADD"));

      expect(tallyWrite).toBeDefined();
      // The ADD target must be a top-level attribute. A nested path like
      // `counts.c2` throws ValidationException on a shard's first vote,
      // because ADD cannot create the missing parent map.
      expect(tallyWrite!.UpdateExpression).not.toContain("counts.");
      expect(
        (tallyWrite!.ExpressionAttributeNames as Record<string, string>)["#opt"]
      ).toBe("c2");
      // A counter on the poll item would serialize every vote in the lecture
      // onto one DynamoDB item.
      const pk = (tallyWrite!.Key as { PK: string }).PK;
      expect(pk).toMatch(/^POLL#poll-1#S#\d+$/);
      expect(pk).not.toBe(pollKey(SESSION, POLL).PK);
    });

    test("broadcasts live results when it wins the debounce claim", async () => {
      stubMember();
      stubPoll("open");
      stubTally([{ c0: 3 }, { c1: 2 }]);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 0 })
      );

      const results = pushed().find((p) => p.body.type === "pollResults");
      expect(results?.body).toMatchObject({
        counts: [3, 2, 0],
        totalVotes: 5,
        final: false,
      });
    });

    test("skips the results broadcast when another invocation holds the window", async () => {
      stubMember();
      stubPoll("open");
      ddbMock
        .on(UpdateCommand, { UpdateExpression: "SET lastBroadcastAt = :now" })
        .rejects(CONDITIONAL_FAIL);

      await messageHandler(
        wsEvent({ type: "vote", pollId: POLL, optionIndex: 0 })
      );

      // The vote still counted; only the push was suppressed. Without this,
      // 300 votes would mean 300 fan-outs to 300 clients.
      expect(pushed().filter((p) => p.body.type === "pollResults")).toHaveLength(0);
      expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
    });
  });

  describe("closing", () => {
    test("final results are broadcast unconditionally, bypassing the debounce", async () => {
      stubMember({ role: "presenter" });
      stubPoll("open");
      stubTally([{ c0: 7 }, { c2: 1 }]);
      ddbMock
        .on(UpdateCommand, { UpdateExpression: "SET lastBroadcastAt = :now" })
        .rejects(CONDITIONAL_FAIL);

      await messageHandler(wsEvent({ type: "closePoll", pollId: POLL }));

      const results = pushed().find((p) => p.body.type === "pollResults");
      // The rate limiter must never be able to swallow the final number.
      expect(results?.body).toMatchObject({
        counts: [7, 0, 1],
        totalVotes: 8,
        final: true,
        state: "closed",
      });
    });

    test("a missing poll reports POLL_NOT_FOUND", async () => {
      stubMember({ role: "presenter" });
      ddbMock.on(GetCommand, { Key: pollKey(SESSION, POLL) }).resolves({});
      await messageHandler(wsEvent({ type: "closePoll", pollId: POLL }));
      expect(pushed()[0].body.code).toBe("POLL_NOT_FOUND");
    });
  });

  describe("session lifecycle", () => {
    test("presenter can move lobby to active, and the room is told", async () => {
      stubMember({ role: "presenter" });
      stubSession("lobby");
      await messageHandler(wsEvent({ type: "setSessionState", state: "active" }));

      const state = pushed().find((p) => p.body.type === "sessionState");
      expect(state?.body).toMatchObject({ state: "active" });
    });

    test("cannot reopen a closed session", async () => {
      stubMember({ role: "presenter" });
      stubSession("closed");
      await messageHandler(wsEvent({ type: "setSessionState", state: "active" }));

      expect(pushed()[0].body.code).toBe("INVALID_TRANSITION");
      // Must not have attempted the write at all.
      expect(
        ddbMock
          .commandCalls(UpdateCommand)
          .filter((c) => String(c.args[0].input.UpdateExpression).includes("SET #s"))
      ).toHaveLength(0);
    });
  });
});

/**
 * Rejoin / late-join snapshot.
 *
 * Poll state lives only in client memory, so without a snapshot on join a
 * reload — or any student arriving after the poll opened — sees nothing at all
 * while a poll is live. Nothing errors, which is what makes it easy to miss.
 */
describe("poll snapshot on join", () => {
  const POLL = "poll-9";

  function stubJoinable() {
    stubSession("active");
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    stubMembers(["conn-sender"]);
  }

  /** listPolls uses Query on the session partition; membership does too. */
  function stubSessionPolls(polls: unknown[], members: string[] = ["conn-sender"]) {
    ddbMock.on(QueryCommand).callsFake((input) => {
      const sk = input.ExpressionAttributeValues?.[":sk"];
      if (sk === "POLL#") return Promise.resolve({ Items: polls });
      return Promise.resolve({
        Items: members.map((connectionId) => ({
          entity: "membership", sessionCode: SESSION, connectionId, role: "audience",
        })),
      });
    });
  }

  const openPoll = {
    entity: "poll", pollId: POLL, sessionCode: SESSION,
    question: "Which?", options: ["A", "B"], state: "open", createdAt: 10, ttl: 2,
  };

  test("an audience member joining mid-poll receives it with the live tally", async () => {
    stubJoinable();
    stubSessionPolls([openPoll]);
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { "backrow-test": [{ entity: "tally", c0: 4 }, { entity: "tally", c1: 2 }] },
    });
    ddbMock.on(GetCommand, { Key: voteKey(POLL, "browser-x") }).resolves({});

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, clientId: "browser-x" })
    );

    const poll = pushed().find((p) => p.body.type === "poll");
    expect(poll?.body).toMatchObject({ pollId: POLL, state: "open" });

    const results = pushed().find((p) => p.body.type === "pollResults");
    expect(results?.body).toMatchObject({ counts: [4, 2], totalVotes: 6 });

    // Snapshot goes to the joiner only — it must not be fanned out.
    expect(poll?.connectionId).toBe("conn-sender");
  });

  test("a rejoining voter is told they already voted, and for what", async () => {
    stubJoinable();
    stubSessionPolls([openPoll]);
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { "backrow-test": [{ entity: "tally", c1: 1 }] },
    });
    // Same clientId as before the reload — this is the whole point of it.
    ddbMock.on(GetCommand, { Key: voteKey(POLL, "browser-x") }).resolves({
      Item: { entity: "vote", pollId: POLL, voterId: "browser-x", optionIndex: 1 },
    });

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, clientId: "browser-x" })
    );

    const ack = pushed().find((p) => p.body.type === "voteAccepted");
    // Carries the actual option, so the UI can show what they picked rather
    // than just that they picked something.
    expect(ack?.body).toMatchObject({ pollId: POLL, optionIndex: 1 });
  });

  test("a draft poll is never sent to an audience member", async () => {
    stubJoinable();
    stubSessionPolls([{ ...openPoll, state: "draft" }]);

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, clientId: "browser-x" })
    );

    expect(pushed().find((p) => p.body.type === "poll")).toBeUndefined();
  });

  test("a presenter does get their own draft back after a reload", async () => {
    stubJoinable();
    stubSessionPolls([{ ...openPoll, state: "draft" }]);

    await messageHandler(
      wsEvent({
        type: "presenterJoin",
        sessionCode: SESSION,
        presenterToken: TOKEN,
        clientId: "browser-p",
      })
    );

    const poll = pushed().find((p) => p.body.type === "poll");
    expect(poll?.body).toMatchObject({ state: "draft" });
    // No tally for a draft — there are no votes yet.
    expect(pushed().find((p) => p.body.type === "pollResults")).toBeUndefined();
  });

  test("an open poll wins over a more recent closed one", async () => {
    stubJoinable();
    stubSessionPolls([
      { ...openPoll, pollId: "older-open", createdAt: 1, state: "open" },
      { ...openPoll, pollId: "newer-closed", createdAt: 99, state: "closed" },
    ]);
    ddbMock.on(BatchGetCommand).resolves({ Responses: { "backrow-test": [] } });
    ddbMock.on(GetCommand, { Key: voteKey("older-open", "browser-x") }).resolves({});

    await messageHandler(
      wsEvent({ type: "join", sessionCode: SESSION, clientId: "browser-x" })
    );

    expect(pushed().find((p) => p.body.type === "poll")?.body.pollId)
      .toBe("older-open");
  });

  test("a failed snapshot does not fail the join", async () => {
    stubJoinable();
    ddbMock.on(QueryCommand).callsFake((input) => {
      const sk = input.ExpressionAttributeValues?.[":sk"];
      if (sk === "POLL#") return Promise.reject(new Error("query blew up"));
      return Promise.resolve({ Items: [] });
    });

    await messageHandler(wsEvent({ type: "join", sessionCode: SESSION }));

    // Being in the session matters more than seeing the poll immediately.
    expect(pushed().find((p) => p.body.type === "joined")).toBeDefined();
    expect(pushed().find((p) => p.body.type === "error")).toBeUndefined();
  });
});
