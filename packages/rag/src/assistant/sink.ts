/**
 * Where answer frames go: the asker's WebSocket connection in production, an
 * array in tests.
 *
 * Point-to-point by construction. The sink is bound to one connection id, so
 * nothing in the answer path is able to fan a reply out to the room.
 */
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { encode, type ServerMessage } from "@backrow/shared";

export type SendResult = "sent" | "gone" | "failed";

export interface AnswerSink {
  send(message: ServerMessage): Promise<SendResult>;
}

const clients = new Map<string, ApiGatewayManagementApiClient>();

export class WebSocketSink implements AnswerSink {
  private readonly client: ApiGatewayManagementApiClient;

  constructor(
    endpoint: string,
    private readonly connectionId: string
  ) {
    let c = clients.get(endpoint);
    if (!c) {
      c = new ApiGatewayManagementApiClient({ endpoint });
      clients.set(endpoint, c);
    }
    this.client = c;
  }

  async send(message: ServerMessage): Promise<SendResult> {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: this.connectionId,
          Data: Buffer.from(encode(message)),
        })
      );
      return "sent";
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      // The asker closed the tab or lost wifi. Expected, not an error.
      if (status === 410) return "gone";
      // Class and status only: the failed request body was answer text.
      console.warn("answer push failed", { name: (err as Error)?.name, status });
      return "failed";
    }
  }
}
