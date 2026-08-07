# Backrow architecture — data flow, table design, message contract

*Phase 1. The authoritative version of the contract is the code in
`packages/shared`; this document explains the reasoning behind it. When they
disagree, the code wins and this file is stale — fix it.*

## Data flow

A session has one presenter and many audience members, all on the same
WebSocket API.

```
Presenter                          Audience
    |                                  |
    | POST /sessions                    |
    |--> { sessionCode, presenterToken }|
    |                                  |
    |                          reads code off the projector
    |                                  |
    |  wss:// connect                  |  wss:// connect
    |  -> $connect: CONN# row written  |  -> $connect: CONN# row written
    |                                  |
    |  presenterJoin + token           |  join + sessionCode
    |  -> membership edge written      |  -> membership edge written
    |  <- joined                       |  <- joined
    |                                  |
    |         broadcast  ------------->  $default
    |                                    |
    |                       Query membership edges for the session
    |                       PostToConnection to each (minus sender)
    |                       410 Gone -> delete that connection
    |                                    |
    |  <- message ------------------------  -> message
```

Two properties fall out of this that are worth stating explicitly. A client's
session membership lives in the **connection record**, never in the message
body — so a client cannot broadcast into a session it hasn't joined by simply
claiming a different code. And every broadcast is also a cleanup pass, because
`410 Gone` is the only reliable signal that a socket is dead.

## DynamoDB single-table design

One table, `backrow-<env>`, partition key `PK`, sort key `SK`, TTL on `ttl`.
Adjacency-list pattern with three item shapes:

| Item | PK | SK | Purpose |
|---|---|---|---|
| Session | `SESSION#<code>` | `SESSION#<code>` | The session record: state, presenter token, createdAt |
| Connection | `CONN#<connId>` | `CONN#<connId>` | Reverse lookup — which session is this socket in? |
| Membership | `SESSION#<code>` | `CONN#<connId>` | Fan-out list — one edge per participant |

**Why both a connection record and a membership edge.** Fan-out asks "every
connection in session X", which the membership edges answer as a single Query
on `PK = SESSION#<code>` with `begins_with(SK, "CONN#")`. Disconnect asks the
opposite — "which session was this socket in?" — which the connection record
answers with a GetItem. Two small writes on join buy one cheap read on every
broadcast, and neither question needs a GSI or a Scan.

**Why TTL matters.** `$disconnect` is best-effort: API Gateway does not
guarantee it fires, and a hard network drop may never deliver it. So there are
three layers of cleanup, and all three are load-bearing: `$disconnect` on the
happy path, the `410 Gone` prune during broadcast, and TTL as the backstop.
Connection rows expire after 3 hours (API Gateway caps a connection at 2), and
sessions after 24.

**Hot keys and how polls avoid them.** All membership edges for a session share
one partition, which is fine for reads at classroom scale. Vote counting is the
part that would break: every vote in a lecture lands within seconds, and
DynamoDB *serializes concurrent writes to a single item*, so a counter attribute
on the poll item is the worst possible place to put them.

Tallies are therefore sharded across `TALLY_SHARDS` (8) items, and the shard
index lives in the **partition** key (`POLL#<id>#S#<n>`), not the sort key.
Sharding the sort key would spread writes across items but leave them all in one
partition — fixing item-level contention while leaving the per-partition write
ceiling untouched. Reading results is one `BatchGetItem` over the shards,
strongly consistent so a voter always sees their own vote counted.

Honest scale note: at 500 students voting over 30 seconds (~17 writes/sec) a
single unsharded item would cope. Sharding earns its keep in the hundreds/sec.
It's here because the cost is a few lines and retrofitting a counter design
after real data exists is genuinely unpleasant.

Two more poll invariants worth keeping:

*One vote per voter* is enforced by a conditional put of a `VOTE#<voterId>` row
(`attribute_not_exists`), not by read-then-check — a check would lose the race
under exactly the burst a poll produces. Voter identity is the client-supplied
`clientId`, **not** connectionId, which changes on every reconnect; without that
a student who lost wifi mid-poll could vote twice by accident.

*Live results are debounced* by a conditional update on the poll item's
`lastBroadcastAt`. Whichever invocation wins the claim broadcasts and the rest
skip it — no timer, no queue. Otherwise 300 votes would mean 300 fan-outs to 300
clients. The final tally after `closePoll` bypasses this entirely, because the
rate limiter must never be able to swallow the number that matters.

## Q&A

Questions live in the session partition (`SESSION#<code>` / `QA#<id>`), upvote
dedup rows under `QA#<id>` / `UP#<voterId>`.

**Upvotes use a plain counter, not sharded — deliberately different from poll
votes.** Poll votes arrive as a synchronized burst the moment a poll opens,
which is exactly the shape that serializes writes onto one item. Upvotes trickle
in over minutes as people read the list, so even a very popular question is a
couple of writes per second. Sharding would cost a BatchGetItem on every read of
every question to buy headroom two orders of magnitude above the actual write
rate. The `ADD upvotes :one` returns the new value (`UPDATED_NEW`) so the
broadcast needs no follow-up read.

**Ordering happens on the client.** DynamoDB cannot sort by a mutable
attribute, and upvotes change constantly. The server sends the *changed*
question and clients re-sort with the shared `sortQuestions`, so an upvote costs
one small frame instead of the whole list. The comparator is fully
deterministic — rank by state (open, answered, hidden), then upvotes desc, then
age asc, then id — because two students comparing screens must never see
different rankings, and leaving that to sort stability would allow exactly that.

**Hidden questions are still broadcast.** Withholding the update would leave the
question on screen for everyone who already had it, which is the opposite of
hiding. Audience clients drop it on receipt; the join snapshot filters it out
for them. `restore` exists so hiding is recoverable.

**Ask spam is limited by a conditional-update cooldown**, not a TTL row:
DynamoDB TTL deletion is asynchronous and can lag by hours, so it cannot express
a ten-second window. `claimRateLimit` writes `lastAt` only if the previous value
is older than the window, which also makes it correct under concurrency — two
simultaneous asks cannot both win. The claim happens *before* the question is
written, so a client hammering the button never creates rows it then gets told
off for.

## Message contract

Defined in `packages/shared/src/messages.ts` as Zod schemas, with TypeScript
types inferred from them so a type and its validation cannot drift.

**Client → server.** Every inbound frame is untrusted and goes through
`parseClientMessage`, which never throws — a malformed frame produces an
`error` reply, not a 500.

| Type | Fields | Notes |
|---|---|---|
| `ping` | `requestId?` | Heartbeat. Send every ~5 min; idle sockets drop at 10. |
| `join` | `sessionCode`, `displayName?` | Audience joins. |
| `presenterJoin` | `sessionCode`, `presenterToken` | Token compared in constant time. |
| `broadcast` | `text` (≤2000 chars) | Phase 1 proof-of-life; Phase 2 replaces with poll/qa/reaction types. |

**Server → client.** Always pushed with `PostToConnection`, never returned from
the handler — see the note below.

| Type | Fields |
|---|---|
| `pong` | `serverTime`, `requestId?` |
| `joined` | `sessionCode`, `state`, `role`, `memberCount` |
| `message` | `sessionCode`, `from`, `fromRole`, `displayName?`, `text`, `sentAt` |
| `presence` | `sessionCode`, `memberCount` |
| `error` | `code`, `message`, `requestId?` |

Error codes are a closed set — `BAD_REQUEST`, `SESSION_NOT_FOUND`,
`SESSION_CLOSED`, `NOT_JOINED`, `FORBIDDEN`, `INTERNAL` — so clients branch on
a code rather than matching strings.

### Two API Gateway behaviours that shaped this

**Replies must be pushed, not returned.** A WebSocket API only returns a
handler's return value to the client when *both* a route response and an
integration response exist. CDK's `returnResponse: true` synthesizes only the
former, so the handler runs successfully and the client silently receives
nothing. Every reply therefore goes out via `PostToConnection`. The stack test
asserts zero `RouteResponse` resources so nobody "fixes" this back.

**One integration instance per WebSocket route.** A shared
`WebSocketLambdaIntegration` binds only once, so only the first route receives
a `lambda:InvokeFunction` permission; the others fail with a bare "Internal
server error" and produce *no CloudWatch entry at all*, because the function is
never invoked. `HttpLambdaIntegration` does not share this behaviour — it
creates a permission per route. The stack test asserts one permission per route.

## Session codes

Six characters from a 25-character alphabet that excludes every commonly
misread character (`O/0`, `I/1/L`, `S/5`, `B/8`, `Z/2`), because codes get typed
off a projector. Creation uses a conditional write on
`attribute_not_exists(PK)`, so a collision is impossible rather than merely
unlikely; the HTTP handler retries with a fresh code up to three times.

## Auth, for now

Creating a session returns a `presenterToken` — 256 bits of entropy, returned
exactly once and never readable afterwards. Holding it authorizes presenter
control. Audience members are fully anonymous, which is deliberate: join
friction has to be near zero.

This is not real auth and isn't meant to be. Cognito and a JWT authorizer land
in Phase 4, where the roadmap already has an authz hardening task.

## Measuring latency honestly

`RelayedMessage.sentAt` is stamped by the **server's** clock. Subtracting it
from `Date.now()` in a browser therefore measures one-way latency *plus* the
offset between that machine's clock and AWS's — and consumer clocks routinely
drift by more than a second. We hit exactly this: a real ~40ms delivery
displayed as ~1280ms on a laptop running 1.28s fast, while the heartbeat RTT
over the same socket read 35-78ms.

Two rules follow.

**Heartbeat RTT is the trustworthy number.** It is a true round trip measured
entirely on one clock, so no offset can contaminate it.

**Any server-stamped timestamp must be offset-corrected before it means
anything.** `BackrowClient` estimates the offset NTP-style from the ping/pong
(`pong.serverTime` against the round-trip midpoint), keeps a median of the last
nine samples so one jittery reply cannot skew it, and exposes
`deliveryLatencyMs(serverSentAt)`. That returns `undefined` until at least one
pong has calibrated it — a wrong number is worse than no number. The client
also pings immediately on open so calibration doesn't wait a full heartbeat.

Phase 4 dashboards should measure server-side latency from CloudWatch rather
than trusting any client-reported timing.

## Cold-start budget

The Phase 1 milestone is a sub-500ms message. Two things follow.

SSM is not read on the realtime path. The Phase 0 placeholder read the config
document on every cold start and it measured **~2.5 seconds** — that alone
blows the budget. Only `/health` reads SSM now; the WebSocket handlers take
config from environment variables.

The AWS SDK is bundled rather than externalized (`externalModules: []`), which
pins the version reproducibly instead of depending on whatever the Node 22
runtime happens to ship. Bundle size is around 600 KB per function, which is
irrelevant against Lambda's 250 MB limit.
