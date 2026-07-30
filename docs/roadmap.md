# Backrow — Build Roadmap & Task Breakdown

*Real-time audience engagement platform on AWS, with a RAG course-assistant. Two-person team.*

> This is a snapshot of the working roadmap. The living source of truth is the
> Claude project doc "PulseHall — Real-Time Engagement Platform". Keep the two
> in sync when decisions land. Phase 0 decisions are recorded in
> `docs/adr/0001-phase0-decisions.md` (cheapest-first).

## Phases (summary)

- **Phase 0 — Foundations** *(complete)*: reproducible skeleton both people can
  deploy; CI runs checks on every PR and deploys dev on merge to main via a
  GitHub OIDC role (no stored AWS credentials).
- **Phase 1 — Realtime core MVP** *(complete)*: connect, join a session,
  broadcast a message, see it live in another client — measured at 35 ms.
- **Phase 2 — Engagement features** *(current)*: live polls, Q&A with upvoting,
  reactions; load-tested at 200–500 clients.
- **Phase 3 — RAG course-assistant**: grounded, cited answers streamed over
  the WebSocket channel.
- **Phase 4 — Scale, observability, hardening**: dashboards, alarms, authz,
  DLQs, cost alarms.
- **Phase 5 — Launch & polish**: pilot with real users; runbook; feedback.

## Phase 0 exit criteria

- [x] Repo layout, branch strategy, PR template.
- [x] CDK app deploys WebSocket API + stub HTTP API + one Lambda + one
  DynamoDB table.
- [x] CI: lint + typecheck + unit test + synth on PR; deploy-to-dev on merge
  via GitHub OIDC (`infra/lib/ci-stack.ts`).
- [x] Config/secrets strategy (SSM Parameter Store) decided and documented.
- [x] Local dev loop documented in the README.
- [x] AWS Budgets alarm set in the dev account ($1/month tripwire).

## Phase 1 status

Server side complete. See `docs/architecture.md` for the contract and table
design, and the README for the two-client test procedure.

- [x] `$connect` / `$disconnect` / `$default` handlers, one Lambda each
- [x] connectionId <-> session mapping (adjacency-list single-table design)
- [x] Fan-out via `PostToConnection` (no Redis — see ADR 0001)
- [x] Stale-connection `410 Gone` -> prune, plus TTL as backstop
- [x] Presenter creates a session and gets a join code (`POST /sessions`)
- [x] Audience joins by code; presenter attaches with a token
- [x] Heartbeat `ping`/`pong` implemented server-side
- [x] `displayName` REMOVEd rather than stored as null (contract fidelity)
- [x] Browser client (`packages/client`): heartbeat, jittered-backoff reconnect,
  join replay on reconnect, proactive socket rotation before the 2-hour cap
- [x] Browser harness (`npm run harness`) for the two-tab demo, with heartbeat
  RTT and one-way delivery timing
- [x] 71 unit tests: contract, fan-out, prune, pagination, client reconnect/
  resync, stack assertions
- [x] Two-tab demo measured at **35 ms** against the deployment (budget: 500 ms)
- [x] CI deploy role via GitHub OIDC; no credentials stored in GitHub

## Hard constraints to design around (from the platform)

- API Gateway WebSocket connections cap at 2 hours; idle drops after 10 min →
  heartbeat + reconnect/resync is mandatory (Phase 1).
- 128 KB max WebSocket frame → stream/chunk assistant answers (Phase 3).
- `PostToConnection` returning `410 Gone` → delete that connectionId (Phase 1).
- DynamoDB single-partition hot keys → aggregate votes off the hot item
  (Phase 2).
- Default 500 new WS connections/sec per account/region → jittered client join
  + quota increase before a big pilot.

See the full narrative, task ownership split, risks, and cost posture in the
Claude project roadmap doc.
