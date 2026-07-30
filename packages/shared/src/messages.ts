/**
 * The WebSocket message contract — the A<->B interface.
 *
 * Both engineers code against this file. Schemas are defined once in Zod and
 * the TypeScript types are inferred from them, so a type and its runtime
 * validation can never drift apart.
 *
 * Every inbound frame is untrusted input arriving at a Lambda, so nothing is
 * consumed without passing through `parseClientMessage`.
 *
 * Frame size: API Gateway caps a WebSocket payload at 128 KB. Text fields are
 * bounded well below that. Phase 3's streamed assistant answers are chunked
 * rather than sent whole.
 */
import { z } from "zod";
import { CODE_ALPHABET, CODE_LENGTH } from "./session";

/** Max characters in a broadcast/question body. Keeps frames small. */
export const MAX_TEXT_LENGTH = 2000;

const sessionCodeSchema = z
  .string()
  .length(CODE_LENGTH)
  .refine((s) => [...s].every((c) => CODE_ALPHABET.includes(c)), {
    message: "contains characters outside the session-code alphabet",
  });

/** Client-generated id, echoed on the response so clients can correlate. */
const requestIdSchema = z.string().min(1).max(64).optional();

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Heartbeat. Clients send this every ~5 min; idle sockets drop after 10. */
export const pingSchema = z.object({
  type: z.literal("ping"),
  requestId: requestIdSchema,
});

/** Audience joining by code. */
export const joinSchema = z.object({
  type: z.literal("join"),
  sessionCode: sessionCodeSchema,
  /** Optional display name; absent means anonymous. */
  displayName: z.string().min(1).max(40).optional(),
  requestId: requestIdSchema,
});

/** Presenter attaching to their own session, proving it with the token. */
export const presenterJoinSchema = z.object({
  type: z.literal("presenterJoin"),
  sessionCode: sessionCodeSchema,
  presenterToken: z.string().min(1).max(128),
  requestId: requestIdSchema,
});

/**
 * Phase 1's proof-of-life message: whatever a joined client sends here is
 * fanned out to every other connection in the same session. Phase 2 replaces
 * it with typed poll/qa/reaction messages.
 */
export const broadcastSchema = z.object({
  type: z.literal("broadcast"),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  requestId: requestIdSchema,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  pingSchema,
  joinSchema,
  presenterJoinSchema,
  broadcastSchema,
]);

export type PingMessage = z.infer<typeof pingSchema>;
export type JoinMessage = z.infer<typeof joinSchema>;
export type PresenterJoinMessage = z.infer<typeof presenterJoinSchema>;
export type BroadcastMessage = z.infer<typeof broadcastSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Stable error codes so clients can branch without string matching. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "NOT_JOINED"
  | "FORBIDDEN"
  | "INTERNAL";

export interface PongMessage {
  type: "pong";
  serverTime: number;
  requestId?: string;
}

export interface JoinedMessage {
  type: "joined";
  sessionCode: string;
  state: "lobby" | "active" | "closed";
  role: "audience" | "presenter";
  /** Current connection count, so a reconnecting client can resync state. */
  memberCount: number;
  requestId?: string;
}

export interface RelayedMessage {
  type: "message";
  sessionCode: string;
  /** Sender's connectionId — opaque, but lets a client ignore its own echo. */
  from: string;
  fromRole: "audience" | "presenter";
  displayName?: string;
  text: string;
  sentAt: number;
}

export interface PresenceMessage {
  type: "presence";
  sessionCode: string;
  memberCount: number;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | PongMessage
  | JoinedMessage
  | RelayedMessage
  | PresenceMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

/**
 * Parse and validate a raw inbound frame.
 *
 * Never throws — a malformed frame is a client problem, not a 500. The caller
 * replies with an `error` message and keeps the socket open.
 */
export function parseClientMessage(raw: string | undefined): ParseResult {
  if (!raw) return { ok: false, error: "empty message body" };
  if (raw.length > MAX_TEXT_LENGTH * 2) {
    return { ok: false, error: "message too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }

  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    return {
      ok: false,
      error: path ? `${path}: ${first.message}` : (first?.message ?? "invalid message"),
    };
  }
  return { ok: true, message: result.data };
}

/** Serialize a server message for PostToConnection. */
export const encode = (message: ServerMessage): string =>
  JSON.stringify(message);

/** Build an error frame. */
export const errorMessage = (
  code: ErrorCode,
  message: string,
  requestId?: string
): ErrorMessage => ({ type: "error", code, message, requestId });
