# Phase 3.2 — Course assistant: setup and verification

This gets the course assistant answering questions in your own AWS account and
shows how to check it. It assumes Phase 3.1 is deployed and you have a course
with at least one `ready` document (`PHASE3.1-SETUP.md`). Allow about 20
minutes, most of it waiting for Bedrock model access.

## What this phase adds

```
student ── askAssistant ──▶ $default (message Lambda)
                              member? course attached? cooldown, daily budget
                              write the ask, invoke answer async (ids only)
        ◀─ assistantAccepted
                              answer Lambda
                                exact cache ─ hit ─▶ replay
                                embed (Titan) ─▶ semantic cache + retrieve (S3 Vectors)
                                nothing relevant ─▶ "not in the course material"
                                Haiku 4.5 (stream) ─▶ cache the answer
        ◀─ assistantStart, assistantDelta…, assistantDone     (asker only)

presenter ── getAssistantInsights ──▶ counts + topics several students asked
```

New resources: one Lambda (`backrow-<env>-answer`) and one SQS queue for failed
invokes. Nothing always-on.

## 1. Enable Claude on Bedrock

Two things, both in us-east-1, both one-time per account.

**Submit Anthropic's use-case form.** Bedrock refuses every Claude call until
the account has done this, with:

> Model use case details have not been submitted for this account.

Open the [Bedrock console](https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess),
choose Claude Haiku 4.5 in the model catalog (or open it in the playground) and
submit the use case details. Access follows within about 15 minutes.

**Check it worked:**

```bash
aws bedrock-runtime converse --region us-east-1 \
  --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Say ok."}]}]' \
  --inference-config '{"maxTokens":5}' \
  --query "output.message.content[0].text" --output text
# -> ok
```

The model is reached through the `us.` inference profile, which can serve a
request from us-east-1, us-east-2 or us-west-2. Data stays in the US but is not
pinned to one region (ADR 0002).

## 2. Deploy

```bash
npm install
npm run deploy:dev
```

Options, all `--context` values on `cdk deploy` (run from `infra/`):

| Context | Default | What it does |
|---|---|---|
| `answerConcurrency` | `20` | How many answers run at once. Needs an account concurrency limit above the default of 10; pass `0` to reserve nothing on such an account. |
| `assistantDailyLimit` | `200` | Asks per course per UTC day. The cost ceiling: about $1 a day per course at the default. |
| `assistantGuardrailId`, `assistantGuardrailVersion` | unset | Apply a Bedrock Guardrail to each question. Off unless set. |

```bash
aws lambda get-account-settings --query "AccountLimit.ConcurrentExecutions"
cd infra && npx cdk deploy Backrow-dev --context env=dev --context assistantDailyLimit=100
```

## 3. Run the end-to-end check

Put your course's id and token in a file git ignores:

```bash
cat > .env.dev-course <<'EOF'
BACKROW_DEV_COURSE_ID=<courseId>
BACKROW_DEV_COURSE_TOKEN=<courseToken>
EOF

node scripts/assistant-smoke.mjs --http "<HttpUrl>" --ws "<WebSocketUrl>" \
  --question "<something your document answers>"
```

It asks one question the material covers and one it doesn't, and checks the
streamed answer, its citations, the cache (a second student asking the same
thing), the cooldown, a session with no course, that no other socket sees an
answer, and the presenter's insights. Every line should read `ok`. Cost: about
a cent.

Before model access is granted you can still run everything that doesn't call
the model:

```bash
node scripts/assistant-smoke.mjs --http "<HttpUrl>" --ws "<WebSocketUrl>" --skip-generation
```

## 4. Run the eval

The eval set is 25 questions over a six-page synthetic lecture
(`packages/rag/eval/`). It needs a course holding only that document:

```bash
export BACKROW_CREATOR_KEY="$(aws ssm get-parameter --name /backrow/dev/course-creator-key \
  --with-decryption --query Parameter.Value --output text)"
node scripts/ingest-smoke.mjs --http "<HttpUrl>" --name "RAG eval" \
  --file packages/rag/eval/fixtures/algorithms-lecture.pdf
# put the printed id and token in .env.eval-course as
# BACKROW_EVAL_COURSE_ID / BACKROW_EVAL_COURSE_TOKEN
```

```bash
npm run eval:rag                       # retrieval only; a fraction of a cent
npm run eval:rag -- --answers --http "<HttpUrl>" --ws "<WebSocketUrl>"   # ~5 cents
```

Retrieval mode reports, for each question, the top similarity score, whether it
clears the score floor, and whether the right page was retrieved. Answer mode
asks each question through the real WebSocket path and reports whether the
outcome was right, whether the citations point at the right pages, and whether
anything was answered that should have been declined.

Run it after changing the chunk size, the floor, the prompt or the model. It
calls AWS and costs money, so it is not part of CI.

To edit the fixture, change `fixtures/algorithms-lecture.pages.json`, run
`npm run eval:fixture`, re-upload, and commit both files.

## 5. Look at what was stored

```bash
# Asks in a session: status, outcome, scores, cache tier. Question text is in
# `text`; nothing identifies the student.
aws dynamodb query --table-name backrow-dev \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"ASK#<sessionCode>"}}'

# The answer log: ids, numbers and error class names only.
aws logs tail /aws/lambda/backrow-dev-answer --since 15m

# Today's ask count for a course.
aws dynamodb get-item --table-name backrow-dev \
  --key '{"PK":{"S":"ORG#default#COURSE#<courseId>#BUDGET#<yyyy-mm-dd>"},"SK":{"S":"COUNT"}}'
```

## Tuning

| Setting | Where | Default | Notes |
|---|---|---|---|
| Score floor | `ASSISTANT_MIN_SCORE` on the answer Lambda | `0.2` | Below this, no model call. |
| Semantic cache threshold | `ASSISTANT_CACHE_THRESHOLD` | `0.94` | Lower means more cache hits and more risk of a wrong one. |
| Chunks retrieved | `ASSISTANT_TOP_K` | `8` | |
| Chunk size | `DEFAULT_CHUNK_OPTIONS` in `packages/rag/src/chunker.ts` | 450 / 600 / 80 | Changing it only affects documents uploaded afterwards. |
| Model | `ANSWER_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Also update the IAM resources in `infra/lib/rag-assistant.ts`. |

Each default has its measurement recorded next to it in the code, and in
`docs/adr/0003-assistant-query-path.md`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every answer is "Sorry, something went wrong", log shows `ResourceNotFoundException` | Step 1 not done: the Anthropic use-case form. |
| Log shows `AccessDeniedException` | Model access not granted, or the model id was changed without updating IAM. |
| Everything is "I couldn't find that in the course material" | The course has no `ready` documents, or they were ingested before the chunk size changed: re-upload them. Check `topScore` on the ask record. |
| `ASSISTANT_UNAVAILABLE` | The session was created without `courseId` and `courseToken`. |
| `ASSISTANT_BUSY` | The course reached its daily limit. It resets at midnight UTC. |
| `assistantAccepted` arrives but nothing follows | The answer Lambda is throttled past 60 s, or crashed. Check `backrow-<env>-answer-dlq`. |
| Deploy fails on `ReservedConcurrentExecutions` | Account concurrency limit too low for the reservation. Deploy with `--context answerConcurrency=0`. |
| Insights show no topics | A topic needs the same answer to have been asked from two different connections. |
