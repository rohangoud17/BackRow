/**
 * Q&A: audience questions, upvotes, and presenter moderation.
 *
 * ## Why upvotes are NOT sharded, unlike poll votes
 *
 * Poll votes arrive as a synchronized burst — a presenter opens a poll and the
 * whole room votes within seconds — which is exactly the traffic shape that
 * serializes writes onto one DynamoDB item. Upvotes don't behave that way: they
 * trickle in over minutes as people read the list, so even a very popular
 * question in a large lecture is a couple of writes per second.
 *
 * Sharding would cost a BatchGetItem on every read of every question, for a
 * write rate two orders of magnitude below where contention starts. A single
 * `ADD upvotes :one` on the question item is the right call here. The
 * difference in approach is reasoned, not an inconsistency.
 *
 * ## Why ordering happens on the client
 *
 * DynamoDB can't sort by a mutable attribute, and upvotes change constantly.
 * The server sends the *changed* question and clients re-sort locally — so an
 * upvote costs one small frame rather than the whole list, and reordering is
 * still live. `sortQuestions` is shared so every client orders identically.
 */

/** Question lifecycle. */
export type QuestionState = "open" | "answered" | "hidden";

export const MAX_QUESTION_LENGTH = 500;

/**
 * Minimum gap between questions from one client.
 *
 * Implemented with a conditional update against a stored timestamp, NOT with a
 * TTL row: DynamoDB TTL deletion is asynchronous and can lag by hours, so it
 * cannot express a ten-second cooldown.
 */
export const ASK_COOLDOWN_MS = 10_000;

/** What a presenter can do to a question. */
export type ModerationAction = "answer" | "hide" | "restore";

/**
 * Resulting state for a moderation action.
 *
 * `restore` returns a question to `open`, which is what makes hiding
 * recoverable — a presenter who hides the wrong question shouldn't have
 * destroyed it.
 */
export function stateAfterModeration(action: ModerationAction): QuestionState {
  switch (action) {
    case "answer":
      return "answered";
    case "hide":
      return "hidden";
    case "restore":
      return "open";
  }
}

export interface QuestionView {
  questionId: string;
  text: string;
  displayName?: string;
  upvotes: number;
  state: QuestionState;
  askedAt: number;
}

/**
 * Canonical ordering: most upvoted first, oldest first among ties.
 *
 * Ties broken by age rather than left to sort instability, so every client
 * shows the same order — two students comparing screens must not see different
 * rankings.
 *
 * Questions sink as they're dealt with: open, then answered, then hidden. An
 * answered question is still a useful record; a hidden one has been dismissed,
 * so it belongs at the very bottom of the presenter's view rather than above
 * things they already answered.
 */
export function sortQuestions<T extends QuestionView>(questions: T[]): T[] {
  const rank = (q: T) =>
    q.state === "hidden" ? 2 : q.state === "answered" ? 1 : 0;
  return [...questions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.upvotes - a.upvotes ||
      a.askedAt - b.askedAt ||
      // Final tiebreak on id so the order is fully deterministic even for two
      // questions asked in the same millisecond with equal votes.
      a.questionId.localeCompare(b.questionId)
  );
}

/** Questions an audience member may see. Hidden ones are the presenter's. */
export const visibleToAudience = <T extends QuestionView>(questions: T[]): T[] =>
  questions.filter((q) => q.state !== "hidden");
