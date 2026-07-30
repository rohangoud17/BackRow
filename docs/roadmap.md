# Backrow — Build Roadmap & Task Breakdown

*Real-time audience engagement platform on AWS, with a RAG course-assistant. Two-person team.*

> This is a snapshot of the working roadmap. The living source of truth is the
> Claude project doc "PulseHall — Real-Time Engagement Platform". Keep the two
> in sync when decisions land. Phase 0 decisions are recorded in
> `docs/adr/0001-phase0-decisions.md` (cheapest-first).

## Phases (summary)

- **Phase 0 — Foundations** *(current)*: reproducible skeleton both people can
  deploy; `cdk deploy` stands up an empty but wired stack; CI on every PR.
- **Phase 1 — Realtime core MVP**: connect, join a session, broadcast a
  message, see it live in another tab in under ~500 ms.
- **Phase 2 — Engagement features**: live polls, Q&A with upvoting,
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
- [x] CI: lint + typecheck + unit test + synth on PR; deploy-to-dev on merge.
- [x] Config/secrets strategy (SSM Parameter Store) decided and documented.
- [x] Local dev loop documented in the README.
- [ ] AWS Budgets alarm set in the dev account (do this before first deploy).

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
