#!/usr/bin/env node
/**
 * Backrow load test — the measurement Phase 2 exists to produce.
 *
 * The whole architecture rests on one bet: that a Lambda looping over the
 * connection table can fan out to a lecture hall, so we never pay for an
 * always-on Redis (ADR 0001). This script is what settles that. It drives real
 * WebSocket clients against a deployed stage, has them vote and react like a
 * room of students, and reports what the room actually experienced.
 *
 * Usage:
 *   node scripts/loadtest.mjs --ws wss://xxx.execute-api.us-east-1.amazonaws.com/dev \
 *                             --http https://yyy.execute-api.us-east-1.amazonaws.com \
 *                             --clients 300 --duration 60
 *
 * Or through npm, which needs the long flag names:
 *   npm run loadtest -- --wsUrl wss://... --httpUrl https://... --clients 300
 *
 * `--ws` is npm's own shorthand for `--workspaces`, so `npm run loadtest --
 * --ws ...` never reaches this script: npm consumes the flag and runs the
 * script in every workspace instead. `--wsUrl`/`--httpUrl` are the aliases that
 * survive npm; `--ws`/`--http` work when invoking node directly.
 *
 * Four things about the methodology are deliberate.
 *
 * **Every simulated student gets its own clientId.** Voter identity is a
 * persisted browser id, so N clients sharing one id would produce 1 vote and
 * N-1 ALREADY_VOTED errors — a load test that measured nothing and looked like a
 * bug. The ids are generated directly here, never via storage.
 *
 * **Joins are ramped and jittered.** API Gateway allows 500 new connections per
 * second per account per region by default. A synchronised stampede would hit
 * that quota and report a platform limit as an application failure.
 *
 * **Latency is measured as a round trip.** One-way numbers need the server's
 * clock, and mixing clocks is how we once turned a 40ms delivery into a
 * 1,280ms one. Ping RTT is measured entirely on this machine's clock, so no
 * offset can contaminate it. Fan-out is measured by *arrival rate* and loss
 * instead — how many of the frames a client should have received it actually
 * received.
 *
 * **Nothing is silently dropped from the report.** Every error code is counted
 * and printed, including the ones we expect (a second vote, a throttled
 * reaction), because "no errors" and "errors we chose not to look at" have to
 * be distinguishable.
 */
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    clients: 200,
    duration: 60,
    ramp: 20,
    reactEvery: 4000,
    poll: true,
  };
  // Long names first: npm strips `--ws` (its own shorthand for --workspaces)
  // before the script ever sees it, so the aliases are what work under npm.
  const aliases = { wsUrl: "ws", httpUrl: "http" };

  for (let i = 0; i < argv.length; i += 2) {
    const raw = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!raw) continue;

    if (raw === "skipPoll") {
      out.poll = false;
      i -= 1;
      continue;
    }

    if (value === undefined) continue;
    const key = aliases[raw] ?? raw;
    if (["clients", "duration", "ramp", "reactEvery"].includes(key)) {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.ws || !args.http) {
  console.error(
    [
      "usage: node scripts/loadtest.mjs --ws <wss url> --http <https url> [options]",
      "",
      "  --ws URL          WebSocket stage URL      (alias --wsUrl)",
      "  --http URL        HTTP API base URL        (alias --httpUrl)",
      "  --clients N       simulated audience members (default 200)",
      "  --duration SEC    how long to hold the load (default 60)",
      "  --ramp SEC        spread joins over this window (default 20)",
      "  --reactEvery MS   per-client reaction interval (default 4000)",
      "  --skipPoll        reactions only, no poll",
      "",
      "Through npm, use the long names — npm treats --ws as --workspaces and",
      "would run this in every workspace instead of passing the flag through:",
      "  npm run loadtest -- --wsUrl wss://... --httpUrl https://...",
      "",
      "Costs real money against a real account. Check your budget alarm first.",
    ].join("\n")
  );
  process.exit(1);
}

const httpBase = String(args.http).replace(/\/$/, "");

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/**
 * Percentile of a sample, nearest-rank.
 *
 * p50 and p99 of the same run answer different questions: the median says what
 * a typical student saw, the tail says whether anyone had a bad time. A mean
 * would hide both.
 */
function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

const summarize = (values) => ({
  n: values.length,
  p50: percentile(values, 50),
  p90: percentile(values, 90),
  p99: percentile(values, 99),
  max: values.length ? Math.max(...values) : undefined,
});

const fmt = (s) =>
  s.n === 0
    ? "no samples"
    : `n=${s.n}  p50=${s.p50}ms  p90=${s.p90}ms  p99=${s.p99}ms  max=${s.max}ms`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// shared counters
// ---------------------------------------------------------------------------

/**
 * requestId -> send time, shared across clients.
 *
 * Safe to share because every id embeds the sending timestamp and each client
 * pings on its own schedule, so collisions would need two pings in the same
 * millisecond from two clients — and if that happened the sample would still be
 * accurate to within that millisecond.
 */
const pendingPings = new Map();

const stats = {
  connectMs: [],
  joinMs: [],
  pingMs: [],
  reactionFrames: 0,
  resultFrames: 0,
  /**
   * Counted separately from votesAccepted on purpose.
   *
   * "10 votes accepted out of 50 clients" has two completely different causes: 40
   * votes were sent and lost, or 40 clients were never told voting had opened.
   * The first is a server bug, the second is a fan-out or membership problem, and
   * the fix has nothing in common. Without both counters the report can't tell
   * them apart — which is a defect in the measurement, not in the system.
   */
  pollOpenFrames: 0,
  votesSent: 0,
  votesAccepted: 0,
  errorsByCode: new Map(),
  connectFailures: 0,
  unexpectedCloses: 0,
  peakConnected: 0,
};

let connected = 0;

const countError = (code) =>
  stats.errorsByCode.set(code, (stats.errorsByCode.get(code) ?? 0) + 1);

// ---------------------------------------------------------------------------
// one simulated student
// ---------------------------------------------------------------------------

/**
 * A single audience member: connect, join, vote once, react on an interval.
 *
 * Failures are recorded rather than thrown. One client dying is data about the
 * system under test, not a reason to abandon the run.
 */
function spawnClient({ sessionCode, optionCount, index, stopAt }) {
  return new Promise((resolve) => {
    // Distinct per client. Sharing this is the mistake that makes a load test
    // measure one vote and 299 rejections.
    const clientId = `load-${randomUUID()}`;
    const openedAt = Date.now();
    let joinSentAt = 0;
    let timers = [];
    let done = false;
    // A client votes once. The poll frame arrives on launch and again in the
    // join snapshot after a reconnect, and voting twice would manufacture
    // ALREADY_VOTED errors that look like a server problem.
    let hasVoted = false;

    const socket = new WebSocket(args.ws);

    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearInterval(t);
      timers = [];
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      resolve();
    };

    const send = (message) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };

    socket.addEventListener("open", () => {
      stats.connectMs.push(Date.now() - openedAt);
      connected += 1;
      stats.peakConnected = Math.max(stats.peakConnected, connected);

      joinSentAt = Date.now();
      send({ type: "join", sessionCode, clientId, displayName: `s${index}` });
    });

    socket.addEventListener("message", (event) => {
      let m;
      try {
        m = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (m.type) {
        case "joined": {
          stats.joinMs.push(Date.now() - joinSentAt);

          // Reactions on an interval, each client offset by a random phase so
          // they don't all fire on the same tick and produce a sawtooth that
          // looks like server jitter.
          timers.push(
            setInterval(() => {
              send({
                type: "react",
                reaction: Math.floor(Math.random() * 6),
              });
            }, args.reactEvery)
          );

          // One ping per client per 15s: enough RTT samples under load to
          // characterise the tail, far below the heartbeat's own budget.
          timers.push(
            setInterval(() => {
              const id = `p-${Date.now()}`;
              pendingPings.set(id, Date.now());
              send({ type: "ping", requestId: id });
            }, 15_000)
          );
          break;
        }

        case "poll": {
          // Vote as soon as voting opens. Real students take a few seconds, but
          // the point of this test is the burst, so we produce the worst case.
          if (m.state === "open" && optionCount > 0 && !hasVoted) {
            hasVoted = true;
            stats.pollOpenFrames += 1;
            stats.votesSent += 1;
            send({
              type: "vote",
              pollId: m.pollId,
              optionIndex: Math.floor(Math.random() * optionCount),
            });
          } else if (m.state === "open") {
            stats.pollOpenFrames += 1;
          }
          break;
        }

        case "voteAccepted":
          stats.votesAccepted += 1;
          break;

        case "reactions":
          stats.reactionFrames += 1;
          break;

        case "pollResults":
          stats.resultFrames += 1;
          break;

        case "pong": {
          const sentAt = pendingPings.get(m.requestId);
          if (sentAt !== undefined) {
            pendingPings.delete(m.requestId);
            // A true round trip on one clock — the only latency number here
            // that no clock offset can distort.
            stats.pingMs.push(Date.now() - sentAt);
          }
          break;
        }

        case "error":
          countError(m.code);
          break;

        default:
          break;
      }
    });

    socket.addEventListener("error", () => {
      stats.connectFailures += 1;
      finish();
    });

    socket.addEventListener("close", () => {
      connected = Math.max(0, connected - 1);
      if (Date.now() < stopAt - 1000) stats.unexpectedCloses += 1;
      finish();
    });

    setTimeout(finish, Math.max(stopAt - Date.now(), 0));
  });
}

// ---------------------------------------------------------------------------
// the presenter
// ---------------------------------------------------------------------------

/** Connect as presenter and return a handle for driving the poll. */
async function connectPresenter(sessionCode, presenterToken) {
  const socket = new WebSocket(args.ws);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let pollId;
  socket.addEventListener("message", (event) => {
    try {
      const m = JSON.parse(String(event.data));
      if (m.type === "poll" && !pollId) pollId = m.pollId;
      if (m.type === "error") countError(`presenter:${m.code}`);
    } catch {
      /* ignore */
    }
  });

  const send = (m) => socket.send(JSON.stringify(m));
  send({
    type: "presenterJoin",
    sessionCode,
    presenterToken,
    clientId: `presenter-${randomUUID()}`,
  });

  return {
    async openPoll(question, options) {
      send({ type: "createPoll", question, options });
      // Wait for the server-assigned id rather than guessing at a delay.
      for (let i = 0; i < 50 && !pollId; i++) await sleep(100);
      if (!pollId) throw new Error("presenter never received a poll id");
      send({ type: "launchPoll", pollId });
      return pollId;
    },
    closePoll() {
      if (pollId) send({ type: "closePoll", pollId });
    },
    close() {
      socket.close();
    },
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function main() {
  const created = await fetch(`${httpBase}/sessions`, { method: "POST" });
  if (!created.ok) {
    throw new Error(`POST /sessions failed: ${created.status}`);
  }
  const { sessionCode, presenterToken } = await created.json();
  console.log(`session ${sessionCode}, ${args.clients} clients, ${args.duration}s`);

  const presenter = await connectPresenter(sessionCode, presenterToken);
  const options = ["Redis", "Lambda fan-out", "Neither", "Ask again later"];

  const startedAt = Date.now();
  const stopAt = startedAt + (args.duration + args.ramp) * 1000;

  // Ramp with jitter. The spacing is the point: a synchronised stampede would
  // hit API Gateway's 500-new-connections/sec quota and report a platform limit
  // as an application failure.
  const spacing = (args.ramp * 1000) / Math.max(args.clients, 1);
  const clients = [];
  for (let i = 0; i < args.clients; i++) {
    clients.push(
      sleep(i * spacing + Math.random() * spacing).then(() =>
        spawnClient({
          sessionCode,
          optionCount: args.poll ? options.length : 0,
          index: i,
          stopAt,
        })
      )
    );
  }

  // Open the poll once the room is full, so the vote burst is a burst.
  if (args.poll) {
    await sleep(args.ramp * 1000 + 1000);
    console.log("room assembled, opening the poll");
    await presenter.openPoll("Was the fan-out bet right?", options);

    // Close it while the room is still connected. Closing after the clients
    // have gone would mean the final-tally fan-out — the one broadcast that
    // must never be dropped — arrives with nobody left to measure it.
    setTimeout(() => {
      console.log("closing the poll");
      presenter.closePoll();
    }, Math.max(stopAt - Date.now() - 4000, 0));
  }

  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `  ${elapsed}s  connected=${connected}  reactionFrames=${stats.reactionFrames}` +
        `  resultFrames=${stats.resultFrames}  errors=${[...stats.errorsByCode.values()].reduce((a, b) => a + b, 0)}`
    );
  }, 5000);

  await Promise.all(clients);
  clearInterval(ticker);
  presenter.close();

  report(Date.now() - startedAt);
}

function report(elapsedMs) {
  const seconds = elapsedMs / 1000;
  const line = (label, value) => console.log(`  ${label.padEnd(22)}${value}`);

  console.log("\n" + "=".repeat(64));
  console.log(`Backrow load test — ${args.clients} clients, ${Math.round(seconds)}s`);
  console.log("=".repeat(64));

  console.log("\nlatency (round trips, one clock — trustworthy)");
  line("connect", fmt(summarize(stats.connectMs)));
  line("join -> joined", fmt(summarize(stats.joinMs)));
  line("ping RTT", fmt(summarize(stats.pingMs)));

  console.log("\nfan-out");
  line("reaction frames", `${stats.reactionFrames} (${(stats.reactionFrames / seconds).toFixed(1)}/s)`);
  line("poll result frames", `${stats.resultFrames} (${(stats.resultFrames / seconds).toFixed(1)}/s)`);
  line("peak connected", stats.peakConnected);

  console.log("\nvoting (three numbers, because they fail differently)");
  line("told voting opened", `${stats.pollOpenFrames} of ${args.clients} clients`);
  line("votes sent", stats.votesSent);
  line("votes accepted", stats.votesAccepted);
  if (args.poll) {
    if (stats.pollOpenFrames < args.clients) {
      line(
        "^ diagnosis",
        `${args.clients - stats.pollOpenFrames} clients never received the poll —` +
          " a fan-out or membership problem, not a vote problem"
      );
    } else if (stats.votesAccepted < stats.votesSent) {
      line(
        "^ diagnosis",
        `${stats.votesSent - stats.votesAccepted} votes sent but never` +
          " acknowledged — check Lambda Throttles and Errors in CloudWatch"
      );
    }
  }

  console.log("\nerrors");
  if (stats.errorsByCode.size === 0) {
    line("none", "");
  } else {
    for (const [code, count] of [...stats.errorsByCode].sort((a, b) => b[1] - a[1])) {
      line(code, count);
    }
  }
  line("connect failures", stats.connectFailures);
  line("unexpected closes", stats.unexpectedCloses);

  console.log("\nhow to read this");
  console.log(
    [
      "  Reaction frames per second should be roughly clients/second, not",
      "  clients x taps/second — coalescing is working if the fan-out rate",
      "  tracks the 1s window rather than the tap rate.",
      "",
      "  Votes accepted below the client count means votes were lost, which is",
      "  the one number here that would send us back to the design.",
      "",
      "  RATE_LIMITED is expected if reactEvery is below the 500ms cooldown;",
      "  ALREADY_VOTED is expected only if clients reconnected mid-poll.",
      "",
      "  Latency here includes the round trip from wherever you ran this. For",
      "  server-side numbers use CloudWatch, not this script.",
    ].join("\n")
  );
}

main().catch((err) => {
  console.error("load test failed:", err.message);
  process.exit(1);
});
