# Backrow

Serverless real-time audience engagement platform on AWS — live polls, Q&A,
reactions, and a RAG course-assistant. API Gateway WebSockets + Lambda +
DynamoDB, with cost-first infrastructure (see `docs/adr/0001`).

This repo is currently at **Phase 0 — Foundations**: a reproducible skeleton
both engineers can deploy independently. See `docs/roadmap.md` for the full
plan.

## Repo layout

```
backrow/
  infra/            # CDK app: WebSocket + HTTP API, Lambda, DynamoDB, SSM
  packages/
    shared/         # message schemas, types, table keys (the A<->B contract)
    realtime/       # WebSocket Lambda handlers (Phase 0: one placeholder)
    features/       # poll, qa, reactions handlers (Phase 2)
    rag/            # ingestion + retrieval + generation (Phase 3)
  apps/
    audience/       # React + Vite audience app (Phase 1+)
    presenter/      # React + Vite presenter console (Phase 1+)
  scripts/          # load test, seed, eval runner
  docs/             # roadmap, ADRs, branching
```

## Prerequisites

- Node.js 20 (`.nvmrc` pins it; `nvm use`)
- An AWS account and credentials in your shell (SSO profile or keys)
- AWS CDK bootstrap in the target account/region, once per account:
  `npx cdk bootstrap` (run from `infra/`)

## Dev loop

```bash
# 1. Install everything (npm workspaces — one install from the root)
npm install

# 2. Build, lint, typecheck, and run unit tests (what CI runs on every PR)
npm run build
npm run lint
npm run typecheck
npm test

# 3. Synthesize the CloudFormation without deploying (no AWS creds needed)
npm run synth

# 4. Deploy the dev stack (needs AWS creds; env name defaults to "dev")
npm run deploy:dev
```

`deploy:dev` prints outputs you'll need:

- `WebSocketUrl` — `wss://…` connect URL
- `HttpUrl` — HTTP API base; health check at `/health`
- `TableName`, `ConfigParamName`

### Smoke test after deploy

```bash
curl "<HttpUrl>/health"        # -> {"status":"ok",...}
npx wscat -c "<WebSocketUrl>"  # connects; type anything, get "ok:$default"
```

## Configuration & secrets

Non-secret app config is a JSON document in **SSM Parameter Store** at
`/backrow/<env>/config`, read by Lambda on cold start. Secrets (when we have
any) go in SSM `SecureString` or Secrets Manager — never in the repo.
`.env.example` documents local shell variables; copy it to `.env` (gitignored).

See `docs/adr/0001-phase0-decisions.md` for why, and the cost posture.

## Cost note

Everything in Phase 0 is scale-to-zero (API Gateway, Lambda, DynamoDB
on-demand, SSM) — near-zero idle cost. We deliberately avoid always-on
services (Redis, a vector store) until a later phase proves we need them.
**Set an AWS Budgets alarm before deploying** (roadmap action #5) so a mistake
pings you within a day.

## CI

GitHub Actions (`.github/workflows/ci.yml`):

- On every PR and push: install, build, lint, typecheck, test, `cdk synth`.
- On merge to `main`: deploy the dev stack (via an OIDC role — set the
  `AWS_DEPLOY_ROLE_ARN` secret and `AWS_REGION` variable in repo settings).

## Contributing

Trunk-based flow, PRs required, `main` auto-deploys to dev. See
`docs/branching.md`. Anything touching `packages/shared` is the shared
contract — both engineers review.
