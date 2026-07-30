# ADR 0001 — Phase 0 foundational decisions (cheapest-first)

Status: Accepted
Date: 2026-07-29
Deciders: Rohan + teammate (two-person team)

## Context

Before scaffolding, we lock the section 3 decisions from the roadmap. The
overriding constraint for this project is cost: it is a student/pilot-scale
build, so wherever a choice trades money for scale we haven't proven we need,
we take the cheap option and revisit only when a load test says otherwise.

The key cost insight (roadmap section 9): Lambda, DynamoDB on-demand, API
Gateway, S3/CloudFront all scale to zero — they cost near nothing idle. The
expensive line items are the *always-on* services: Redis and a vector store.
Cheapest-first means deferring or avoiding those until a phase actually needs
them.

## Decisions

| Decision | Chosen (cheapest) | Why / cost note |
|---|---|---|
| IaC tool | **AWS CDK (TypeScript)** | All IaC tools are free; CDK keeps types shared with app code and matches our TS/Node strength. |
| Realtime fan-out | **Lambda loops over the connection table (no Redis)** | Redis is an always-on cost. At single-classroom scale (a few hundred connections) a Lambda that queries the DynamoDB connection list and calls `PostToConnection` per client is fast enough and costs nothing extra. Add Redis pub-sub only if a load test shows fan-out latency missing budget past a few hundred concurrent. |
| Vector store (RAG) | **pgvector on the smallest RDS (t-class), or deferred until Phase 3** | Avoids OpenSearch Serverless's ~$350/mo floor. Do not stand up the DB until Phase 3 ingestion work begins. |
| LLM + embeddings | **Bedrock, pay-per-token** | No idle/hosting cost; pay only per request. Behind an interface so we can swap providers if cost/latency disappoints. |
| Redis flavor | **None in the cheap path.** If ever needed: ElastiCache Serverless, shut down when not testing. | Not provisioned in Phase 0 or the default Phase 1 path. |
| Frontend | **React + Vite SPA** on S3 + CloudFront | Static hosting, no SSR server to pay for. |
| Auth | **Anonymous join codes (audience) + Cognito free tier (presenters)** | Anonymous codes are free and keep audience friction near zero; Cognito's free tier covers presenter volume. |

## Consequences

- Phase 0 provisions only scale-to-zero resources: API Gateway (WebSocket +
  HTTP), one Lambda, one DynamoDB table (on-demand), one SSM parameter. Idle
  cost is effectively zero.
- The Phase 1 "Redis pub-sub fan-out" task becomes **"Lambda fan-out over the
  connection table."** Keep the fan-out logic behind a small interface so a
  Redis-backed implementation can be dropped in later without touching
  handlers.
- We still set an AWS Budgets alarm in Phase 0 (roadmap action #5) so any
  accidental always-on resource pings us within a day.
- Revisit triggers: if a Phase 2 load test at 200–500 clients misses the
  latency budget, reconsider Redis pub-sub; if Phase 3 retrieval latency on a
  t-class RDS disappoints, reconsider Aurora Serverless v2.

## Config / secrets strategy

Non-secret config lives in **SSM Parameter Store** as a JSON document at
`/backrow/<env>/config`, read by Lambda on cold start. Secrets (when we have
any) use SSM `SecureString` or Secrets Manager. No secret values in the repo;
`.env.example` documents the shape only.
