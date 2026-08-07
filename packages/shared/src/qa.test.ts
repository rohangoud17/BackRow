import {
  sortQuestions,
  visibleToAudience,
  stateAfterModeration,
  questionKey,
  upvoteKey,
  cooldownKey,
  parseClientMessage,
  MAX_QUESTION_LENGTH,
  type QuestionView,
} from "./index";

const q = (over: Partial<QuestionView>): QuestionView => ({
  questionId: "q1",
  text: "why?",
  upvotes: 0,
  state: "open",
  askedAt: 1000,
  ...over,
});

describe("question ordering", () => {
  test("most upvoted first", () => {
    const ordered = sortQuestions([
      q({ questionId: "a", upvotes: 1 }),
      q({ questionId: "b", upvotes: 9 }),
      q({ questionId: "c", upvotes: 4 }),
    ]);
    expect(ordered.map((x) => x.questionId)).toEqual(["b", "c", "a"]);
  });

  test("ties break by age, oldest first", () => {
    const ordered = sortQuestions([
      q({ questionId: "new", upvotes: 3, askedAt: 2000 }),
      q({ questionId: "old", upvotes: 3, askedAt: 1000 }),
    ]);
    expect(ordered.map((x) => x.questionId)).toEqual(["old", "new"]);
  });

  test("questions sink as they're dealt with: open, answered, hidden", () => {
    // An answered question is still a useful record; a hidden one has been
    // dismissed, so it belongs below even the answered ones.
    const ordered = sortQuestions([
      q({ questionId: "hidden", upvotes: 99, state: "hidden" }),
      q({ questionId: "answered", upvotes: 50, state: "answered" }),
      q({ questionId: "open", upvotes: 1, state: "open" }),
    ]);
    expect(ordered.map((x) => x.questionId)).toEqual([
      "open",
      "answered",
      "hidden",
    ]);
  });

  test("ordering is fully deterministic for identical questions", () => {
    // Two students comparing screens must never see different rankings, so
    // there is no case where the order depends on sort stability.
    const same = [
      q({ questionId: "zzz", upvotes: 5, askedAt: 1000 }),
      q({ questionId: "aaa", upvotes: 5, askedAt: 1000 }),
    ];
    expect(sortQuestions(same).map((x) => x.questionId)).toEqual(["aaa", "zzz"]);
    expect(sortQuestions([...same].reverse()).map((x) => x.questionId)).toEqual(
      ["aaa", "zzz"]
    );
  });

  test("does not mutate its input", () => {
    const input = [q({ questionId: "a", upvotes: 1 }), q({ questionId: "b", upvotes: 2 })];
    sortQuestions(input);
    expect(input.map((x) => x.questionId)).toEqual(["a", "b"]);
  });
});

describe("audience visibility", () => {
  test("hidden questions are withheld; answered ones are not", () => {
    const visible = visibleToAudience([
      q({ questionId: "open", state: "open" }),
      q({ questionId: "answered", state: "answered" }),
      q({ questionId: "hidden", state: "hidden" }),
    ]);
    expect(visible.map((x) => x.questionId)).toEqual(["open", "answered"]);
  });
});

describe("moderation", () => {
  test("maps each action to its resulting state", () => {
    expect(stateAfterModeration("answer")).toBe("answered");
    expect(stateAfterModeration("hide")).toBe("hidden");
    expect(stateAfterModeration("restore")).toBe("open");
  });

  test("hiding is recoverable", () => {
    // A presenter who hides the wrong question must not have destroyed it.
    expect(stateAfterModeration("restore")).toBe("open");
  });
});

describe("Q&A keys", () => {
  test("questions live in the session partition", () => {
    expect(questionKey("ACDEFG", "q1")).toEqual({
      PK: "SESSION#ACDEFG",
      SK: "QA#q1",
    });
  });

  test("one upvote row per voter, so a duplicate collides on write", () => {
    expect(upvoteKey("q1", "voter-a")).toEqual({
      PK: "QA#q1",
      SK: "UP#voter-a",
    });
    expect(upvoteKey("q1", "voter-b").SK).not.toBe(upvoteKey("q1", "voter-a").SK);
  });

  test("cooldown keys are per client per action", () => {
    // Per action, so a slow-down on asking can't also throttle reacting; and
    // per client in the PARTITION key, so a room full of people being rate
    // limited doesn't concentrate those writes on one partition.
    const ask = cooldownKey("ACDEFG", "c1", "ask");
    expect(ask).not.toEqual(cooldownKey("ACDEFG", "c1", "react"));
    expect(ask.PK).not.toBe(cooldownKey("ACDEFG", "c2", "ask").PK);
  });
});

describe("Q&A message validation", () => {
  const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

  test("accepts a well-formed question", () => {
    expect(parse({ type: "askQuestion", text: "Why sharded?" }).ok).toBe(true);
  });

  test("rejects empty or oversized question text", () => {
    expect(parse({ type: "askQuestion", text: "" }).ok).toBe(false);
    expect(
      parse({ type: "askQuestion", text: "x".repeat(MAX_QUESTION_LENGTH + 1) }).ok
    ).toBe(false);
  });

  test("accepts the three moderation actions and nothing else", () => {
    for (const action of ["answer", "hide", "restore"]) {
      expect(parse({ type: "moderateQuestion", questionId: "q1", action }).ok)
        .toBe(true);
    }
    expect(parse({ type: "moderateQuestion", questionId: "q1", action: "delete" }).ok)
      .toBe(false);
  });

  test("upvote requires a question id", () => {
    expect(parse({ type: "upvoteQuestion", questionId: "q1" }).ok).toBe(true);
    expect(parse({ type: "upvoteQuestion" }).ok).toBe(false);
  });
});
