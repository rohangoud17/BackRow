/**
 * $connect — a client opened a WebSocket.
 *
 * Deliberately minimal: record the connection and return 200 fast. A non-200
 * here refuses the handshake, so this is the worst possible place to do slow or
 * failure-prone work. The client is not yet associated with any session; that
 * happens when it sends a `join` message on $default.
 */
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";
import { putConnection } from "../lib/ddb";

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const { connectionId } = event.requestContext;

  try {
    await putConnection({ connectionId, nowMs: Date.now() });
  } catch (err) {
    // Refuse the connection rather than accept one we can't track — an
    // untracked connection can never be fanned out to or cleaned up.
    console.error("failed to record connection", { connectionId, err });
    return { statusCode: 500, body: "could not register connection" };
  }

  console.log("connected", { connectionId });
  return { statusCode: 200, body: "connected" };
}
