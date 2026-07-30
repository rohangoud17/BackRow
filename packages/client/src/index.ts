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
    Omit<ClientOptions, "socketFactory" | "now">
  > & {
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
  } = { message: new Set(), state: new Set(), latency: new Set(), error: new Set() };

  constructor(options: ClientOptions) {
    this.opts = {
      url: options.url,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      rotateAfterMs: options.rotateAfterMs ?? DEFAULTS.rotateAfterMs,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
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
      });
    } else {
      this.send({
        type: "join",
        sessionCode: intent.sessionCode,
        displayName: intent.displayName,
      });
    }
  }

  broadcast(text: string): boolean {
    return this.send({ type: "broadcast", text });
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
