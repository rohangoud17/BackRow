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
import {
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  MAX_POLL_QUESTION,
  MAX_POLL_OPTION,
} from "./poll";

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

/**
 * A stable per-browser id the client generates once and persists.
 *
 * connectionId can't serve as voter identity: it changes on every reconnect,
 * and reconnects are routine (10-minute idle drop, 2-hour cap). A student who
 * lost wifi could otherwise vote twice, entirely by accident.
 */
const clientIdSchema = z.string().min(8).max(64).optional();

/** Audience joining by code. */
export const joinSchema = z.object({
  type: z.literal("join"),
  sessionCode: sessionCodeSchema,
  /** Optional display name; absent means anonymous. */
  displayName: z.string().min(1).max(40).optional(),
  clientId: clientIdSchema,
  requestId: requestIdSchema,
});

/** Presenter attaching to their own session, proving it with the token. */
export const presenterJoinSchema = z.object({
  type: z.literal("presenterJoin"),
  sessionCode: sessionCodeSchema,
  presenterToken: z.string().min(1).max(128),
  clientId: clientIdSchema,
  requestId: requestIdSchema,
});

// --- polls -----------------------------------------------------------------

/** Presenter drafts a poll. It is not votable until launched. */
export const createPollSchema = z.object({
  type: z.literal("createPoll"),
  question: z.string().min(1).max(MAX_POLL_QUESTION),
  options: z
    .array(z.string().min(1).max(MAX_POLL_OPTION))
    .min(MIN_POLL_OPTIONS)
    .max(MAX_POLL_OPTIONS),
  requestId: requestIdSchema,
});

/** Presenter opens a poll for voting. */
export const launchPollSchema = z.object({
  type: z.literal("launchPoll"),
  pollId: z.string().min(1).max(64),
  requestId: requestIdSchema,
});

/** Presenter closes voting and broadcasts the final tally. */
export const closePollSchema = z.object({
  type: z.literal("closePoll"),
  pollId: z.string().min(1).max(64),
  requestId: requestIdSchema,
});

/** One vote. The server rejects a second one from the same voter. */
export const voteSchema = z.object({
  type: z.literal("vote"),
  pollId: z.string().min(1).max(64),
  optionIndex: z.number().int().min(0).max(MAX_POLL_OPTIONS - 1),
  requestId: requestIdSchema,
});

/** Presenter moves the session through its lifecycle. */
export const setSessionStateSchema = z.object({
  type: z.literal("setSessionState"),
  state: z.enum(["lobby", "active", "closed"]),
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
  createPollSchema,
  launchPollSchema,
  closePollSchema,
  voteSchema,
  setSessionStateSchema,
]);

export type PingMessage = z.infer<typeof pingSchema>;
export type JoinMessage = z.infer<typeof joinSchema>;
export type PresenterJoinMessage = z.infer<typeof presenterJoinSchema>;
export type BroadcastMessage = z.infer<typeof broadcastSchema>;
export type CreatePollMessage = z.infer<typeof createPollSchema>;
export type LaunchPollMessage = z.infer<typeof launchPollSchema>;
export type ClosePollMessage = z.infer<typeof closePollSchema>;
export type VoteMessage = z.infer<typeof voteSchema>;
export type SetSessionStateMessage = z.infer<typeof setSessionStateSchema>;
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
  | "INTERNAL"
  | "POLL_NOT_FOUND"
  | "POLL_NOT_OPEN"
  | "ALREADY_VOTED"
  | "INVALID_TRANSITION";

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

/** A poll's definition and current state. Sent on create, launch, and close. */
export interface PollMessage {
  type: "poll";
  pollId: string;
  question: string;
  options: string[];
  state: "draft" | "open" | "closed";
  requestId?: string;
}

/**
 * Current tally. Broadcast on a debounce while voting is open, and once more
 * unconditionally when the poll closes.
 */
export interface PollResultsMessage {
  type: "pollResults";
  pollId: string;
  counts: number[];
  totalVotes: number;
  state: "draft" | "open" | "closed";
  /** True for the final tally after close, so clients can stop animating. */
  final: boolean;
}

/**
 * Sent only to the voter, confirming their vote was recorded.
 *
 * Without it a client can only guess: the results broadcast is debounced and
 * goes to everyone, so it proves nothing about *this* voter, and a failed vote
 * would otherwise look identical to a successful one.
 */
export interface VoteAcceptedMessage {
  type: "voteAccepted";
  pollId: string;
  optionIndex: number;
  requestId?: string;
}

/** Session moved through its lifecycle. */
export interface SessionStateMessage {
  type: "sessionState";
  sessionCode: string;
  state: "lobby" | "active" | "closed";
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
  | PollMessage
  | PollResultsMessage
  | VoteAcceptedMessage
  | SessionStateMessage
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
