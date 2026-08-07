/**
 * $default — every inbound client message.
 *
 * Routes on the validated message type:
 *   ping                     heartbeat, keeps the socket off the 10-min idle timeout
 *   join / presenterJoin     attach this connection to a session
 *   broadcast                relay to everyone else in the session
 *   createPoll / launchPoll  presenter-only poll lifecycle
 *   closePoll                presenter-only; broadcasts the final tally
 *   vote                     one per voter, enforced by a conditional write
 *   setSessionState          presenter-only lifecycle transition
 *
 * Replies are pushed with PostToConnection, never returned. API Gateway only
 * returns a handler's value to the client when both a route response and an
 * integration response exist, and CDK's `returnResponse` creates only the
 * former — see docs/architecture.md.
 *
 * Always returns 200 to API Gateway. A client error is reported to the client
 * as an `error` frame; surfacing it as a 5xx would pollute the Lambda error
 * metrics we alarm on in Phase 4.
 */
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";
import {
  parseClientMessage,
  errorMessage,
  safeEqual,
  canTransitionSession,
  sortQuestions,
  visibleToAudience,
  type ModerationAction,
  type ClientMessage,
  type ServerMessage,
  type Role,
  type SessionState,
} from "@backrow/shared";
import {
  getConnection,
  getSession,
  joinSession,
  setSessionState,
  InvalidTransition,
  type ConnectionRecord,
} from "../lib/ddb";
import {
  createPoll,
  getPoll,
  getActivePoll,
  getVote,
  setPollState,
  castVote,
  readTally,
  claimBroadcast,
  AlreadyVoted,
} from "../lib/polls";
import {
  askQuestion,
  getQuestion,
  listQuestions,
  upvoteQuestion,
  upvotedBy,
  moderateQuestion,
  AlreadyUpvoted,
  RateLimited,
} from "../lib/qa";
import {
  pushTo,
  fanOutToSession,
  endpointFrom,
  memberCount,
} from "../lib/broadcast";

const OK: APIGatewayProxyResult = { statusCode: 200, body: "ok" };

/**
 * How often live results may be pushed while a poll is open.
 *
 * Results change faster than anyone can read them during a burst, so this is
 * about legibility as much as load — 500ms is roughly the fastest a bar chart
 * can animate and still be followed.
 */
const RESULTS_WINDOW_MS = 500;

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = endpointFrom(domainName, stage);
  const reply = (m: ServerMessage) => pushTo(endpoint, connectionId, m);

  const parsed = parseClientMessage(event.body);
  if (!parsed.ok) {
    await reply(errorMessage("BAD_REQUEST", parsed.error));
    return OK;
  }

  try {
    await route(parsed.message, { connectionId, endpoint, reply });
  } catch (err) {
    console.error("handler failed", {
      connectionId,
      type: parsed.message.type,
      err,
    });
    await reply(
      errorMessage("INTERNAL", "something went wrong", parsed.message.requestId)
    );
  }

  return OK;
}

interface Ctx {
  connectionId: string;
  endpoint: string;
  reply: (m: ServerMessage) => Promise<unknown>;
}

async function route(message: ClientMessage, ctx: Ctx): Promise<void> {
  switch (message.type) {
    case "ping":
      await ctx.reply({
        type: "pong",
        serverTime: Date.now(),
        requestId: message.requestId,
      });
      return;

    case "join":
      await handleJoin(
        {
          sessionCode: message.sessionCode,
          displayName: message.displayName,
          clientId: message.clientId,
          requestId: message.requestId,
          role: "audience",
        },
        ctx
      );
      return;

    case "presenterJoin":
      await handleJoin(
        {
          sessionCode: message.sessionCode,
          presenterToken: message.presenterToken,
          clientId: message.clientId,
          requestId: message.requestId,
          role: "presenter",
        },
        ctx
      );
      return;

    case "broadcast":
      await handleBroadcast(message.text, message.requestId, ctx);
      return;

    case "createPoll":
      await handleCreatePoll(message.question, message.options, message.requestId, ctx);
      return;

    case "launchPoll":
      await handlePollTransition(message.pollId, "open", message.requestId, ctx);
      return;

    case "closePoll":
      await handlePollTransition(message.pollId, "closed", message.requestId, ctx);
      return;

    case "vote":
      await handleVote(message.pollId, message.optionIndex, message.requestId, ctx);
      return;

    case "setSessionState":
      await handleSetSessionState(message.state, message.requestId, ctx);
      return;

    case "askQuestion":
      await handleAskQuestion(message.text, message.requestId, ctx);
      return;

    case "upvoteQuestion":
      await handleUpvote(message.questionId, message.requestId, ctx);
      return;

    case "moderateQuestion":
      await handleModerate(
        message.questionId,
        message.action,
        message.requestId,
        ctx
      );
      return;
  }
}

// --- Q&A -------------------------------------------------------------------

async function handleAskQuestion(
  text: string,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const askedBy = conn.clientId ?? ctx.connectionId;

  let question;
  try {
    question = await askQuestion({
      sessionCode,
      text,
      displayName: conn.displayName ?? undefined,
      askedBy,
      nowMs: Date.now(),
    });
  } catch (err) {
    if (err instanceof RateLimited) {
      await ctx.reply(
        errorMessage("RATE_LIMITED", "wait a moment before asking again", requestId)
      );
      return;
    }
    throw err;
  }

  // Everyone, sender included — the asker needs the server-assigned id, and
  // their own question in the list, so there's nothing to exclude here.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: {
      type: "question",
      questionId: question.questionId,
      text: question.text,
      displayName: question.displayName,
      upvotes: 0,
      state: question.state,
      askedAt: question.askedAt,
    },
  });

  console.log("question asked", { sessionCode, questionId: question.questionId });
}

async function handleUpvote(
  questionId: string,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const question = await getQuestion(sessionCode, questionId);
  if (!question) {
    await ctx.reply(
      errorMessage("QUESTION_NOT_FOUND", "no such question", requestId)
    );
    return;
  }

  const voterId = conn.clientId ?? ctx.connectionId;

  let upvotes: number;
  try {
    upvotes = await upvoteQuestion({
      sessionCode,
      questionId,
      voterId,
      nowMs: Date.now(),
    });
  } catch (err) {
    if (err instanceof AlreadyUpvoted) {
      await ctx.reply(
        errorMessage("ALREADY_UPVOTED", "you already upvoted that", requestId)
      );
      return;
    }
    throw err;
  }

  // Send the changed question only; clients re-sort locally. Resending the whole
  // list on every upvote would cost far more for the same result.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: {
      type: "question",
      questionId,
      text: question.text,
      displayName: question.displayName,
      upvotes,
      state: question.state,
      askedAt: question.askedAt,
    },
  });
}

async function handleModerate(
  questionId: string,
  action: ModerationAction,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId, true);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const question = await getQuestion(sessionCode, questionId);
  if (!question) {
    await ctx.reply(
      errorMessage("QUESTION_NOT_FOUND", "no such question", requestId)
    );
    return;
  }

  const state = await moderateQuestion({ sessionCode, questionId, action });

  // Hidden questions still go to the room: every client needs to know to remove
  // it. Withholding the update would leave it on screen for everyone who
  // already had it, which is the opposite of hiding.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: {
      type: "question",
      questionId,
      text: question.text,
      displayName: question.displayName,
      upvotes: question.upvotes ?? 0,
      state,
      askedAt: question.askedAt,
    },
  });

  console.log("question moderated", { sessionCode, questionId, action, state });
}

// --- membership ------------------------------------------------------------

async function handleJoin(
  params: {
    sessionCode: string;
    role: Role;
    displayName?: string;
    clientId?: string;
    presenterToken?: string;
    requestId?: string;
  },
  ctx: Ctx
): Promise<void> {
  const { sessionCode, role, displayName, clientId, presenterToken, requestId } =
    params;

  const session = await getSession(sessionCode);
  if (!session) {
    await ctx.reply(
      errorMessage("SESSION_NOT_FOUND", "no session with that code", requestId)
    );
    return;
  }
  if (session.state === "closed") {
    await ctx.reply(
      errorMessage("SESSION_CLOSED", "this session has ended", requestId)
    );
    return;
  }

  // Presenter claims are only honored with the token handed out at creation.
  if (role === "presenter") {
    if (!presenterToken || !safeEqual(presenterToken, session.presenterToken)) {
      await ctx.reply(
        errorMessage("FORBIDDEN", "invalid presenter token", requestId)
      );
      return;
    }
  }

  await joinSession({
    connectionId: ctx.connectionId,
    sessionCode,
    role,
    displayName,
    clientId,
    nowMs: Date.now(),
  });

  const count = await memberCount(sessionCode);

  await ctx.reply({
    type: "joined",
    sessionCode,
    state: session.state,
    role,
    memberCount: count,
    requestId,
  });

  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: { type: "presence", sessionCode, memberCount: count },
    exclude: ctx.connectionId,
  });

  // Bring this client up to date on any live poll. Poll state lives only in
  // client memory, so without this a reload or a late join shows nothing while
  // a poll is open — the same resync problem as session membership.
  await sendPollSnapshot(ctx, sessionCode, role, clientId ?? ctx.connectionId);

  console.log("joined", { connectionId: ctx.connectionId, sessionCode, role });
}

/**
 * Send the joining client the current poll, its tally, and whether they've
 * already voted — to this connection only, never fanned out.
 *
 * Best-effort: a failure here must not fail the join, because being in the
 * session matters more than seeing the poll immediately, and the next results
 * broadcast will catch them up anyway.
 */
async function sendPollSnapshot(
  ctx: Ctx,
  sessionCode: string,
  role: Role,
  voterId: string
): Promise<void> {
  await sendQuestionSnapshot(ctx, sessionCode, role, voterId);

  try {
    const poll = await getActivePoll(sessionCode, role === "presenter");
    if (!poll) return;

    await ctx.reply({
      type: "poll",
      pollId: poll.pollId,
      question: poll.question,
      options: poll.options,
      state: poll.state,
    });

    // A draft has no votes yet, so there's nothing further to send.
    if (poll.state === "draft") return;

    const counts = await readTally(poll.pollId, poll.options.length);
    await ctx.reply({
      type: "pollResults",
      pollId: poll.pollId,
      counts,
      totalVotes: counts.reduce((a, b) => a + b, 0),
      state: poll.state,
      final: poll.state === "closed",
    });

    // Suppress the vote buttons for someone who already voted, rather than
    // letting them click and collect an ALREADY_VOTED error.
    if (poll.state === "open") {
      const existing = await getVote(poll.pollId, voterId);
      if (existing) {
        await ctx.reply({
          type: "voteAccepted",
          pollId: poll.pollId,
          optionIndex: existing.optionIndex,
        });
      }
    }
  } catch (err) {
    console.error("poll snapshot failed", { sessionCode, err });
  }
}

/**
 * Send the joining client the question list, ordered, plus which ones it has
 * already upvoted so the buttons render correctly.
 *
 * Best-effort for the same reason as the poll snapshot: being in the session
 * matters more than seeing the backlog instantly.
 */
async function sendQuestionSnapshot(
  ctx: Ctx,
  sessionCode: string,
  role: Role,
  voterId: string
): Promise<void> {
  try {
    const all = await listQuestions(sessionCode);
    // Hidden questions are the presenter's business only.
    const scoped = role === "presenter" ? all : visibleToAudience(all);
    if (scoped.length === 0) return;

    const ordered = sortQuestions(
      scoped.map((q) => ({
        questionId: q.questionId,
        text: q.text,
        displayName: q.displayName,
        upvotes: q.upvotes ?? 0,
        state: q.state,
        askedAt: q.askedAt,
      }))
    );

    await ctx.reply({
      type: "questionList",
      questions: ordered,
      upvoted: await upvotedBy(
        ordered.map((q) => q.questionId),
        voterId
      ),
    });
  } catch (err) {
    console.error("question snapshot failed", { sessionCode, err });
  }
}

/**
 * Resolve the caller's membership.
 *
 * The connection record is the only source of truth for which session a socket
 * belongs to — a session code supplied in the message body is never trusted,
 * or a client could act on a session it never joined.
 */
async function requireMember(
  ctx: Ctx,
  requestId: string | undefined,
  needsPresenter = false
): Promise<ConnectionRecord | undefined> {
  const conn = await getConnection(ctx.connectionId);
  if (!conn?.sessionCode || !conn.role) {
    await ctx.reply(
      errorMessage("NOT_JOINED", "join a session first", requestId)
    );
    return undefined;
  }
  if (needsPresenter && conn.role !== "presenter") {
    await ctx.reply(
      errorMessage("FORBIDDEN", "only the presenter can do that", requestId)
    );
    return undefined;
  }
  return conn;
}

async function handleBroadcast(
  text: string,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId);
  if (!conn) return;

  const result = await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode: conn.sessionCode!,
    message: {
      type: "message",
      sessionCode: conn.sessionCode!,
      from: ctx.connectionId,
      fromRole: conn.role!,
      displayName: conn.displayName ?? undefined,
      text,
      sentAt: Date.now(),
    },
    exclude: ctx.connectionId,
  });

  console.log("broadcast", {
    sessionCode: conn.sessionCode,
    from: ctx.connectionId,
    ...result,
  });
}

// --- session lifecycle -----------------------------------------------------

async function handleSetSessionState(
  to: SessionState,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId, true);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const session = await getSession(sessionCode);
  if (!session) {
    await ctx.reply(errorMessage("SESSION_NOT_FOUND", "session is gone", requestId));
    return;
  }

  if (!canTransitionSession(session.state, to)) {
    await ctx.reply(
      errorMessage(
        "INVALID_TRANSITION",
        `cannot go from ${session.state} to ${to}`,
        requestId
      )
    );
    return;
  }

  try {
    await setSessionState({ sessionCode, from: session.state, to });
  } catch (err) {
    if (err instanceof InvalidTransition) {
      await ctx.reply(
        errorMessage("INVALID_TRANSITION", err.message, requestId)
      );
      return;
    }
    throw err;
  }

  // Everyone, including the presenter, so every client converges on one state.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: { type: "sessionState", sessionCode, state: to },
  });

  console.log("session state changed", { sessionCode, from: session.state, to });
}

// --- polls -----------------------------------------------------------------

async function handleCreatePoll(
  question: string,
  options: string[],
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId, true);
  if (!conn) return;

  const poll = await createPoll({
    sessionCode: conn.sessionCode!,
    question,
    options,
    nowMs: Date.now(),
  });

  // A draft poll goes only to its author — the audience shouldn't see a
  // question before the presenter launches it.
  await ctx.reply({
    type: "poll",
    pollId: poll.pollId,
    question: poll.question,
    options: poll.options,
    state: poll.state,
    requestId,
  });

  console.log("poll created", { sessionCode: conn.sessionCode, pollId: poll.pollId });
}

async function handlePollTransition(
  pollId: string,
  to: "open" | "closed",
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId, true);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const poll = await getPoll(sessionCode, pollId);
  if (!poll) {
    await ctx.reply(errorMessage("POLL_NOT_FOUND", "no such poll", requestId));
    return;
  }

  try {
    await setPollState({ sessionCode, pollId, from: poll.state, to });
  } catch (err) {
    if (err instanceof InvalidTransition) {
      await ctx.reply(
        errorMessage("INVALID_TRANSITION", err.message, requestId)
      );
      return;
    }
    throw err;
  }

  // Launch reveals the question to the room; close delivers the final tally.
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: {
      type: "poll",
      pollId,
      question: poll.question,
      options: poll.options,
      state: to,
    },
  });

  if (to === "closed") {
    const counts = await readTally(pollId, poll.options.length);
    await fanOutToSession({
      endpoint: ctx.endpoint,
      sessionCode,
      message: {
        type: "pollResults",
        pollId,
        counts,
        totalVotes: counts.reduce((a, b) => a + b, 0),
        state: "closed",
        // Unconditional, unlike the debounced live updates — the final number
        // must never be dropped by the rate limiter.
        final: true,
      },
    });
  }

  console.log("poll transition", { sessionCode, pollId, from: poll.state, to });
}

async function handleVote(
  pollId: string,
  optionIndex: number,
  requestId: string | undefined,
  ctx: Ctx
): Promise<void> {
  const conn = await requireMember(ctx, requestId);
  if (!conn) return;

  const sessionCode = conn.sessionCode!;
  const poll = await getPoll(sessionCode, pollId);
  if (!poll) {
    await ctx.reply(errorMessage("POLL_NOT_FOUND", "no such poll", requestId));
    return;
  }
  if (poll.state !== "open") {
    await ctx.reply(
      errorMessage("POLL_NOT_OPEN", "voting is not open", requestId)
    );
    return;
  }
  if (optionIndex >= poll.options.length) {
    await ctx.reply(
      errorMessage("BAD_REQUEST", "option index out of range", requestId)
    );
    return;
  }

  // clientId survives reconnects; connectionId does not. Without this a
  // student who lost wifi could vote twice entirely by accident.
  const voterId = conn.clientId ?? ctx.connectionId;

  try {
    await castVote({ pollId, voterId, optionIndex, nowMs: Date.now() });
  } catch (err) {
    if (err instanceof AlreadyVoted) {
      await ctx.reply(
        errorMessage("ALREADY_VOTED", "you have already voted", requestId)
      );
      return;
    }
    throw err;
  }

  // Tell the voter their vote landed. The results broadcast below is debounced
  // and goes to the whole room, so it can't serve as this voter's confirmation.
  await ctx.reply({
    type: "voteAccepted",
    pollId,
    optionIndex,
    requestId,
  });

  // Rate-limit live results. Whichever invocation wins the conditional claim
  // broadcasts; the rest skip it. No timer, no queue, no coordination.
  const mayBroadcast = await claimBroadcast({
    sessionCode,
    pollId,
    nowMs: Date.now(),
    windowMs: RESULTS_WINDOW_MS,
  });
  if (!mayBroadcast) return;

  const counts = await readTally(pollId, poll.options.length);
  await fanOutToSession({
    endpoint: ctx.endpoint,
    sessionCode,
    message: {
      type: "pollResults",
      pollId,
      counts,
      totalVotes: counts.reduce((a, b) => a + b, 0),
      state: "open",
      final: false,
    },
  });
}
