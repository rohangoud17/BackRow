/**
 * Client tests with a fake socket and fake timers.
 *
 * The case that matters most is resync. A reconnect that doesn't replay the
 * join leaves a socket that looks connected in the UI but receives nothing,
 * because the server has no membership edge for it — the worst kind of bug,
 * since nothing errors. Several tests below exist purely to pin that down.
 */
import { BackrowClient, type WebSocketLike } from "./index";
import type { ServerMessage } from "@backrow/shared";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;

  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Simulate the handshake completing. */
  open(): void {
    this.onopen?.();
  }

  /** Simulate an unexpected drop (network blip, idle timeout). */
  drop(): void {
    this.onclose?.();
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  parsedSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}

function makeClient(overrides: Partial<{ now: () => number }> = {}) {
  return new BackrowClient({
    url: "wss://example/dev",
    heartbeatMs: 1000,
    rotateAfterMs: 60_000,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
    socketFactory: (url) => new FakeSocket(url),
    now: overrides.now,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.reset();
  // Remove jitter so backoff timings are exact in tests.
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("connection lifecycle", () => {
  test("reports connecting then open", () => {
    const client = makeClient();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    client.connect();
    expect(states).toEqual(["connecting"]);

    FakeSocket.latest().open();
    expect(states).toEqual(["connecting", "open"]);
    expect(client.getState()).toBe("open");
  });

  test("connect() is idempotent while already open", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("close() prevents any reconnect", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();

    client.close();
    expect(client.getState()).toBe("closed");

    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  test("pings immediately on open, so the clock calibrates at once", () => {
    const client = makeClient();
    client.connect();
    const sock = FakeSocket.latest();
    sock.open();

    // Without this, the first delivery timestamp is uninterpretable until a
    // full heartbeat period (minutes) has elapsed.
    expect(sock.parsedSent().filter((m) => (m as { type: string }).type === "ping"))
      .toHaveLength(1);
  });

  test("sends a ping once per interval while open", () => {
    const client = makeClient();
    client.connect();
    const sock = FakeSocket.latest();
    sock.open();

    jest.advanceTimersByTime(3000);

    // One on open, plus one per interval.
    const pings = sock.parsedSent().filter((m) => (m as { type: string }).type === "ping");
    expect(pings).toHaveLength(4);
  });

  test("stops pinging once the socket closes", () => {
    const client = makeClient();
    client.connect();
    const sock = FakeSocket.latest();
    sock.open();
    jest.advanceTimersByTime(1000);
    const before = sock.sent.length;

    sock.drop();
    jest.advanceTimersByTime(5000);

    expect(sock.sent.length).toBe(before);
  });

  test("a pong yields a latency sample", () => {
    let t = 1000;
    const client = makeClient({ now: () => t });
    const samples: number[] = [];
    client.on("latency", (ms) => samples.push(ms));

    client.connect();
    const sock = FakeSocket.latest();
    sock.open();

    jest.advanceTimersByTime(1000);
    const ping = sock.parsedSent().at(-1) as { requestId: string };

    t = 1042;
    sock.deliver({ type: "pong", serverTime: 0, requestId: ping.requestId });

    expect(samples).toEqual([42]);
  });

  test("estimates clock offset from the pong, and corrects delivery timing", () => {
    // Client clock reads 10_000; server clock is 1400ms BEHIND (a laptop whose
    // clock drifted forward — exactly the case that made a ~40ms delivery
    // display as 1408ms).
    let t = 10_000;
    const SKEW = -1400;
    const client = makeClient({ now: () => t });
    client.connect();
    const sock = FakeSocket.latest();
    sock.open();

    expect(client.getClockOffsetMs()).toBeUndefined();
    // No calibration yet means no number at all, rather than a wrong one.
    expect(client.deliveryLatencyMs(0)).toBeUndefined();

    // The heartbeat fires and stamps sentAt with the clock as it reads now.
    jest.advanceTimersByTime(1000);
    const sentAt = t; // 10_000
    const ping = sock.parsedSent().at(-1) as { requestId: string };

    // 60ms round trip; the server stamped its clock at the midpoint.
    t = sentAt + 60;
    sock.deliver({
      type: "pong",
      serverTime: sentAt + 30 + SKEW,
      requestId: ping.requestId,
    });

    expect(client.getClockOffsetMs()).toBe(SKEW);

    // A message the server stamped 40ms ago, in server time.
    const serverSentAt = t + SKEW - 40;
    expect(client.deliveryLatencyMs(serverSentAt)).toBe(40);

    // The naive subtraction is exactly what produced the bogus 1408ms reading.
    expect(t - serverSentAt).toBe(1440);
  });

  test("clock offset uses the median, so one jittery sample can't skew it", () => {
    let t = 0;
    const client = makeClient({ now: () => t });
    client.connect();
    const sock = FakeSocket.latest();
    sock.open();

    // Three pongs. Two imply zero offset; the middle one arrives on a badly
    // asymmetric path and implies +300ms, which is a lie about the clock.
    for (const [rtt, serverDelta] of [
      [20, 10], // offset = 10 - 10 = 0
      [800, 700], // offset = 700 - 400 = +300  <- outlier
      [20, 10], // offset = 0
    ] as const) {
      t += 1000;
      jest.advanceTimersByTime(1000);
      const id = (sock.parsedSent().at(-1) as { requestId: string }).requestId;
      const sentAt = t;
      t = sentAt + rtt;
      sock.deliver({
        type: "pong",
        serverTime: sentAt + serverDelta,
        requestId: id,
      });
    }

    // Median rejects it. A mean would have been dragged to +100ms.
    expect(client.getClockOffsetMs()).toBe(0);
  });

  test("an unmatched pong does not emit a bogus sample", () => {
    const client = makeClient();
    const samples: number[] = [];
    client.on("latency", (ms) => samples.push(ms));

    client.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().deliver({
      type: "pong",
      serverTime: 0,
      requestId: "never-sent",
    });

    expect(samples).toEqual([]);
  });
});

describe("reconnect and resync", () => {
  test("reconnects after an unexpected drop", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();

    FakeSocket.latest().drop();
    expect(client.getState()).toBe("reconnecting");

    jest.advanceTimersByTime(200);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("replays the audience join on reconnect", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();
    client.join("ACDEFG", "Rohan");

    FakeSocket.latest().drop();
    jest.advanceTimersByTime(200);

    const revived = FakeSocket.latest();
    revived.open();

    // Without this the socket looks connected but receives nothing, because the
    // server has no membership edge for the new connectionId.
    expect(revived.parsedSent()).toContainEqual({
      type: "join",
      sessionCode: "ACDEFG",
      displayName: "Rohan",
    });
  });

  test("replays the presenter join, token included", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();
    client.joinAsPresenter("ACDEFG", "secret-token");

    FakeSocket.latest().drop();
    jest.advanceTimersByTime(200);
    const revived = FakeSocket.latest();
    revived.open();

    expect(revived.parsedSent()).toContainEqual({
      type: "presenterJoin",
      sessionCode: "ACDEFG",
      presenterToken: "secret-token",
    });
  });

  test("does not replay a join after an explicit close", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();
    client.join("ACDEFG");
    client.close();

    client.connect();
    FakeSocket.latest().open();

    expect(
      FakeSocket.latest()
        .parsedSent()
        .filter((m) => (m as { type: string }).type === "join")
    ).toHaveLength(0);
  });

  test("backoff grows exponentially and is capped", () => {
    const client = makeClient();
    // Jitter is pinned to zero by the Math.random mock (0.5 -> no offset).
    expect(client.backoffDelay(0)).toBe(100);
    expect(client.backoffDelay(1)).toBe(200);
    expect(client.backoffDelay(2)).toBe(400);
    expect(client.backoffDelay(10)).toBe(1000); // capped at reconnectMaxMs
  });

  test("backoff is jittered so a room doesn't retry in lockstep", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const client = makeClient();
    const low = client.backoffDelay(3);

    jest.spyOn(Math, "random").mockReturnValue(1);
    const high = client.backoffDelay(3);

    // Jitter must actually spread the retries; identical values would mean a
    // synchronized storm against the 500-connections/sec account quota.
    expect(low).toBeLessThan(high);
  });

  test("resets the backoff after a successful reconnect", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();

    FakeSocket.latest().drop();
    jest.advanceTimersByTime(200);
    FakeSocket.latest().open(); // success resets attempt

    FakeSocket.latest().drop();
    // Back to the base delay rather than continuing to grow.
    jest.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(3);
  });
});

describe("socket rotation", () => {
  test("rotates before API Gateway's hard connection cap", () => {
    const client = makeClient();
    client.connect();
    const first = FakeSocket.latest();
    first.open();
    client.join("ACDEFG");

    jest.advanceTimersByTime(60_000); // rotateAfterMs
    expect(first.closed).toBe(true);

    jest.advanceTimersByTime(200);
    const second = FakeSocket.latest();
    second.open();

    // Rotation must resync too, or the rotated socket is silently orphaned.
    expect(second.parsedSent()).toContainEqual({
      type: "join",
      sessionCode: "ACDEFG",
      displayName: undefined,
    });
  });
});

describe("sending", () => {
  test("broadcast fails cleanly when not open", () => {
    const client = makeClient();
    expect(client.broadcast("hi")).toBe(false);
  });

  test("broadcast succeeds when open", () => {
    const client = makeClient();
    client.connect();
    FakeSocket.latest().open();
    expect(client.broadcast("hi")).toBe(true);
    expect(FakeSocket.latest().parsedSent()).toContainEqual({
      type: "broadcast",
      text: "hi",
    });
  });
});

describe("receiving", () => {
  test("forwards parsed server messages", () => {
    const client = makeClient();
    const got: ServerMessage[] = [];
    client.on("message", (m) => got.push(m));

    client.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().deliver({
      type: "presence",
      sessionCode: "ACDEFG",
      memberCount: 3,
    });

    expect(got).toEqual([
      { type: "presence", sessionCode: "ACDEFG", memberCount: 3 },
    ]);
  });

  test("an unparseable frame emits an error instead of throwing", () => {
    const client = makeClient();
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));

    client.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().onmessage?.({ data: "<html>gateway error</html>" });

    expect(errors).toHaveLength(1);
    expect(client.getState()).toBe("open"); // survives it
  });

  test("a throwing listener does not break delivery to others", () => {
    const client = makeClient();
    const seen: string[] = [];
    client.on("message", () => {
      throw new Error("bad listener");
    });
    client.on("message", (m) => seen.push(m.type));

    client.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().deliver({
      type: "presence",
      sessionCode: "A",
      memberCount: 1,
    });

    expect(seen).toEqual(["presence"]);
  });
});
