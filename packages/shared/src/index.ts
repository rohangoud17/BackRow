/**
 * @backrow/shared — the A<->B contract.
 *
 * This package is the single boundary both engineers code against: WebSocket
 * message shapes, DynamoDB item keys, and validation. Phase 0 seeds only the
 * minimum needed to prove the wiring; Phase 1 fills in the real message
 * contract (see docs/roadmap.md section 5, Phase 1).
 */

/** Direction: messages the client sends up to the server. */
export type ClientMessageType = "ping" | "join";

/** Direction: messages the server pushes down to clients. */
export type ServerMessageType = "pong" | "joined" | "error";

/** Base envelope every WebSocket frame shares. Keep frames well under the
 *  128 KB API Gateway payload cap (roadmap section 4). */
export interface Envelope<T extends string> {
  /** Message discriminator. */
  type: T;
  /** Client-generated id, echoed back so clients can correlate responses. */
  requestId?: string;
}

export interface PingMessage extends Envelope<"ping"> {
  type: "ping";
}

export interface JoinMessage extends Envelope<"join"> {
  type: "join";
  /** Short human-typed session code, e.g. "PULSE-482". */
  sessionCode: string;
}

export type ClientMessage = PingMessage | JoinMessage;

/** DynamoDB single-table key shape. PK/SK naming is the contract; entity
 *  types (CONNECTION, SESSION, ...) are namespaced in the PK. */
export interface TableKey {
  PK: string;
  SK: string;
}

export const connectionKey = (connectionId: string): TableKey => ({
  PK: `CONN#${connectionId}`,
  SK: `CONN#${connectionId}`,
});

export const sessionKey = (sessionCode: string): TableKey => ({
  PK: `SESSION#${sessionCode}`,
  SK: `SESSION#${sessionCode}`,
});

/** Narrow an unknown parsed frame to a ClientMessage. Real validation
 *  (zod or similar) lands in Phase 1; this is the seam it plugs into. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === "ping" || t === "join";
}
