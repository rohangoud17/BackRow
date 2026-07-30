import {
  sessionKey,
  connectionKey,
  membershipKey,
  ttlFrom,
  CODE_ALPHABET,
  CODE_LENGTH,
  generateSessionCode,
  generatePresenterToken,
  normalizeSessionCode,
  isValidSessionCode,
  safeEqual,
  parseClientMessage,
  encode,
  errorMessage,
  MAX_TEXT_LENGTH,
} from "./index";

/** Deterministic byte source so code generation is testable. */
const seq = (start = 0) => (n: number) =>
  Uint8Array.from({ length: n }, (_, i) => start + i);

describe("table keys", () => {
  test("session, connection, and membership keys are distinct shapes", () => {
    expect(sessionKey("ACDEFG")).toEqual({
      PK: "SESSION#ACDEFG",
      SK: "SESSION#ACDEFG",
    });
    expect(connectionKey("abc123")).toEqual({
      PK: "CONN#abc123",
      SK: "CONN#abc123",
    });
    expect(membershipKey("ACDEFG", "abc123")).toEqual({
      PK: "SESSION#ACDEFG",
      SK: "CONN#abc123",
    });
  });

  test("membership shares the session partition so fan-out is one Query", () => {
    const code = "ACDEFG";
    expect(membershipKey(code, "c1").PK).toBe(sessionKey(code).PK);
    expect(membershipKey(code, "c2").PK).toBe(sessionKey(code).PK);
  });

  test("ttlFrom returns absolute epoch seconds", () => {
    expect(ttlFrom(1_000_000_000_000, 60)).toBe(1_000_000_060);
  });
});

describe("session codes", () => {
  test("alphabet excludes visually ambiguous characters", () => {
    for (const ch of ["O", "0", "I", "1", "L", "S", "5", "B", "8", "Z", "2"]) {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
  });

  test("generated codes are the right length and in-alphabet", () => {
    const code = generateSessionCode(seq(7));
    expect(code).toHaveLength(CODE_LENGTH);
    expect(isValidSessionCode(code)).toBe(true);
  });

  test("generation is deterministic for a given byte source", () => {
    expect(generateSessionCode(seq(3))).toBe(generateSessionCode(seq(3)));
  });

  test("presenter token is 64 hex chars (256 bits)", () => {
    const token = generatePresenterToken(seq(0));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("normalization strips spacing and hyphens, uppercases", () => {
    expect(normalizeSessionCode(" ac-de fg ")).toBe("ACDEFG");
  });

  test("rejects wrong length and out-of-alphabet codes", () => {
    expect(isValidSessionCode("ACDEF")).toBe(false);
    expect(isValidSessionCode("ACDEFO")).toBe(false); // O not in alphabet
    expect(isValidSessionCode("ACDEFG")).toBe(true);
  });

  test("safeEqual matches semantics of === without early exit", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("parseClientMessage", () => {
  test("accepts each valid client message type", () => {
    const cases = [
      { type: "ping" },
      { type: "join", sessionCode: "ACDEFG" },
      { type: "join", sessionCode: "ACDEFG", displayName: "Rohan" },
      { type: "presenterJoin", sessionCode: "ACDEFG", presenterToken: "t0ken" },
      { type: "broadcast", text: "hello" },
    ];
    for (const c of cases) {
      const r = parseClientMessage(JSON.stringify(c));
      expect(r.ok).toBe(true);
    }
  });

  test("rejects non-JSON without throwing", () => {
    const r = parseClientMessage("hello");
    expect(r).toEqual({ ok: false, error: "body is not valid JSON" });
  });

  test("rejects empty and oversized bodies", () => {
    expect(parseClientMessage(undefined).ok).toBe(false);
    const huge = JSON.stringify({ type: "broadcast", text: "x".repeat(9999) });
    expect(parseClientMessage(huge).ok).toBe(false);
  });

  test("rejects unknown message types", () => {
    expect(parseClientMessage(JSON.stringify({ type: "nope" })).ok).toBe(false);
  });

  test("rejects a bad session code and names the field", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "join", sessionCode: "OOOOOO" })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sessionCode");
  });

  test("rejects broadcast text over the cap", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "broadcast", text: "x".repeat(MAX_TEXT_LENGTH + 1) })
    );
    expect(r.ok).toBe(false);
  });

  test("rejects empty broadcast text", () => {
    const r = parseClientMessage(JSON.stringify({ type: "broadcast", text: "" }));
    expect(r.ok).toBe(false);
  });
});

describe("encoding", () => {
  test("encode round-trips a server message", () => {
    const msg = errorMessage("NOT_JOINED", "join a session first", "r1");
    expect(JSON.parse(encode(msg))).toEqual({
      type: "error",
      code: "NOT_JOINED",
      message: "join a session first",
      requestId: "r1",
    });
  });
});
