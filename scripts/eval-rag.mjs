#!/usr/bin/env node
/**
 * Evaluate the course assistant against the cases in packages/rag/eval/cases.json.
 *
 *   npm run eval:rag                      retrieval only (default)
 *   npm run eval:rag -- --answers --http <HttpUrl> --ws <WebSocketUrl>
 *
 * It runs against a deployed stage and a course that holds ONLY the eval
 * fixture (packages/rag/eval/fixtures/algorithms-lecture.pdf), so page numbers
 * in the cases mean something. The course comes from --course, or from
 * `.env.eval-course` (BACKROW_EVAL_COURSE_ID, plus BACKROW_EVAL_COURSE_TOKEN
 * for --answers). Create one with:
 *
 *   node scripts/ingest-smoke.mjs --http <HttpUrl> --name "RAG eval" \
 *     --file packages/rag/eval/fixtures/algorithms-lecture.pdf
 *
 * Retrieval mode calls Titan and S3 Vectors directly with your AWS credentials
 * (a fraction of a cent) and reports, per question, the top similarity score
 * and whether a passage from the expected page was retrieved above the score
 * floor. This is how the floor is tuned.
 *
 * Answer mode asks each question through the real WebSocket path and checks the
 * outcome, the cited pages and required phrases. It calls the model, so it
 * costs roughly $0.002 per answerable case and uses the course's daily
 * allowance. Not for CI: run it on demand.
 *
 * Exits non-zero if --min-hit / --min-outcome thresholds are given and missed.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string", default: "packages/rag/eval/cases.json" },
    course: { type: "string" },
    org: { type: "string", default: "default" },
    env: { type: "string", default: "dev" },
    region: { type: "string", default: "us-east-1" },
    floor: { type: "string", default: "0.2" },
    "top-k": { type: "string", default: "8" },
    answers: { type: "boolean", default: false },
    http: { type: "string" },
    ws: { type: "string" },
    "min-hit": { type: "string" },
    "min-outcome": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const FLOOR = Number(args.floor);
const TOP_K = Number(args["top-k"]);

async function envFile() {
  try {
    return Object.fromEntries(
      (await readFile(".env.eval-course", "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );
  } catch {
    return {};
  }
}
const fileEnv = await envFile();
const courseId = args.course ?? process.env.BACKROW_EVAL_COURSE_ID ?? fileEnv.BACKROW_EVAL_COURSE_ID;
const courseToken = process.env.BACKROW_EVAL_COURSE_TOKEN ?? fileEnv.BACKROW_EVAL_COURSE_TOKEN;
if (!courseId) {
  console.error("no course: pass --course <id> or create .env.eval-course (see the header of this script)");
  process.exit(2);
}

const { cases } = JSON.parse(await readFile(args.cases, "utf8"));
const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const pad = (s, n) => String(s).padEnd(n);

// --- retrieval -----------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({ region: args.region });
const vectors = new S3VectorsClient({ region: args.region });

async function embed(text) {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: 512, normalize: true }),
    })
  );
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

async function retrieve(question) {
  const res = await vectors.send(
    new QueryVectorsCommand({
      vectorBucketName: `backrow-${args.env}-vectors`,
      indexName: `chunks-${args.org}-${courseId}`,
      queryVector: { float32: await embed(question) },
      topK: TOP_K,
      returnDistance: true,
      returnMetadata: true,
    })
  );
  return (res.vectors ?? []).map((v) => ({
    score: 1 - v.distance,
    pageStart: v.metadata?.pageStart,
    pageEnd: v.metadata?.pageEnd ?? v.metadata?.pageStart,
  }));
}

const covers = (chunk, pages) => pages.some((p) => chunk.pageStart <= p && p <= chunk.pageEnd);

async function retrievalEval() {
  const rows = [];
  for (const c of cases) {
    const found = await retrieve(c.question);
    const kept = found.filter((f) => f.score >= FLOOR);
    rows.push({
      id: c.id,
      expect: c.expect,
      kind: c.kind,
      top: found[0]?.score ?? 0,
      passesFloor: kept.length > 0,
      hit1: c.pages ? Boolean(kept[0] && covers(kept[0], c.pages)) : undefined,
      hitK: c.pages ? kept.some((k) => covers(k, c.pages)) : undefined,
    });
  }

  const answerable = rows.filter((r) => r.expect === "answered");
  const unrelated = rows.filter((r) => r.kind === "unrelated");
  const near = rows.filter((r) => r.kind === "near");
  const summary = {
    floor: FLOOR,
    topK: TOP_K,
    answerable: answerable.length,
    hitAt1: answerable.filter((r) => r.hit1).length,
    hitAtK: answerable.filter((r) => r.hitK).length,
    refusedByFloor: answerable.filter((r) => !r.passesFloor).map((r) => r.id),
    unrelated: unrelated.length,
    unrelatedStoppedByFloor: unrelated.filter((r) => !r.passesFloor).length,
    near: near.length,
    nearReachingModel: near.filter((r) => r.passesFloor).length,
    lowestAnswerableScore: Math.min(...answerable.map((r) => r.top)),
    highestUnrelatedScore: Math.max(...unrelated.map((r) => r.top)),
  };

  if (args.json) {
    console.log(JSON.stringify({ rows, summary }, null, 2));
  } else {
    console.log(`\nretrieval, course ${courseId}, floor ${FLOOR}, top ${TOP_K}\n`);
    console.log(`${pad("case", 22)}${pad("expect", 11)}${pad("top", 7)}${pad("floor", 7)}${pad("hit@1", 7)}hit@k`);
    for (const r of rows) {
      const mark = (v) => (v === undefined ? "-" : v ? "yes" : "NO");
      console.log(
        `${pad(r.id, 22)}${pad(r.expect, 11)}${pad(r.top.toFixed(3), 7)}${pad(r.passesFloor ? "pass" : "stop", 7)}${pad(mark(r.hit1), 7)}${mark(r.hitK)}`
      );
    }
    console.log(`
answerable questions:   ${summary.answerable}
  expected page in top ${TOP_K}:  ${summary.hitAtK}/${summary.answerable} (${pct(summary.hitAtK, summary.answerable)})
  expected page ranked 1st: ${summary.hitAt1}/${summary.answerable} (${pct(summary.hitAt1, summary.answerable)})
  wrongly stopped by floor: ${summary.refusedByFloor.length}${summary.refusedByFloor.length ? ` (${summary.refusedByFloor.join(", ")})` : ""}
unrelated questions:    ${summary.unrelatedStoppedByFloor}/${summary.unrelated} stopped by the floor (no model call)
near-miss questions:    ${summary.nearReachingModel}/${summary.near} pass the floor and rely on the model to decline
score gap:              lowest answerable ${summary.lowestAnswerableScore.toFixed(3)}, highest unrelated ${summary.highestUnrelatedScore.toFixed(3)}
`);
  }
  return summary;
}

// --- answers ---------------------------------------------------------------------

async function createSession() {
  const res = await fetch(`${args.http.replace(/\/$/, "")}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ courseId, courseToken }),
  });
  if (res.status !== 201) throw new Error(`could not create a session: HTTP ${res.status}`);
  return (await res.json()).sessionCode;
}

/** Ask one question on its own socket (a fresh client id, so no cooldown). */
function ask(sessionCode, question) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(args.ws);
    const out = { deltas: [], sources: [], startedAt: 0 };
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out"));
    }, 60_000);
    const finish = (value) => {
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    ws.addEventListener("error", () => reject(new Error("socket error")));
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "join", sessionCode, clientId: `eval-${randomUUID()}` }))
    );
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "joined") {
        out.startedAt = Date.now();
        ws.send(JSON.stringify({ type: "askAssistant", text: question }));
      } else if (m.type === "error") finish({ error: m.code });
      else if (m.type === "assistantStart") Object.assign(out, { sources: m.sources, cached: m.cached });
      else if (m.type === "assistantDelta") out.deltas[m.seq] = m.text;
      else if (m.type === "assistantDone") {
        finish({
          outcome: m.outcome,
          citations: m.citations,
          sources: out.sources,
          cached: out.cached,
          answer: out.deltas.join(""),
          ms: Date.now() - out.startedAt,
        });
      }
    });
  });
}

async function answerEval() {
  if (!args.http || !args.ws || !courseToken) {
    console.error("--answers needs --http, --ws and BACKROW_EVAL_COURSE_TOKEN (or .env.eval-course)");
    process.exit(2);
  }
  const sessionCode = await createSession();
  const rows = [];
  for (const c of cases) {
    const r = await ask(sessionCode, c.question).catch((err) => ({ error: err.message }));
    const cited = (r.citations ?? []).map((n) => r.sources?.find((s) => s.n === n)).filter(Boolean);
    const row = {
      id: c.id,
      expect: c.expect,
      got: r.error ?? r.outcome,
      outcomeOk: r.outcome === c.expect,
      cached: r.cached,
      ms: r.ms,
    };
    if (c.expect === "answered" && r.outcome === "answered") {
      // A citation is correct when its passage starts on or just before an
      // expected page: passages span page breaks, and sources carry the first page.
      row.cites = cited.length;
      row.citesOk = cited.filter((s) => c.pages.some((p) => s.page === p || s.page === p - 1)).length;
      row.mentionOk = (c.mention ?? []).every((m) => r.answer.toLowerCase().includes(m.toLowerCase()));
      row.answer = r.answer;
    }
    rows.push(row);
    process.stderr.write(row.outcomeOk ? "." : "x");
  }
  process.stderr.write("\n");

  const answerable = rows.filter((r) => r.expect === "answered");
  const answered = answerable.filter((r) => r.outcomeOk);
  const declined = rows.filter((r) => r.expect === "not_found");
  const times = rows.filter((r) => r.ms && !r.cached).map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    cases: rows.length,
    outcomeCorrect: rows.filter((r) => r.outcomeOk).length,
    answeredWhenShould: answered.length,
    answerable: answerable.length,
    declinedWhenShould: declined.filter((r) => r.outcomeOk).length,
    shouldDecline: declined.length,
    hallucinated: declined.filter((r) => r.got === "answered").map((r) => r.id),
    citations: answered.reduce((n, r) => n + r.cites, 0),
    citationsCorrect: answered.reduce((n, r) => n + r.citesOk, 0),
    uncited: answered.filter((r) => r.cites === 0).map((r) => r.id),
    mentionCorrect: answered.filter((r) => r.mentionOk).length,
    medianMs: times[Math.floor(times.length / 2)],
  };

  if (args.json) {
    console.log(JSON.stringify({ rows, summary }, null, 2));
  } else {
    console.log(`\nanswers, course ${courseId}, session ${sessionCode}\n`);
    console.log(`${pad("case", 22)}${pad("expect", 11)}${pad("got", 11)}${pad("cites", 8)}${pad("phrases", 9)}ms`);
    for (const r of rows) {
      console.log(
        `${pad(r.id, 22)}${pad(r.expect, 11)}${pad(r.got + (r.outcomeOk ? "" : " !"), 11)}${pad(r.cites === undefined ? "-" : `${r.citesOk}/${r.cites}`, 8)}${pad(r.mentionOk === undefined ? "-" : r.mentionOk ? "yes" : "NO", 9)}${r.ms ?? "-"}`
      );
    }
    console.log(`
outcome correct:        ${summary.outcomeCorrect}/${summary.cases} (${pct(summary.outcomeCorrect, summary.cases)})
  answered when covered:  ${summary.answeredWhenShould}/${summary.answerable}
  declined when not:      ${summary.declinedWhenShould}/${summary.shouldDecline}${summary.hallucinated.length ? `  ANSWERED ANYWAY: ${summary.hallucinated.join(", ")}` : ""}
citation precision:     ${summary.citationsCorrect}/${summary.citations} (${pct(summary.citationsCorrect, summary.citations)})${summary.uncited.length ? `  uncited: ${summary.uncited.join(", ")}` : ""}
required phrases:       ${summary.mentionCorrect}/${summary.answeredWhenShould}
median time to done:    ${summary.medianMs ?? "n/a"} ms (uncached)
`);
  }
  return summary;
}

// -----------------------------------------------------------------------------

let failed = false;
if (args.answers) {
  const s = await answerEval();
  if (args["min-outcome"] && s.outcomeCorrect / s.cases < Number(args["min-outcome"])) failed = true;
} else {
  const s = await retrievalEval();
  if (args["min-hit"] && s.hitAtK / s.answerable < Number(args["min-hit"])) failed = true;
}
if (failed) {
  console.error("below the required threshold");
  process.exit(1);
}
