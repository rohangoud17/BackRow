/**
 * Phase 0 placeholder Lambda.
 *
 * One function backs every wired route so `cdk deploy` produces a live,
 * end-to-end-reachable stack before any real logic exists:
 *   - WebSocket $connect / $disconnect / $default
 *   - HTTP GET /health
 *
 * It proves two things Phase 1 depends on:
 *   1. Config is readable from SSM Parameter Store (docs/adr/0001).
 *   2. The server can PUSH a message to a connected client via
 *      PostToConnection — the exact mechanism Phase 1 fan-out is built on,
 *      including the 410 Gone -> prune-the-connection path.
 *
 * Note: WebSocket APIs do NOT return a handler's return value to the client
 * unless BOTH a route response and an integration response are configured.
 * CDK's `returnResponse: true` only creates the former, so we push replies
 * explicitly instead. This is also what the real app will do.
 */
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyEventV2,
  Context,
} from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

/** Config resolved once per cold start. */
interface AppConfig {
  environment: string;
  tableName: string;
}

let cachedConfig: AppConfig | undefined;
const ssm = new SSMClient({});

/**
 * Resolve app config. Values are injected by CDK as env vars; the config
 * document is read from SSM Parameter Store to exercise the secrets path.
 */
async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  const environment = process.env.ENVIRONMENT ?? "unknown";
  const tableName = process.env.TABLE_NAME ?? "unknown";
  const paramName = process.env.CONFIG_PARAM_NAME;

  if (paramName) {
    try {
      const res = await ssm.send(
        new GetParameterCommand({ Name: paramName, WithDecryption: true })
      );
      console.log("Loaded config parameter", {
        paramName,
        hasValue: Boolean(res.Parameter?.Value),
      });
    } catch (err) {
      console.error("Failed to read config parameter", { paramName, err });
    }
  }

  cachedConfig = { environment, tableName };
  return cachedConfig;
}

/**
 * Push a message to a single WebSocket connection.
 *
 * Returns false when the connection is gone (410), which in Phase 1 is the
 * signal to delete that connectionId from DynamoDB.
 */
export async function postToConnection(
  endpoint: string,
  connectionId: string,
  payload: string
): Promise<boolean> {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(payload),
      })
    );
    return true;
  } catch (err) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
    if (status === 410) {
      console.log("Stale connection, prune it", { connectionId });
      return false;
    }
    throw err;
  }
}

function isWebsocketEvent(
  event: APIGatewayProxyWebsocketEventV2 | APIGatewayProxyEventV2
): event is APIGatewayProxyWebsocketEventV2 {
  return (
    (event as APIGatewayProxyWebsocketEventV2).requestContext?.connectionId !==
    undefined
  );
}

export async function handler(
  event: APIGatewayProxyWebsocketEventV2 | APIGatewayProxyEventV2,
  _context: Context
): Promise<APIGatewayProxyResult> {
  const config = await loadConfig();

  if (isWebsocketEvent(event)) {
    const { connectionId, routeKey, domainName, stage } = event.requestContext;
    console.log("WebSocket event", {
      routeKey,
      connectionId,
      env: config.environment,
    });

    // Only $default carries a client message worth replying to.
    if (routeKey === "$default") {
      const endpoint = `https://${domainName}/${stage}`;
      await postToConnection(endpoint, connectionId, `ok:${routeKey}`);
    }

    return { statusCode: 200, body: `ok:${routeKey}` };
  }

  // HTTP path — the /health stub.
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "ok",
      service: "backrow",
      environment: config.environment,
      phase: 0,
    }),
  };
}
