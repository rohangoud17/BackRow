/**
 * @backrow/client — the browser-side WebSocket layer.
 *
 * Framework-agnostic on purpose: the audience and presenter React apps both
 * import this rather than each reimplementing reconnect logic.
 *
 * The three platform limits from docs/architecture.md are all handled here,
 * because none of them are optional:
 *
 *   1. Idle sockets are dropped after 10 minutes -> heartbeat every 4.5 min.
 *   2. Any connection is killed at 2 hours -> proactively reconnect at 1h50m,
 *      so the socket rotates on our schedule instead of dying mid-lecture.
 *   3. A dropped socket loses all server-side session membership -> replay the
 *      join on every reconnect (resync).
 *
 * Reconnect uses exponential backoff with jitter. The jitter matters more than
 * it looks: a whole lecture hall reconnecting after a blip would otherwise
 * retry in lockstep and hit the 500-new-connections-per-second account quota.
 */
import type { ServerMessage, ClientMessage, Role } from "@backrow/shared";
import { REACTION_COOLDOWN_MS, reactionDeltas } from "@backrow/shared";

// Re-exported so a UI can render the reaction bar without also depending on
// @backrow/shared. The emoji set and the wire indices are the same thing, so
// there must be exactly one source for them.
export {
  REACTION_EMOJI,
  REACTION_COUNT,
  REACTION_COOLDOWN_MS,
  MAX_REACTION_BURST,
} from "@backrow/shared";

export interface ClientOptions {
  /** wss:// URL of the WebSocket stage. */
  url: string;
  /** Heartbeat period. Must stay under API Gateway's 10-minute idle timeout. */
  heartbeatMs?: number;
  /** Rotate the socket before API Gateway's hard 2-hour cap. */
  rotateAfterMs?: number;
  /** First reconnect delay; doubles each attempt up to reconnectMaxMs. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * Stable per-browser identity, sent on join and used as voter identity.
   *
   * Without it the server falls back to connectionId, which changes on every
   * reconnect — so a student who briefly lost wifi could vote twice by
   * accident. Use `getOrCreateClientId()` to obtain a persistent one.
   */
  clientId?: string;
  /** Injected for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Injected for tests. */
  now?: () => number;
}

/** The subset of WebSocket this client relies on. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** What to replay after a reconnect so the server re-associates this socket. */
interface JoinIntent {
  sessionCode: string;
  role: Role;
  displayName?: string;
  presenterToken?: string;
}

export interface ClientEvents {
  /** Any server frame, already parsed. */
  message: (m: ServerMessage) => void;
  /** Connection state changed. */
  state: (s: ConnectionState) => void;
  /** Round-trip time in ms, from the ping/pong heartbeat. */
  latency: (ms: number) => void;
  /**
   * Cumulative reaction totals, plus how many of each to animate.
   *
   * The deltas are what changed since the last frame this client saw, capped —
   * the totals are authoritative, the deltas are the animation instruction. On
   * the first frame after joining every delta is zero: totals arriving for a
   * session that has been running a while are history, not an event.
   */
  reactions: (totals: number[], deltas: number[]) => void;
  /** Transport-level problem, or an unparseable frame. */
  error: (err: Error) => void;
}

type Listener<K extends keyof ClientEvents> = ClientEvents[K];

const DEFAULTS = {
  // API Gateway drops idle sockets at 10 min; 4.5 gives two chances to land.
  heartbeatMs: 4.5 * 60 * 1000,
  // Hard cap is 2h. Rotate at 1h50m so we choose the moment, not the platform.
  rotateAfterMs: 110 * 60 * 1000,
  reconnectBaseMs: 250,
  reconnectMaxMs: 10_000,
};

export class BackrowClient {
  private readonly opts: Required<
    Omit<ClientOptions, "socketFactory" | "now" | "clientId">
  > & {
    clientId?: string;
    socketFactory: (url: string) => WebSocketLike;
    now: () => number;
  };

  private socket?: WebSocketLike;
  private state: ConnectionState = "idle";
  private intent?: JoinIntent;
  private attempt = 0;
  private closedByUs = false;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private rotateTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** requestId -> send time, for RTT measurement. */
  private readonly pending = new Map<string, number>();
  private pingSeq = 0;

  /**
   * Recent estimates of (server clock - client clock), in ms.
   *
   * Server-stamped timestamps like `RelayedMessage.sentAt` are useless for
   * measuring latency until corrected by this: subtracting a server timestamp
   * from `Date.now()` measures clock offset plus latency, and consumer-device
   * clocks routinely drift by whole seconds. We keep a short history and take
   * the median, because any single sample is polluted by network jitter.
   */
  private readonly offsets: number[] = [];

  private readonly listeners: {
    [K in keyof ClientEvents]: Set<Listener<K>>;
  } = {
    message: new Set(),
    state: new Set(),
    latency: new Set(),
    reactions: new Set(),
    error: new Set(),
  };

  /**
   * Last reaction totals seen, or undefined before the first frame.
   *
   * Undefined is meaningfully different from all-zeros: it means this client has
   * no baseline yet, so the next frame establishes one instead of animating the
   * difference from nothing.
   */
  private reactionTotals?: number[];

  /** Client clock time of the last reaction actually put on the wire. */
  private lastReactionAt = 0;

  constructor(options: ClientOptions) {
    this.opts = {
      url: options.url,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      rotateAfterMs: options.rotateAfterMs ?? DEFAULTS.rotateAfterMs,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
      clientId: options.clientId,
      socketFactory:
        options.socketFactory ??
        ((url: string) => new WebSocket(url) as unknown as WebSocketLike),
      now: options.now ?? (() => Date.now()),
    };
  }

  // -- events --------------------------------------------------------------

  on<K extends keyof ClientEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn as never);
    return () => this.listeners[event].delete(fn as never);
  }

  private emit<K extends keyof ClientEvents>(
    event: K,
    ...args: Parameters<ClientEvents[K]>
  ): void {
    for (const fn of this.listeners[event]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error("listener threw", err);
      }
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Median estimate of (server clock - client clock) in ms, or undefined until
   * at least one pong has landed. Positive means the server's clock is ahead.
   */
  getClockOffsetMs(): number | undefined {
    if (this.offsets.length === 0) return undefined;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * True one-way delivery latency for a server-stamped timestamp.
   *
   * Naively doing `Date.now() - message.sentAt` conflates latency with clock
   * offset — on a laptop whose clock is 1.4s off, a 40ms delivery reads as
   * 1440ms. Returns undefined until a pong has calibrated the offset, because
   * a wrong number is worse than no number.
   */
  deliveryLatencyMs(serverSentAt: number): number | undefined {
    const offset = this.getClockOffsetMs();
    if (offset === undefined) return undefined;
    // Convert the server timestamp into client time, then subtract.
    return Math.round(this.opts.now() - (serverSentAt - offset));
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  // -- lifecycle -----------------------------------------------------------

  connect(): void {
    if (this.state === "connecting" || this.state === "open") return;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    const socket = this.opts.socketFactory(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState("open");
      this.startHeartbeat();
      this.scheduleRotate();
      // Resync: the server has no memory of this socket's membership.
      if (this.intent) this.sendJoin(this.intent);
      // Ping straight away rather than waiting a full heartbeat period. It
      // confirms the socket is genuinely usable and calibrates the clock
      // offset immediately, so server-stamped timestamps are interpretable
      // from the first message rather than minutes later.
      this.ping();
    };

    socket.onmessage = (ev) => this.receive(ev.data);

    socket.onerror = () => {
      this.emit("error", new Error("websocket transport error"));
    };

    socket.onclose = () => {
      this.stopTimers();
      if (this.closedByUs) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Close for good; no reconnect. */
  close(): void {
    this.closedByUs = true;
    this.intent = undefined;
    this.stopTimers();
    this.socket?.close();
    this.setState("closed");
  }

  // -- reconnect -----------------------------------------------------------

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = this.backoffDelay(this.attempt++);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /**
   * Exponential backoff with +/-30% jitter.
   *
   * Exposed for testing. The jitter prevents a synchronized retry storm when a
   * whole room reconnects at once — that would hit the account's
   * 500-new-connections-per-second quota.
   */
  backoffDelay(attempt: number): number {
    const raw = this.opts.reconnectBaseMs * 2 ** attempt;
    const capped = Math.min(raw, this.opts.reconnectMaxMs);
    const jitter = capped * 0.3 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  // -- timers --------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.ping(), this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * Rotate the socket before API Gateway kills it at the 2-hour mark.
   *
   * Reconnecting on our own schedule means the gap is a controlled ~100ms
   * instead of an unexplained mid-lecture disconnect.
   */
  private scheduleRotate(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => {
      this.attempt = 0;
      this.socket?.close(); // onclose triggers the reconnect + resync path
    }, this.opts.rotateAfterMs);
  }

  private stopTimers(): void {
    this.stopHeartbeat();
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rotateTimer = undefined;
    this.reconnectTimer = undefined;
  }

  // -- sending -------------------------------------------------------------

  private send(message: ClientMessage): boolean {
    if (this.state !== "open" || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** Heartbeat, and the RTT sample that comes with it. */
  ping(): void {
    const requestId = `ping-${++this.pingSeq}`;
    this.pending.set(requestId, this.opts.now());
    this.send({ type: "ping", requestId });
  }

  /** Join as audience. Remembered and replayed on reconnect. */
  join(sessionCode: string, displayName?: string): void {
    this.intent = { sessionCode, role: "audience", displayName };
    this.sendJoin(this.intent);
  }

  /** Attach as presenter. The token is remembered for resync. */
  joinAsPresenter(sessionCode: string, presenterToken: string): void {
    this.intent = { sessionCode, role: "presenter", presenterToken };
    this.sendJoin(this.intent);
  }

  private sendJoin(intent: JoinIntent): void {
    if (intent.role === "presenter") {
      this.send({
        type: "presenterJoin",
        sessionCode: intent.sessionCode,
        presenterToken: intent.presenterToken ?? "",
        clientId: this.opts.clientId,
      });
    } else {
      this.send({
        type: "join",
        sessionCode: intent.sessionCode,
        displayName: intent.displayName,
        clientId: this.opts.clientId,
      });
    }
  }

  broadcast(text: string): boolean {
    return this.send({ type: "broadcast", text });
  }

  // -- polls ---------------------------------------------------------------

  /** Presenter only. The poll starts as a draft, visible only to its author. */
  createPoll(question: string, options: string[]): boolean {
    return this.send({ type: "createPoll", question, options });
  }

  /** Presenter only. Reveals the question and opens voting. */
  launchPoll(pollId: string): boolean {
    return this.send({ type: "launchPoll", pollId });
  }

  /** Presenter only. Stops voting and triggers the final tally broadcast. */
  closePoll(pollId: string): boolean {
    return this.send({ type: "closePoll", pollId });
  }

  /** One vote per voter — a second attempt returns an ALREADY_VOTED error. */
  vote(pollId: string, optionIndex: number): boolean {
    return this.send({ type: "vote", pollId, optionIndex });
  }

  /** Presenter only. Illegal transitions are rejected server-side. */
  setSessionState(state: "lobby" | "active" | "closed"): boolean {
    return this.send({ type: "setSessionState", state });
  }

  // -- Q&A -----------------------------------------------------------------

  /** Submit a question. Rate-limited per client server-side. */
  askQuestion(text: string): boolean {
    return this.send({ type: "askQuestion", text });
  }

  /** One upvote per voter per question. */
  upvoteQuestion(questionId: string): boolean {
    return this.send({ type: "upvoteQuestion", questionId });
  }

  /** Presenter only. `restore` undoes a hide. */
  moderateQuestion(
    questionId: string,
    action: "answer" | "hide" | "restore"
  ): boolean {
    return this.send({ type: "moderateQuestion", questionId, action });
  }

  // -- reactions -----------------------------------------------------------

  /**
   * Send one reaction, by index into `REACTION_EMOJI`.
   *
   * Throttled locally to the server's cooldown. That is not a substitute for the
   * server-side limit — a client can always be modified — it just avoids sending
   * frames we know will be discarded, which matters because a held-down button
   * generates them faster than the network can clear them.
   *
   * Returns false when the throttle swallowed it. Callers are still free to
   * animate the tap: the user did press the button, and pretending otherwise
   * makes a responsive UI feel broken. What they must not do is adjust their
   * totals, which only ever come from the server.
   */
  react(reaction: number): boolean {
    const now = this.opts.now();
    if (now - this.lastReactionAt < REACTION_COOLDOWN_MS) return false;
    this.lastReactionAt = now;
    return this.send({ type: "react", reaction });
  }

  /** Cumulative totals, or undefined before the first frame lands. */
  getReactionTotals(): number[] | undefined {
    return this.reactionTotals ? [...this.reactionTotals] : undefined;
  }

  // -- receiving -----------------------------------------------------------

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;

    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.emit("error", new Error(`unparseable frame: ${raw.slice(0, 80)}`));
      return;
    }

    // Turn the pong into an RTT sample and a clock-offset estimate.
    if (message.type === "pong" && message.requestId) {
      const sentAt = this.pending.get(message.requestId);
      if (sentAt !== undefined) {
        this.pending.delete(message.requestId);
        const receivedAt = this.opts.now();
        const rtt = receivedAt - sentAt;

        // Standard NTP-style estimate: assume the server stamped serverTime at
        // the midpoint of the round trip, so in client time that instant was
        // (sentAt + rtt/2). Asymmetric network paths bias this, but it's
        // accurate to well within the precision we need here.
        if (typeof message.serverTime === "number" && message.serverTime > 0) {
          this.offsets.push(message.serverTime - (sentAt + rtt / 2));
          if (this.offsets.length > 9) this.offsets.shift();
        }

        this.emit("latency", rtt);
      }
    }

    if (message.type === "reactions" && Array.isArray(message.totals)) {
      const first = this.reactionTotals === undefined;
      const deltas = first
        ? message.totals.map(() => 0)
        : reactionDeltas(this.reactionTotals, message.totals);

      // Take the element-wise maximum rather than trusting the newer frame. Two
      // totals frames can arrive out of order, and totals are monotonic by
      // construction, so a lower value is stale — accepting it would make the
      // counter visibly tick backwards and manufacture a phantom delta on the
      // next frame.
      this.reactionTotals = message.totals.map((n, i) =>
        Math.max(n, this.reactionTotals?.[i] ?? 0)
      );

      this.emit("reactions", [...this.reactionTotals], deltas);
    }

    this.emit("message", message);
  }
}

/**
 * Create a session over the HTTP API.
 *
 * Returns the presenter token, which the server will never reveal again — the
 * caller must persist it or the session becomes uncontrollable.
 */
export async function createSession(httpBaseUrl: string): Promise<{
  sessionCode: string;
  state: string;
  presenterToken: string;
}> {
  const res = await fetch(`${httpBaseUrl}/sessions`, { method: "POST" });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return res.json();
}

/** Look up a session without joining — used to validate a typed code. */
export async function lookupSession(
  httpBaseUrl: string,
  sessionCode: string
): Promise<{ sessionCode: string; state: string } | undefined> {
  const res = await fetch(`${httpBaseUrl}/sessions/${sessionCode}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
  return res.json();
}

/**
 * A stable per-browser id, persisted so it survives reloads and reconnects.
 *
 * This is voter identity. connectionId cannot serve the purpose — it changes
 * on every reconnect, and reconnects are routine (10-minute idle drop, 2-hour
 * hard cap), so without a stable id a student who lost wifi mid-poll could
 * vote a second time entirely by accident.
 *
 * Falls back to an in-memory id when storage is unavailable (private browsing,
 * blocked cookies). That degrades to per-tab identity rather than failing —
 * imperfect, but better than refusing to let someone vote.
 */
let memoryClientId: string | undefined;

const generateClientId = () =>
  `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function getOrCreateClientId(key = "backrow.clientId"): string {
  const generate = generateClientId;

  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = generate();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    memoryClientId ??= generate();
    return memoryClientId;
  }
}

/**
 * Discard the stored identity and mint a new one.
 *
 * Exists for testing: `clientId` is deliberately shared across tabs of the same
 * browser (one student, one vote), which makes it impossible to simulate two
 * distinct voters locally without this. Not something a real client should ever
 * call — a student who could reset their identity could vote twice.
 */
export function resetClientId(key = "backrow.clientId"): string {
  const fresh = generateClientId();
  try {
    localStorage.setItem(key, fresh);
  } catch {
    memoryClientId = fresh;
  }
  return fresh;
}
