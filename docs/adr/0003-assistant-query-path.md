# ADR 0003 — The course assistant's query path

Status: Accepted
Date: 2026-11-16
Deciders: Rohan + teammate
Builds on: ADR 0002 (storage and ingestion)

## Context

Phase 3.2 lets a student ask the course assistant a question during a live
session and get an answer grounded in the uploaded course material. The
constraints that shaped it, in priority order:

1. **Cost.** Nothing may run when nobody is asking, and a full lecture hall must
   not be able to run up an unbounded bill.
2. **The realtime path must not be hurt.** Votes and reactions share the
   account's Lambda concurrency and the `$default` handler.
3. **Student privacy.** A question to the assistant is private to the student.
   The instructor sees aggregates only.
4. **Grounding.** An answer that isn't in the course material is worse than no
   answer.

## Decisions

| Decision | Chosen | Why |
|---|---|---|
| Entry point | **`askAssistant` on the existing `$default` route** | No new route, so the one-integration-per-route rule can't be broken, and the message Lambda already resolves membership. |
| Where generation runs | **A separate answer Lambda, invoked asynchronously** | API Gateway gives a WebSocket integration 29 s and silently drops a throttled synchronous invoke. Lambda queues an async invoke, so a burst waits instead of vanishing. |
| What crosses the hand-off | **`{sessionCode, queryId}` only** | Student text never sits in Lambda's internal queue or the failure queue. |
| Retries | **None; 60 s maximum event age** | A retry would stream a second copy of the answer. An answer a minute late is useless. |
| Concurrency | **Reserved, 20 on dev** | Caps simultaneous Bedrock calls and keeps the realtime handlers' concurrency free. Free, unlike provisioned concurrency. |
| Delivery | **`PostToConnection` to the asker only, through a sink bound to that connection** | Nothing on the answer path is able to fan out. |
| Frame protocol | **`assistantStart` → `assistantDelta`×n → `assistantDone`, for every outcome** | One client renderer for generated, cached, not-found, refused and error replies. |
| Streaming | **Coalesce tokens: flush at 120 ms or 512 characters** | One push per token would be hundreds of sequential API calls and would fall behind the model. |
| Grounding | **Score floor, then a model-side sentinel** | The floor (cosine 0.2) stops unrelated questions before any model call. The sentinel `<<NOT_IN_SOURCES>>` handles on-subject questions the material doesn't cover, and is caught before any text is sent. |
| Chunk size | **~450 characters (was ~1,600)** | See "The chunk size changed" below. |
| Answer cache | **Two tiers, keyed on `corpusVersion`** | Exact match is one `GetItem` before any Bedrock call. Semantic match uses a per-course S3 Vectors index of question embeddings with a strict threshold (0.94). |
| Cache invalidation | **By version, never by delete** | Ingest and delete bump the course's `corpusVersion`; old entries become unreachable and expire by TTL. |
| Cost ceiling | **Per-course daily ask cap (200), per-client cooldown (10 s)** | Both are conditional writes, so a burst can't overshoot. |
| Instructor view | **Counts, plus topics that asks from ≥ 2 connections share** | A topic is a cached answer several asks resolved to. A question one student asked is never surfaced. |
| Input guardrail | **Behind an interface, off by default** | The floor, the system prompt and private delivery cover a pilot. A Bedrock Guardrail is a deploy-time switch when an institution wants one. |
| Model | **Claude Haiku 4.5 via the `us.` inference profile** | As ADR 0002. Behind `LlmProvider`, so changing it is configuration. |

## The chunk size changed

Ingestion (ADR 0002) shipped with ~1,600-character chunks. The eval set built
for this phase (`npm run eval:rag`, 18 answerable and 7 unanswerable questions
over a six-page synthetic lecture) showed that was wrong for this use.

A student's question is one sentence. Compared against a 1,600-character chunk
that covers several topics, a specific fact ("when are office hours?", "what is
the late penalty?") scored no higher than a question about pancakes, so no score
floor could keep one and drop the other:

| target / max / overlap | right page ranked first | answerable stopped at 0.2 | lowest answerable | highest unrelated |
|---|---|---|---|---|
| 1600 / 2000 / 200 | 16 of 18 | 4 | 0.143 | 0.145 |
| 1000 / 1300 / 150 | 16 of 18 | 3 | 0.154 | 0.152 |
| 700 / 900 / 120 | 16 of 18 | 1 | 0.176 | 0.173 |
| **450 / 600 / 80** | **17 of 18** | **0** | **0.220** | **0.160** |

(Titan Text Embeddings v2, 512 dimensions, measured locally over the fixture's
page text.) At ~450 characters the two groups separate, and the 0.2 floor sits
in the gap. The cost is 3–4× the vectors per document, which is negligible in
S3 Vectors, and less context per retrieved chunk, which is made up by fetching 8
chunks instead of 6. The prompt still shrinks to under half its previous size,
so each answer costs less.

Documents ingested before this change keep their old chunks until re-uploaded.

## Consequences

**Semantic-cache misses are the safe failure.** At 0.94, looser rewordings of a
cached question miss and are generated again. The alternative failure, showing
a student the answer to a different question, is the one to avoid: "What is a
deadlock?" and "What is not a deadlock?" score 0.895.

**An abandoned answer is finished, not cancelled.** If the asker's socket
closes mid-answer, frames stop but generation runs to the end and the answer is
cached, so a retry after reconnecting is instant. That spends a fraction of a
cent on an answer nobody may read.

**Insights are per session and lossy by design.** Topics come from cached
answers, so a question that was never answered (not found, refused, error) has
no topic. Distinct askers are counted by connection id; a student who reconnects
can count twice, because a stable id is deliberately not stored on asks.

**Question-cache vectors are not deleted** when the corpus version changes.
They are filtered out of every query and cost fractions of a cent to store; a
sweep can be added if a long-lived course accumulates enough to matter.

**One more thing can be mis-set.** The floor, the cache threshold and the chunk
size were each measured on a small synthetic fixture. They are environment
variables and constants with the measurement recorded next to them; re-run the
eval on real course material before trusting them for a pilot.

## Revisit when

- The eval on real course material shows the floor or the cache threshold in
  the wrong place.
- Near-miss questions (on-subject, not covered) are answered anyway → tighten
  the system prompt or add a second, cheaper relevance check.
- A long-lived course accumulates enough stale question vectors to matter →
  add a sweep on `corpusVersion` change.
- An institution requires a content policy → enable the Bedrock Guardrail.
