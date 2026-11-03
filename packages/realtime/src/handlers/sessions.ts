/**
 * HTTP API — session lifecycle and health.
 *
 *   POST /sessions          create a session, return its join code + presenter token.
 *                           Optional body {courseId, courseToken} attaches the
 *                           course whose material the assistant answers from.
 *   GET  /sessions/{code}   look up a session (used to validate a code before joining)
 *   GET  /health            liveness, and the one place SSM config is still read
 *
 * The presenter token is returned exactly once, at creation. It is never
 * readable afterwards — GET deliberately omits it. Until Cognito lands in
 * Phase 4, holding that token is what authorizes presenter control.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";
import {
  generateSessionCode,
  generatePresenterToken,
  normalizeSessionCode,
  isValidSessionCode,
  safeEqual,
  createSessionRequestSchema,
  DEFAULT_ORG_ID,
} from "@backrow/shared";
import {
  createSession,
  getSession,
  getCourseTokenHash,
  ConditionFailed,
} from "../lib/ddb";

const bytes = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

const json = (
  statusCode: number,
  body: unknown
): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    // The audience and presenter SPAs are served from CloudFront, a different
    // origin. Phase 4 hardening replaces this with an explicit allow-list.
    "access-control-allow-origin": "*",
  },
  body: JSON.stringify(body),
});

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === "GET" && path === "/health") return await health();
    if (method === "POST" && path === "/sessions") return await create(event);
    if (method === "GET" && path.startsWith("/sessions/")) {
      return await lookup(path.slice("/sessions/".length));
    }
    return json(404, { error: "not found" });
  } catch (err) {
    console.error("request failed", { method, path, err });
    return json(500, { error: "internal error" });
  }
}

/**
 * Create a session.
 *
 * Retries on code collision. The conditional write in createSession is what
 * makes a duplicate code impossible; this loop just picks a new one. Three
 * attempts against a 244-million-code space is generous.
 */
async function create(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResult> {
  const binding = await resolveCourseBinding(event);
  if ("statusCode" in binding) return binding;
  const course = binding.course;

  const presenterToken = generatePresenterToken(bytes);

  for (let attempt = 0; attempt < 3; attempt++) {
    const sessionCode = generateSessionCode(bytes);
    try {
      const session = await createSession({
        sessionCode,
        presenterToken,
        nowMs: Date.now(),
        course,
      });
      console.log("session created", { sessionCode, courseId: course?.courseId });
      return json(201, {
        sessionCode: session.sessionCode,
        state: session.state,
        createdAt: session.createdAt,
        courseId: session.courseId,
        // Returned once, never again. The presenter must keep it.
        presenterToken,
      });
    } catch (err) {
      if (err instanceof ConditionFailed) {
        console.warn("session code collision, retrying", { sessionCode });
        continue;
      }
      throw err;
    }
  }

  return json(503, { error: "could not allocate a session code, try again" });
}

/**
 * Validate the optional course binding before anything is written, so a bad or
 * missing token means no session at all — never a session silently created
 * without its assistant.
 *
 * The token is compared hash-to-hash in constant time (the same `safeEqual` as
 * presenterJoin); only the hash was ever stored. An unknown course and a wrong
 * token get the same 403, so this can't be used to probe which course ids exist.
 */
async function resolveCourseBinding(
  event: APIGatewayProxyEventV2
): Promise<
  | { course?: { orgId: string; courseId: string } }
  | APIGatewayProxyResult
> {
  let body: unknown = {};
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "body is not valid JSON", code: "BAD_REQUEST" });
    }
  }

  const parsed = createSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(400, {
      error: `${first.path.join(".")}: ${first.message}`,
      code: "BAD_REQUEST",
    });
  }

  const { courseId, courseToken } = parsed.data;
  if (!courseId) return {};
  if (!courseToken) {
    return json(401, {
      error: "courseToken is required to attach a course",
      code: "COURSE_TOKEN_REQUIRED",
    });
  }

  const orgId = DEFAULT_ORG_ID;
  const storedHash = await getCourseTokenHash(orgId, courseId);
  const presentedHash = createHash("sha256").update(courseToken, "utf8").digest("hex");
  if (!storedHash || !safeEqual(presentedHash, storedHash)) {
    return json(403, {
      error: "unknown course or invalid course token",
      code: "INVALID_COURSE_TOKEN",
    });
  }
  return { course: { orgId, courseId } };
}

async function lookup(rawCode: string): Promise<APIGatewayProxyResult> {
  const sessionCode = normalizeSessionCode(decodeURIComponent(rawCode));

  // Cheap shape check before spending a read.
  if (!isValidSessionCode(sessionCode)) {
    return json(400, { error: "malformed session code" });
  }

  const session = await getSession(sessionCode);
  if (!session) return json(404, { error: "session not found" });

  return json(200, {
    sessionCode: session.sessionCode,
    state: session.state,
    createdAt: session.createdAt,
    // Lets the audience app decide whether to show the assistant at all.
    // The course id itself stays private to the presenter.
    assistant: Boolean(session.courseId),
  });
}

/**
 * Health check. Reads the SSM config document to prove the config path works.
 *
 * This is the ONLY handler that touches SSM. It cost ~2.5s on a cold start in
 * Phase 0, which is unacceptable on the realtime path but harmless here.
 */
async function health(): Promise<APIGatewayProxyResult> {
  const paramName = process.env.CONFIG_PARAM_NAME;
  let configOk = false;

  if (paramName) {
    try {
      const { SSMClient, GetParameterCommand } = await import(
        "@aws-sdk/client-ssm"
      );
      const res = await new SSMClient({}).send(
        new GetParameterCommand({ Name: paramName, WithDecryption: true })
      );
      configOk = Boolean(res.Parameter?.Value);
    } catch (err) {
      console.error("config read failed", { paramName, err });
    }
  }

  return json(200, {
    status: "ok",
    service: "backrow",
    environment: process.env.ENVIRONMENT ?? "unknown",
    phase: 3,
    configOk,
  });
}
