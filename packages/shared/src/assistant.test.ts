import {
  askKey,
  assistantBudgetKey,
  utcDay,
  answerInvokePayloadSchema,
  parseClientMessage,
  MAX_ASSISTANT_QUESTION,
} from "./index";

describe("assistant keys", () => {
  test("asks get their own partition per session, outside SESSION#", () => {
    expect(askKey("ACDEFG", "q1")).toEqual({ PK: "ASK#ACDEFG", SK: "Q#q1" });
  });

  test("the budget counter is per course per UTC day", () => {
    expect(assistantBudgetKey("default", "c1", "2026-11-04")).toEqual({
      PK: "ORG#default#COURSE#c1#BUDGET#2026-11-04",
      SK: "COUNT",
    });
  });

  test("utcDay rolls over at UTC midnight, not local midnight", () => {
    expect(utcDay(Date.UTC(2026, 10, 4, 23, 59, 59))).toBe("2026-11-04");
    expect(utcDay(Date.UTC(2026, 10, 5, 0, 0, 0))).toBe("2026-11-05");
  });
});

describe("askAssistant message", () => {
  test("accepts a question and trims it", () => {
    const r = parseClientMessage(JSON.stringify({ type: "askAssistant", text: "  what is DP?  " }));
    expect(r).toEqual({ ok: true, message: { type: "askAssistant", text: "what is DP?" } });
  });

  test("rejects empty, whitespace-only and over-long questions", () => {
    for (const text of ["", "   ", "x".repeat(MAX_ASSISTANT_QUESTION + 1)]) {
      expect(parseClientMessage(JSON.stringify({ type: "askAssistant", text })).ok).toBe(false);
    }
    expect(
      parseClientMessage(JSON.stringify({ type: "askAssistant", text: "x".repeat(MAX_ASSISTANT_QUESTION) })).ok
    ).toBe(true);
  });
});

describe("answer invoke payload", () => {
  test("ids only; anything else is stripped", () => {
    const r = answerInvokePayloadSchema.parse({ sessionCode: "ACDEFG", queryId: "q1", text: "leak" });
    expect(r).toEqual({ sessionCode: "ACDEFG", queryId: "q1" });
  });

  test("missing ids are rejected", () => {
    expect(answerInvokePayloadSchema.safeParse({ queryId: "q1" }).success).toBe(false);
  });
});
