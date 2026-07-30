import { connectionKey, sessionKey, isClientMessage } from "./index";

describe("shared contract", () => {
  test("connectionKey namespaces the connection id", () => {
    expect(connectionKey("abc123")).toEqual({
      PK: "CONN#abc123",
      SK: "CONN#abc123",
    });
  });

  test("sessionKey namespaces the session code", () => {
    expect(sessionKey("PULSE-482")).toEqual({
      PK: "SESSION#PULSE-482",
      SK: "SESSION#PULSE-482",
    });
  });

  test("isClientMessage accepts known types and rejects junk", () => {
    expect(isClientMessage({ type: "ping" })).toBe(true);
    expect(isClientMessage({ type: "join", sessionCode: "X" })).toBe(true);
    expect(isClientMessage({ type: "nope" })).toBe(false);
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage("ping")).toBe(false);
  });
});
