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
| Poll | `SESSION#<code>` | `POLL#<id>` | Question, options, state |
| Tally shard | `POLL#<id>#S#<n>` | `TALLY` | Sharded vote counters (`c0`…) |
| Question | `SESSION#<code>` | `QA#<id>` | Text, state, upvote count |
| Upvote | `QA#<id>` | `UP#<voterId>` | Dedup row — one per voter |
| Reaction shard | `REACT#<code>#S#<n>` | `REACTIONS` | Sharded emoji counters (`r0`…) |
| Reaction claim | `REACT#<code>#W#<window>` | `CLAIM` | One broadcast winner per window |
| Cooldown | `COOL#<code>#<clientId>` | `COOL#<action>` | Rate-limit timestamp |

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

## Reactions

Counter shards live at `REACT#<code>#S#<n>` / `REACTIONS`, and each coalescing
window claims `REACT#<code>#W#<window>` / `CLAIM`.

**Reactions are aggregated, never relayed.** This is the one Phase 2 feature with
unbounded volume — a student votes once per poll and upvotes once per question,
but nothing limits how often they can tap a heart. Relaying each tap the way
`broadcast` relays a message is quadratic: 300 students reacting twice a second
in a 300-person room is ~180,000 `PostToConnection` calls per second, for
information nobody can read at that rate. So every tap increments a sharded
counter, and one invocation per second wins a conditional write and broadcasts
the room's *cumulative totals*. Fan-out becomes a function of time and room size
instead of tap rate.

**Totals, not deltas.** A delta frame that gets dropped is lost information; a
totals frame that gets dropped is corrected by the next one. Clients derive what
to animate by diffing against the last totals they saw, capped at 12 so a
backgrounded tab doesn't return to 400 floating hearts. It also means a late
joiner needs no special message — the snapshot is the same frame sent to one
connection, and the client treats its first frame as a baseline and animates
nothing.

**The emoji set is closed and indexed.** A reaction travels as an index into
`REACTION_EMOJI`, not as a character. Every frame is the same few bytes whatever
the traffic, the server never puts client-supplied text on everyone else's
screen, and the DynamoDB attribute names are a fixed known set. Adding an emoji
is append-only; inserting or reordering would silently re-map every stored
counter, so a test pins the ends of the array.

**Two limits, doing different jobs.** A per-client cooldown (500ms) bounds how
much *writing* one person can cause. The per-window claim bounds how much
*fan-out* the whole room can cause. Only the second scales with audience size,
which is why it is the one that matters. A reaction rejected by the cooldown gets
no reply at all — sending one would spend exactly the push the window exists to
protect, and "your heart didn't register" is not information anyone needs.

**Two key-design details that a two-tab test cannot reveal.** Both would look
perfect in development and fail at lecture scale.

*Cooldown rows are partitioned by client, not by session.* The Q&A cooldown
originally keyed on `SESSION#<code>` with the client in the sort key. That is
harmless for asking questions — a ten-second cooldown and a handful of askers —
but a cooldown row is written on *every* rate-limited action, so at reaction
volume it funnels ~1,000 writes/sec into one partition, right at DynamoDB's
ceiling. The client id is now in the partition key, which spreads them by
construction.

*The broadcast claim is keyed by window number, not compared against a stored
timestamp.* The poll debounce updates `lastBroadcastAt` on the poll item, which
is fine at 17 votes/sec. Reactions arrive orders of magnitude faster, and every
one of them attempts the claim, so a single row would absorb the whole room's
failed conditional writes for the entire lecture. Numbering the key by window
means consecutive windows are different items in different partitions, and the
losers move to a fresh row every second.

**Upvotes remain unsharded, and that is still right.** Three counters in one
system with three different designs is defensible only because the traffic shapes
differ: poll votes are a synchronized burst, upvotes trickle over minutes,
reactions are sustained and unbounded. The design follows the shape, not a
preference for consistency.

## Load testing

`node scripts/loadtest.mjs --ws <wss> --http <https> --clients 300` drives real
WebSocket clients against a deployed stage. (Under npm the flags are `--wsUrl`
and `--httpUrl`: npm reads `--ws` as its own `--workspaces` shorthand and never
passes it through.) Four things about it are deliberate, and three of them are
lessons this project already paid for.

Every simulated student gets its own `clientId`, generated directly rather than
read from storage — sharing one produces 1 vote and N-1 `ALREADY_VOTED` errors,
a load test that measures nothing while looking like a bug. Joins are ramped and
jittered, because API Gateway allows 500 new connections per second per account
per region and a stampede would report a platform quota as an application
failure. Latency is reported as round trips measured entirely on the runner's
clock, since mixing clocks is how a 40ms delivery once displayed as 1,280ms.
And every error code is counted and printed, including the expected ones, so
"no errors" and "errors we didn't look at" stay distinguishable.

The number that would send us back to the design is votes accepted below the
client count. The number that confirms coalescing is the reaction fan-out rate:
it should track the one-second window times the room size, not the tap rate.

### First run, 50 clients — and the account quota nobody had looked at

The first real run reported **10 votes accepted out of 50**, which is the result
that was supposed to mean the design had failed. It didn't. The dev account had
`ConcurrentExecutions: 10` — the new-account Lambda default, not the 1,000 most
documentation assumes. A 50-vote burst wants ~50 concurrent invocations, 10 got
through, and the other 40 were throttled. **API Gateway discards a throttled
integration silently**, so those clients received nothing at all: no error frame,
no acknowledgement, nothing to distinguish it from the network eating the
message.

Three things are worth keeping from this.

*The fan-out was never the problem.* Result frames reached all 50 clients and
ping RTT stayed at p50 73ms / p99 339ms with 50 sockets attached. The ADR 0001
bet is intact; what failed was an account limit sitting two orders of magnitude
below where anyone assumed it was.

*Reactions hid the same throttling that votes exposed, and that is a property of
the protocol rather than luck.* Reactions are unacknowledged and their totals are
cumulative and self-correcting, so a throttled tap is invisible to every client —
which cuts both ways. The reaction path degraded gracefully; it also degraded
**undetectably**. The delivered frame rate came in around 40/sec against a
predicted 50/sec, so taps were being lost too. Nothing in the protocol could have
told us. A graceful-degradation design needs a server-side counter to stay
honest, which is a Phase 4 observability task.

*Every engagement action costs one Lambda invocation.* True even with a healthy
quota, and it means concurrency — not fan-out — is the ceiling that a real pilot
will meet first. 500 students voting inside two seconds is ~250 concurrent
invocations.

Check this before reading any load test result as a verdict on the code:

```bash
aws lambda get-account-settings --query "AccountLimit.ConcurrentExecutions"
```

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
| `broadcast` | `text` (≤2000 chars) | Phase 1 proof-of-life; Phase 2 adds typed poll/qa/reaction messages. |
| `react` | `reaction` (index into `REACTION_EMOJI`) | Never acknowledged, not even when throttled. |

**Server → client.** Always pushed with `PostToConnection`, never returned from
the handler — see the note below.

| Type | Fields |
|---|---|
| `pong` | `serverTime`, `requestId?` |
| `joined` | `sessionCode`, `state`, `role`, `memberCount` |
| `message` | `sessionCode`, `from`, `fromRole`, `displayName?`, `text`, `sentAt` |
| `presence` | `sessionCode`, `memberCount` |
| `reactions` | `sessionCode`, `totals` (cumulative, per emoji), `sentAt` |
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
