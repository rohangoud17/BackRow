# Backrow

Serverless real-time audience engagement platform on AWS — live polls, Q&A,
reactions, and a RAG course-assistant. API Gateway WebSockets + Lambda +
DynamoDB, with cost-first infrastructure (see `docs/adr/0001`).

This repo is currently at **Phase 1 — Realtime core**: sessions, join-by-code,
and live message fan-out over WebSockets, with a browser client that survives
disconnects. See `docs/roadmap.md` for the plan and `docs/architecture.md` for
the message contract and table design.

## Repo layout

```
backrow/
  infra/            # CDK app: WebSocket + HTTP API, Lambda, DynamoDB, SSM
  packages/
    shared/         # message schemas, table keys, session codes (the A<->B contract)
    client/         # browser WebSocket layer: heartbeat, reconnect, resync
    realtime/       # Lambda handlers: connect, disconnect, message, sessions
    features/       # poll, qa, reactions handlers (Phase 2)
    rag/            # ingestion + retrieval + generation (Phase 3)
  apps/
    harness/        # dev harness for the two-tab demo (npm run harness)
    audience/       # React + Vite audience app (Phase 2)
    presenter/      # React + Vite presenter console (Phase 2)
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
npx cdk deploy Backrow-<yourname> --context env=<yourname> --require-approval never
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

Health and config:

```bash
curl "<HttpUrl>/health"
# -> {"status":"ok","service":"backrow","environment":"dev","phase":1,"configOk":true}
```

**The Phase 1 milestone — two clients, one session.** Create a session, then
open two terminals and watch a message cross between them.

```bash
# 1. Create a session. Save the sessionCode; the presenterToken is shown once.
curl -X POST "<HttpUrl>/sessions"
# -> {"sessionCode":"KQ7MTX","state":"lobby","presenterToken":"…"}
```

```bash
# 2. Terminal A — audience member
npx wscat -c "<WebSocketUrl>"
> {"type":"join","sessionCode":"KQ7MTX","displayName":"A"}
< {"type":"joined","sessionCode":"KQ7MTX","state":"lobby","role":"audience","memberCount":1}
```

```bash
# 3. Terminal B — second audience member
npx wscat -c "<WebSocketUrl>"
> {"type":"join","sessionCode":"KQ7MTX","displayName":"B"}
< {"type":"joined",…,"memberCount":2}
```

Terminal A also receives `{"type":"presence","memberCount":2}` when B joins.
Now broadcast from B:

```bash
> {"type":"broadcast","text":"hello room"}
```

Terminal A receives:

```json
{"type":"message","sessionCode":"KQ7MTX","from":"…","fromRole":"audience","displayName":"B","text":"hello room","sentAt":1753…}
```

Senders never receive their own echo. Closing terminal B sends A a `presence`
update with the lower count.

Other things worth trying:

```bash
> {"type":"ping"}                                    # -> pong (the heartbeat)
> {"type":"broadcast","text":"x"}                    # before join -> NOT_JOINED
> {"type":"join","sessionCode":"XXXXXX"}             # -> SESSION_NOT_FOUND
> not json                                           # -> BAD_REQUEST, socket stays open
> {"type":"presenterJoin","sessionCode":"KQ7MTX","presenterToken":"<token>"}
```

See `docs/architecture.md` for the full message contract and table design.

### Browser harness (the two-tab demo)

`wscat` proves the protocol; the harness proves the *client layer* — heartbeat,
automatic reconnect, resync, and latency measurement.

```bash
npm run harness      # bundles @backrow/client, serves on http://localhost:5173
```

Open that URL in **two tabs**. In each: paste the `HttpUrl` and `WebSocketUrl`
from your deploy outputs, click **Create session** in the first tab, copy the
code into the second, then **Connect & join** in both. Type in one tab's
broadcast box and it appears in the other.

Four things worth watching:

- **Heartbeat RTT** — a true round trip on one clock. Always trustworthy.
- **Delivery (corrected)** — one-way. `sentAt` comes from the *server's* clock,
  so the raw subtraction includes your machine's clock offset from AWS, which
  is often over a second. The harness corrects it using an NTP-style estimate
  from the ping/pong and shows the raw value alongside so you can see the gap.
- **Reconnect** — turn wifi off for a few seconds. The state chip goes
  `reconnecting`, then `open`, and the client silently re-sends the join. No
  action needed from the page; membership is restored automatically.
- **Presence** — closing one tab drops the other's member count.

The harness bundle (`apps/harness/client.js`) is generated and gitignored.

### Client library

`packages/client` is the framework-agnostic WebSocket layer that the audience
and presenter React apps will both import, so reconnect logic lives in exactly
one place:

```ts
import { BackrowClient, createSession } from "@backrow/client";

const client = new BackrowClient({ url: WS_URL });
client.on("message", (m) => { /* typed ServerMessage */ });
client.on("latency", (ms) => { /* heartbeat RTT */ });
client.connect();
client.join("XT7A4G", "Rohan");   // replayed automatically on every reconnect
```

It handles all three API Gateway limits: heartbeat every 4.5 min (idle drop is
10), proactive socket rotation at 1h50m (hard cap is 2h), and join replay on
reconnect, since a new socket has no server-side session membership. Reconnect
backoff is jittered so a whole lecture hall recovering from a blip doesn't
retry in lockstep and hit the 500-connections-per-second account quota.

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
- On merge to `main`: deploy the dev stack, using a GitHub OIDC role — no AWS
  credentials are stored in GitHub.

### One-time CI setup

`infra/lib/ci-stack.ts` defines the deploy identity. Deploy it once from your
own credentials — it is the trust anchor that lets CI deploy, so it can't be
deployed by CI:

```bash
npm run deploy:ci-role -- --context githubOwner=<owner> --context githubRepo=<repo>
```

Copy the `DeployRoleArn` output into GitHub under **Settings → Secrets and
variables → Actions → New repository secret**, named `AWS_DEPLOY_ROLE_ARN`.
Region defaults to `us-east-1`; override it with an `AWS_REGION` repository
variable if you deploy elsewhere.

If the account already has a GitHub OIDC provider (only one per issuer is
allowed per account), import it instead of creating a second:

```bash
aws iam list-open-id-connect-providers   # find the arn
npm run deploy:ci-role -- --context oidcProviderArn=<arn> \
  --context githubOwner=<owner> --context githubRepo=<repo>
```

**How the trust works.** GitHub mints a short-lived OIDC token for the workflow
run; AWS verifies it against GitHub's public keys and issues temporary
credentials. Nothing long-lived is ever stored, and revoking CI access means
deleting one role. The trust policy is scoped to this repository's `dev`
environment and `main` branch specifically — a fork opening a pull request
cannot assume it.

The role itself holds no administrative permissions. Its only privilege is
assuming the CDK bootstrap roles, which already carry the deployment rights, so
widening what CI can do requires changing bootstrap rather than quietly editing
a policy.

## Contributing

Trunk-based flow, PRs required, `main` auto-deploys to dev. See
`docs/branching.md`. Anything touching `packages/shared` is the shared
contract — both engineers review.
