#!/usr/bin/env node
/**
 * End-to-end check of Phase 3.1 ingestion against a deployed stage.
 *
 *   node scripts/ingest-smoke.mjs --http https://... --file lecture.pdf
 *
 * Creates a course (unless --course and --token are given), uploads the file
 * through the presigned POST exactly as a browser would, polls until ingest
 * settles, then creates a session attached to the course and checks that a bad
 * course token is refused. Exits non-zero on any unexpected result.
 *
 * The creator key is read from BACKROW_CREATOR_KEY so it never lands in shell
 * history. Fetch it with:
 *   aws ssm get-parameter --name /backrow/dev/course-creator-key \
 *     --with-decryption --query Parameter.Value --output text
 *
 * Uses only Node 20+ built-ins (fetch, FormData, Blob).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    http: { type: "string" },
    file: { type: "string" },
    course: { type: "string" },
    token: { type: "string" },
    name: { type: "string", default: "Ingest smoke test" },
    timeout: { type: "string", default: "240" },
  },
});

if (!args.http || !args.file) {
  console.error("usage: node scripts/ingest-smoke.mjs --http <HttpUrl> --file <path> [--course <id> --token <t>]");
  process.exit(2);
}
const base = args.http.replace(/\/$/, "");

async function api(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function expect(cond, message, detail) {
  if (cond) {
    console.log(`  ok   ${message}`);
    return;
  }
  console.error(`  FAIL ${message}`, detail ?? "");
  process.exit(1);
}

// --- course ------------------------------------------------------------------

let courseId = args.course;
let courseToken = args.token;

if (!courseId) {
  const key = process.env.BACKROW_CREATOR_KEY;
  if (!key) {
    console.error("set BACKROW_CREATOR_KEY, or pass --course and --token");
    process.exit(2);
  }
  console.log("creating course");
  const bad = await api("POST", "/courses", { body: { name: args.name }, headers: { "x-creator-key": "wrong".repeat(10) } });
  expect(bad.status === 401, "a wrong creator key is refused", bad);

  const res = await api("POST", "/courses", { body: { name: args.name }, headers: { "x-creator-key": key } });
  expect(res.status === 201, "course created", res);
  ({ courseId, courseToken } = res.body);
  console.log(`       courseId=${courseId}  (courseToken printed once below; keep it)`);
  console.log(`       courseToken=${courseToken}`);
}
const auth = { "x-course-token": courseToken };

// --- rejected uploads ----------------------------------------------------------

console.log("checking upload rules");
const pptx = await api("POST", `/courses/${courseId}/documents`, { body: { filename: "deck.pptx", bytes: 1000 }, headers: auth });
expect(pptx.status === 415 && pptx.body.code === "EXPORT_TO_PDF", "slides are told to export to PDF", pptx);
const huge = await api("POST", `/courses/${courseId}/documents`, { body: { filename: "big.pdf", bytes: 26 * 1024 * 1024 }, headers: auth });
expect(huge.status === 413, "an oversized file is refused", huge);
const wrong = await api("GET", `/courses/${courseId}/documents`, { headers: { "x-course-token": "0".repeat(64) } });
expect(wrong.status === 403, "a wrong course token is refused", wrong);

// --- upload ------------------------------------------------------------------

const bytes = await readFile(args.file);
const filename = basename(args.file);
console.log(`uploading ${filename} (${bytes.length} bytes)`);

const start = await api("POST", `/courses/${courseId}/documents`, {
  body: { filename, bytes: bytes.length },
  headers: auth,
});
expect(start.status === 201, "upload URL issued", start);
const { docId, upload, contentType } = start.body;

// Exactly what a browser does: every policy field, then the file last.
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append("file", new Blob([bytes], { type: contentType }), filename);
const s3res = await fetch(upload.url, { method: "POST", body: form });
expect(s3res.status === 204, "S3 accepted the presigned POST", await s3res.text());

// --- wait for ingest -------------------------------------------------------------

console.log("waiting for ingest");
const deadline = Date.now() + Number(args.timeout) * 1000;
let doc;
for (;;) {
  const list = await api("GET", `/courses/${courseId}/documents`, { headers: auth });
  doc = list.body.documents?.find((d) => d.docId === docId);
  if (doc && (doc.status === "ready" || doc.status === "failed")) break;
  if (Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 3000));
}
expect(doc?.status === "ready", `document is ready`, doc);
console.log(`       pages=${doc.pages} chunks=${doc.chunkCount}`);

// --- session binding -------------------------------------------------------------

console.log("checking session binding");
const noToken = await api("POST", "/sessions", { body: { courseId } });
expect(noToken.status === 401, "a session can't attach a course without its token", noToken);
const badToken = await api("POST", "/sessions", { body: { courseId, courseToken: "0".repeat(64) } });
expect(badToken.status === 403, "a session can't attach a course with a wrong token", badToken);
const session = await api("POST", "/sessions", { body: { courseId, courseToken } });
expect(session.status === 201 && session.body.courseId === courseId, "a session attaches with the right token", session);
const lookup = await api("GET", `/sessions/${session.body.sessionCode}`);
expect(lookup.body.assistant === true, "the session reports an assistant", lookup);

console.log(`\nall checks passed. courseId=${courseId} docId=${docId} session=${session.body.sessionCode}`);
