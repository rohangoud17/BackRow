/**
 * Server -> client push, and session fan-out.
 *
 * This is the Phase 1 fan-out implementation chosen in docs/adr/0001: query the
 * membership edges for a session and PostToConnection to each one, in parallel.
 * No Redis, because Redis is an always-on cost we haven't earned yet.
 *
 * When this stops meeting the latency budget — measure it in Phase 2 at 200-500
 * clients — the replacement is a Redis pub-sub fan-out behind this same
 * `fanOutToSession` signature, so callers don't change.
 *
 * The 410 Gone path matters: API Gateway drops idle sockets after 10 minutes
 * and caps any connection at 2 hours, so stale connection records are normal,
 * not exceptional. Every broadcast prunes the ones it discovers.
 */
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { encode, type ServerMessage } from "@backrow/shared";
import { listSessionConnections, pruneConnection } from "./ddb";

/** Reuse one management client per endpoint across warm invocations. */
const clients = new Map<string, ApiGatewayManagementApiClient>();

export function managementClient(
  endpoint: string
): ApiGatewayManagementApiClient {
  let c = clients.get(endpoint);
  if (!c) {
    c = new ApiGatewayManagementApiClient({ endpoint });
    clients.set(endpoint, c);
  }
  return c;
}

/** Build the management endpoint from the invoking request context. */
export const endpointFrom = (domainName: string, stage: string): string =>
  `https://${domainName}/${stage}`;

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

export type PushResult = "sent" | "gone" | "failed";

/**
 * Push one message to one connection.
 *
 * Returns "gone" for a 410 rather than throwing, because a disappeared client
 * is an expected condition on a WebSocket API, not an error.
 */
export async function pushTo(
  endpoint: string,
  connectionId: string,
  message: ServerMessage
): Promise<PushResult> {
  try {
    await managementClient(endpoint).send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(encode(message)),
      })
    );
    return "sent";
  } catch (err) {
    if (httpStatus(err) === 410) return "gone";
    console.error("PostToConnection failed", {
      connectionId,
      status: httpStatus(err),
      err,
    });
    return "failed";
  }
}

export interface FanOutResult {
  sent: number;
  pruned: number;
  failed: number;
}

/**
 * Send a message to every connection in a session.
 *
 * `exclude` skips a connection — normally the sender, so a client doesn't
 * receive its own echo.
 *
 * Sends run concurrently. At Phase 1 scale (one classroom) that's well within
 * a single Lambda's budget; the pagination in listSessionConnections plus this
 * concurrency is what the Phase 2 load test will actually stress.
 */
export async function fanOutToSession(params: {
  endpoint: string;
  sessionCode: string;
  message: ServerMessage;
  exclude?: string;
}): Promise<FanOutResult> {
  const { endpoint, sessionCode, message, exclude } = params;

  const members = await listSessionConnections(sessionCode);
  const targets = members.filter((m) => m.connectionId !== exclude);

  const results = await Promise.all(
    targets.map((m) => pushTo(endpoint, m.connectionId, message))
  );

  const gone = targets.filter((_, i) => results[i] === "gone");

  // Prune concurrently; failures here are non-fatal (TTL is the backstop).
  await Promise.all(
    gone.map((m) =>
      pruneConnection(sessionCode, m.connectionId).catch((err) =>
        console.error("prune failed", { connectionId: m.connectionId, err })
      )
    )
  );

  const result: FanOutResult = {
    sent: results.filter((r) => r === "sent").length,
    pruned: gone.length,
    failed: results.filter((r) => r === "failed").length,
  };

  if (result.pruned || result.failed) {
    console.log("fan-out completed with cleanup", { sessionCode, ...result });
  }
  return result;
}

/** Live connection count, used for the `joined`/`presence` messages. */
export async function memberCount(sessionCode: string): Promise<number> {
  return (await listSessionConnections(sessionCode)).length;
}
