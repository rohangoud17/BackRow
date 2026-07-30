/**
 * $disconnect — the socket closed.
 *
 * Best-effort by nature: API Gateway does not guarantee this fires (a hard
 * network drop may never deliver it), which is exactly why the 410-Gone prune
 * during broadcast and the item TTL both exist. This handler is the fast path,
 * not the only path.
 *
 * Always returns 200. There is no client left to receive an error, and a
 * non-200 only produces noise in the metrics.
 */
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";
import { getConnection, removeConnection } from "../lib/ddb";
import { fanOutToSession, endpointFrom, memberCount } from "../lib/broadcast";

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const { connectionId, domainName, stage } = event.requestContext;

  try {
    const existing = await getConnection(connectionId);
    const sessionCode = existing?.sessionCode;

    await removeConnection(connectionId);
    console.log("disconnected", { connectionId, sessionCode });

    // Tell the rest of the session the count changed, so a presenter's
    // attendee number doesn't drift upward all lecture.
    if (sessionCode) {
      await fanOutToSession({
        endpoint: endpointFrom(domainName, stage),
        sessionCode,
        message: {
          type: "presence",
          sessionCode,
          memberCount: await memberCount(sessionCode),
        },
        exclude: connectionId,
      });
    }
  } catch (err) {
    console.error("disconnect cleanup failed", { connectionId, err });
  }

  return { statusCode: 200, body: "disconnected" };
}
