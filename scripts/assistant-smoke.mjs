#!/usr/bin/env node
/**
 * End-to-end check of the Phase 3.2 course assistant against a deployed stage.
 *
 *   node scripts/assistant-smoke.mjs --http https://... --ws wss://.../dev \
 *     --question "What does the knapsack table hold?"
 *
 * Needs a course with at least one `ready` document. Its id and token come from
 * BACKROW_COURSE_ID / BACKROW_COURSE_TOKEN (so the token stays out of shell
 * history), or from a `.env.dev-course` file holding BACKROW_DEV_COURSE_ID and
 * BACKROW_DEV_COURSE_TOKEN.
 *
 * Checks:
 *   - a question the material covers streams a grounded, cited answer
 *   - an off-topic question gets "not in the course material"
 *   - asking again inside the cooldown is RATE_LIMITED
 *   - a session with no course gets ASSISTANT_UNAVAILABLE
 *   - every assistant frame arrives on the asker's socket only
 *
 * Each answered question costs about half a cent of Bedrock usage and one ask
 * from the course's daily allowance. Uses Node 22 built-ins only.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    http: { type: "string" },
    ws: { type: "string" },
    question: { type: "string", default: "What does the knapsack table hold?" },
    offtopic: { type: "string", default: "Who won the World Cup in 2018?" },
    timeout: { type: "string", default: "45" },
  },
});
if (!args.http || !args.ws) {
  console.error("usage: node scripts/assistant-smoke.mjs --http <HttpUrl> --ws <WebSocketUrl> [--question ...]");
  process.exit(2);
}
const base = args.http.replace(/\/$/, "");
const TIMEOUT_MS = Number(args.timeout) * 1000;

async function courseCredentials() {
  if (process.env.BACKROW_COURSE_ID && process.env.BACKROW_COURSE_TOKEN) {
    return { courseId: process.env.BACKROW_COURSE_ID, courseToken: process.env.BACKROW_COURSE_TOKEN };
  }
  try {
    const env = Object.fromEntries(
      (await readFile(".env.dev-course", "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );
    return { courseId: env.BACKROW_DEV_COURSE_ID, courseToken: env.BACKROW_DEV_COURSE_TOKEN };
  } catch {
    console.error("set BACKROW_COURSE_ID and BACKROW_COURSE_TOKEN, or create .env.dev-course");
    process.exit(2);
  }
}

function expect(cond, message, detail) {
  if (cond) return console.log(`  ok   ${message}`);
  console.error(`  FAIL ${message}`, detail === undefined ? "" : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function createSession(body) {
  const res = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A joined audience socket that records every frame it receives. */
async function audience(sessionCode) {
  const ws = new WebSocket(args.ws);
  const frames = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const f = { at: Date.now(), msg: JSON.parse(e.data) };
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f.msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const waitFor = (pred, label) =>
    new Promise((resolve, reject) => {
      const hit = frames.find((f) => pred(f.msg));
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), TIMEOUT_MS);
      waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  ws.send(JSON.stringify({ type: "join", sessionCode, clientId: `smoke-${randomUUID()}` }));
  await waitFor((m) => m.type === "joined" || m.type === "error", "joined");
  return { ws, frames, waitFor, send: (m) => ws.send(JSON.stringify(m)) };
}

/** Ask, wait for the whole reply, return the frames and timings. */
async function askAndCollect(client, text) {
  const requestId = randomUUID().slice(0, 8);
  const sentAt = Date.now();
  client.send({ type: "askAssistant", text, requestId });
  const first = await client.waitFor((m) => m.requestId === requestId, "assistantAccepted or error");
  if (first.msg.type === "error") return { error: first.msg };
  const { queryId } = first.msg;
  await client.waitFor((m) => m.type === "assistantDone" && m.queryId === queryId, "assistantDone");
  const mine = client.frames.filter((f) => f.msg.queryId === queryId);
  const start = mine.find((f) => f.msg.type === "assistantStart");
  const deltas = mine.filter((f) => f.msg.type === "assistantDelta");
  const done = mine.find((f) => f.msg.type === "assistantDone");
  return {
    queryId,
    start: start?.msg,
    deltas: deltas.map((f) => f.msg),
    done: done.msg,
    answer: deltas.map((f) => f.msg.text).join(""),
    acceptedMs: first.at - sentAt,
    firstTextMs: deltas.length ? deltas[0].at - sentAt : undefined,
    totalMs: done.at - sentAt,
  };
}

function checkSequence(r, label) {
  expect(r.start && r.done, `${label}: start and done frames arrived`, r);
  expect(
    r.deltas.every((d, i) => d.seq === i) && r.done.seq === r.deltas.length,
    `${label}: deltas in order, none missing (${r.deltas.length} frames)`,
    r.deltas.map((d) => d.seq)
  );
}

// -----------------------------------------------------------------------------

const { courseId, courseToken } = await courseCredentials();

console.log("creating sessions");
const withCourse = await createSession({ courseId, courseToken });
expect(withCourse.status === 201, "session with the course created", withCourse);
const without = await createSession({});
expect(without.status === 201, "session without a course created", without);
const lookup = await (await fetch(`${base}/sessions/${withCourse.body.sessionCode}`)).json();
expect(lookup.assistant === true, "the course session reports an assistant", lookup);

const student = await audience(withCourse.body.sessionCode);
const bystander = await audience(withCourse.body.sessionCode);
const other = await audience(withCourse.body.sessionCode);

console.log(`asking: ${args.question}`);
const grounded = await askAndCollect(student, args.question);
expect(!grounded.error, "the question was accepted", grounded.error);
checkSequence(grounded, "grounded");
expect(grounded.done.outcome === "answered", "outcome is answered", grounded.done);
expect(grounded.start.sources.length > 0, `sources sent first (${grounded.start.sources.length})`, grounded.start);
expect(grounded.done.citations.length > 0, `the answer cites sources ${JSON.stringify(grounded.done.citations)}`, grounded.done);
console.log("\n----- answer -----");
console.log(grounded.answer);
console.log("----- sources -----");
for (const s of grounded.start.sources) console.log(`[${s.n}] ${s.title}${s.page ? `, p. ${s.page}` : ""}`);
console.log(
  `------------------\n       accepted ${grounded.acceptedMs} ms, first text ${grounded.firstTextMs} ms, done ${grounded.totalMs} ms\n`
);

console.log("asking again inside the cooldown");
const tooSoon = await askAndCollect(student, args.question);
expect(tooSoon.error?.code === "RATE_LIMITED", "a second ask within 10 s is RATE_LIMITED", tooSoon);

console.log(`asking off-topic: ${args.offtopic}`);
const offtopic = await askAndCollect(other, args.offtopic);
expect(!offtopic.error, "the off-topic question was accepted", offtopic.error);
checkSequence(offtopic, "off-topic");
expect(offtopic.done.outcome === "not_found", "outcome is not_found", offtopic.done);
expect(offtopic.start.sources.length === 0, "no sources shown for a non-answer", offtopic.start);
console.log(`       "${offtopic.answer}" (${offtopic.totalMs} ms)`);

console.log("asking in a session without a course");
const lonely = await audience(without.body.sessionCode);
const unavailable = await askAndCollect(lonely, args.question);
expect(unavailable.error?.code === "ASSISTANT_UNAVAILABLE", "ASSISTANT_UNAVAILABLE", unavailable);

const leaked = bystander.frames.filter((f) => String(f.msg.type).startsWith("assistant"));
expect(leaked.length === 0, "a bystander in the same session received no assistant frames", leaked);

for (const c of [student, bystander, other, lonely]) c.ws.close();
console.log(`\nall checks passed. session=${withCourse.body.sessionCode} queryId=${grounded.queryId}`);
