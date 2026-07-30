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

## First-time setup (new developer)

Each developer deploys Backrow into **their own AWS account**. Nobody shares
credentials, and nobody can clobber anyone else's stack. Everything here is
scale-to-zero, so a personal stack costs effectively nothing when idle.

You need Node.js 20+ (`.nvmrc` pins the version) and your own AWS account.

**1. Install and configure the AWS CLI.**

```bash
aws --version          # need v2; install from https://aws.amazon.com/cli/ if missing
aws configure          # access key, secret, region us-east-1, output json
aws sts get-caller-identity   # copy the 12-digit Account value
```

Create the access key under IAM → Users → *your user* → Security credentials →
Create access key → "Command Line Interface (CLI)". Never share or commit it.

**2. Set a budget alarm before deploying anything.** Non-negotiable — it's the
tripwire that catches a mistake in a day instead of at month-end. In the
[Budgets console](https://console.aws.amazon.com/costmanagement/home#/budgets):
Create budget → Customize (advanced) → Cost budget → Monthly, Recurring,
Fixed, **$1** → alert threshold on **Actual** at 80% → your email.

Plain cost budgets and their alerts are free. Skip "budget actions".

If the Budgets console denies you access, sign in as the account root user and
enable **IAM user and role access to Billing information** in Account settings.

**3. Bootstrap your account.** Once per account and region, ever. Creates the
`CDKToolkit` stack (S3 assets bucket, ECR repo, deploy roles).

```bash
npx aws-cdk@2 bootstrap aws://<YOUR_ACCOUNT_ID>/us-east-1 --termination-protection
```

Verify:

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query "Stacks[0].StackStatus" --output text          # CREATE_COMPLETE
aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version \
  --query Parameter.Value --output text                  # 32 or higher
```

**4. Clone and deploy.**

```bash
git clone https://github.com/rohangoud17/BackRow.git
cd BackRow
npm install
npm run deploy:dev
```

On Windows PowerShell, set the region explicitly first with
`$env:AWS_REGION = "us-east-1"`; on macOS/Linux use `export AWS_REGION=us-east-1`.

Then run the smoke test below. If all of this worked without asking anyone a
question, the onboarding docs are doing their job — if it didn't, fix this
section rather than telling the next person what to do.

### Working in a shared account

If two developers ever do share one account, don't both deploy `dev` — you'll
fight over the same CloudFormation stack. Every resource name derives from the
`env` context value, so take a private stack instead:

```bash
cd infra
npx cdk deploy --context env=<yourname> --require-approval never
```

That yields `Backrow-<yourname>` with its own table, config parameter, and
endpoints. Reserve `dev` as the shared stack that CI deploys on merge to `main`.

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
