/**
 * $default — every inbound client message.
 *
 * Routes on the validated message type. Four cases in Phase 1:
 *   ping          -> pong (the heartbeat that keeps a socket off the 10-min idle timeout)
 *   join          -> attach this connection to a session as audience
 *   presenterJoin -> same, as presenter, proving ownership with the token
 *   broadcast     -> fan out to everyone else in the sender's session
 *
 * Replies are pushed with PostToConnection, never returned. API Gateway only
 * returns a handler's value to the client when both a route response and an
 * integration response exist, and CDK's `returnResponse` only creates the
 * former — see docs/adr/0001.
 *
 * Always returns 200 to API Gateway. A client error is reported to the client
 * as an `error` frame; surfacing it as a 5xx would pollute the Lambda error
 * metrics we alarm on in Phase 4.
 */
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";
import {
  parseClientMessage,
  errorMessage,
  safeEqual,
  type ClientMessage,
  type ServerMessage,
  type Role,
} from "@backrow/shared";
import { getConnection, getSession, joinSession } from "../lib/ddb";
import {
  pushTo,
  fanOutToSession,
  endpointFrom,
  memberCount,
} from "../lib/broadcast";

const OK: APIGatewayProxyResult = { statusCode: 200, body: "ok" };

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = endpointFrom(domainName, stage);
  const reply = (m: ServerMessage) => pushTo(endpoint, connectionId, m);

  const parsed = parseClientMessage(event.body);
  if (!parsed.ok) {
    await reply(errorMessage("BAD_REQUEST", parsed.error));
    return OK;
  }

  try {
    await route(parsed.message, { connectionId, endpoint, reply });
  } catch (err) {
    console.error("handler failed", {
      connectionId,
      type: parsed.message.type,
      err,
    });
    await reply(
      errorMessage("INTERNAL", "something went wrong", parsed.message.requestId)
    );
  }

  return OK;
}

interface Ctx {
  connectionId: string;
  endpoint: string;
  reply: (m: ServerMessage) => Promise<unknown>;
}

async function route(message: ClientMessage, ctx: Ctx): Promise<void> {
  switch (message.type) {
    case "ping":
      await ctx.reply({
        type: "pong",
        serverTime: Date.now(),
        requestId: message.requestId,
      });
      return;

    case "join":
      await handleJoin(
        {
          sessionCode: message.sessionCode,
          displayName: message.displayName,
          requestId: message.requestId,
          role: "audience",
        },
        ctx
      );
      return;

    case "presenterJoin":
      await handleJoin(
        {
          sessionCode: message.sessionCode,
          presenterToken: message.presenterToken,
          requestId: message.requestId,
          role: "presenter",
        },
        ctx
      );
      return;

    case "broadcast":
      await handleBroadcast(message.text, message.requestId, ctx);
      return;
  }
}

async function handleJoin(
  params: {
    sessionCode: string;
    role: Role;
    displayName?: string;
    presenterToken?: string;
    requestId?: string;
  },
  ctx: Ctx
): Promise<void> {
  const { sessionCode, role, displayName, presenterToken, requestId } = params;

  const session = await getSession(sessionCode);
  if (!session) {
    await ctx.reply(
      errorMessage("SESSION_NOT_FOUND", "no session with that code", requestId)
    );
    return;
  }
  if (session.state === "closed") {
    await ctx.reply(
      errorMessage("SESSION_CLOSED", "this session has ended", requestId)
    );
    return;
  }

  // Presenter claims are only honored with the token handed out at creation.
  if (role === "presenter") {
    if (!presenterToken || !safeEqual(presenterToken, session.presenterToken)) {
      await ctx.reply(
        errorMessage("FORBIDDEN", "invalid presenter token", requestId)
      );
      return;
    }
  }

  await joinSession({
    connectionId: ctx.connectionId,
    sessionCode,
    role,
    displayName,
    nowMs: Date.now(),
  });

  const count = await memberCount(sessionCode);

  await ctx.reply({
    type: "joined",
    sessionCode,
    state: session.state,
    role,
    memberCount: count,
    requestId,
  });

  // Let everyone else update their attendee count.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: { type: "presence", sessionCode, memberCount: count },
    exclude: ctx.connectionId,
  });

  console.log("joined", { connectionId: ctx.connectionId, sessionCode, role });
}

async function handleBroadcast(
  text: string,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  // The connection record is the source of truth for which session this socket
  // belongs to — never trust a session code supplied on the message itself.
  const conn = await getConnection(ctx.connectionId);
  if (!conn?.sessionCode || !conn.role) {
    await ctx.reply(
      errorMessage("NOT_JOINED", "join a session before sending", requestId)
    );
    return;
  }

  const result = await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode: conn.sessionCode,
    message: {
      type: "message",
      sessionCode: conn.sessionCode,
      from: ctx.connectionId,
      fromRole: conn.role,
      // `?? undefined` so JSON.stringify omits the key entirely rather than
      // emitting null, for any row written before the REMOVE fix above.
      displayName: conn.displayName ?? undefined,
      text,
      sentAt: Date.now(),
    },
    exclude: ctx.connectionId,
  });

  console.log("broadcast", {
    sessionCode: conn.sessionCode,
    from: ctx.connectionId,
    ...result,
  });
}
