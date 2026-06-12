# Aegis-Node

**The autonomous agent blast shield. Hardware-agnostic, zero-dependency kill switch for AI agents.**

![architecture](./docs/architecture.png)
<!-- diagram: Agent process <-> Aegis (main thread, spawns + kills)
                          \-> Watcher thread (worker_threads, isolated)
     Watcher trips on: token burn rate / API call rate / repeated-action loop
     -> instant SIGKILL of agent process tree + best-effort network sever -->

[![npm](https://img.shields.io/npm/v/%40timothywalton%2Faegis-node)](https://www.npmjs.com/package/@timothywalton/aegis-node)
[![License](https://img.shields.io/badge/license-MIT-green)]()

---

## Why this exists

Everyone is shipping agents that read files, execute code, call APIs, and spend money. Almost nobody is shipping the thing that stops them when they hallucinate into a billing-draining loop, a runaway tool-call storm, or an infinite retry spiral.

Aegis-Node is that thing. It runs your agent as a child process, watches it from a **separate, isolated thread**, and the moment it crosses a hard limit — token burn rate, API call rate, or repeated-action loop — it **instantly kills the process tree and severs its network access**. No graceful shutdown negotiation. No "let me finish this one thing." Dead.

- **Zero dependencies** — pure Node builtins (`worker_threads`, `child_process`)
- **Isolated watcher thread** — a hung or blocked agent main thread can't prevent a trip
- **Three trip conditions out of the box**: token burn rate, API call rate, repeated-action loop detection
- **Instant kill** — SIGKILL of the full process group, plus best-effort `iptables` network sever on Linux
- **Drop-in CLI** — wrap any agent command, no code changes required to get baseline protection

## Install & run (under 60 seconds)

```bash
npx -p @timothywalton/aegis-node aegis --max-tokens-per-min 200000 --max-api-calls-per-min 120 -- python my_agent.py
```

That's it. Your agent runs exactly as before, but if it blows past 200k tokens/min or 120 API calls/min, Aegis kills it immediately.

For loop detection and token tracking, your agent reports metrics via the programmatic API:

```javascript
const { AegisNode } = require("@timothywalton/aegis-node");

const aegis = new AegisNode({
  command: "python",
  args: ["my_agent.py"],
  limits: {
    maxTokensPerMinute: 200_000,
    maxApiCallsPerMinute: 120,
    maxRepeatedActions: 5,        // same action signature 6+ times in window = loop
    repeatedActionWindowMs: 60_000,
  },
  onTrip: (reason, detail) => {
    console.error("AEGIS TRIPPED:", reason, detail);
    // alert Discord, page on-call, whatever you need
  },
});

aegis.start();

// from your agent's instrumentation / IPC bridge:
aegis.reportTokens(1500);
aegis.reportApiCall("openai.chat.completions");
aegis.reportAction("tool:bash:rm -rf /tmp/x");
```

## How it works

```
┌─────────────────────────────────────────────┐
│ Main thread (your process)                   │
│  ┌─────────────┐        ┌──────────────────┐│
│  │ AegisNode    │ spawn  │  Agent process    ││
│  │ (controller) ├───────►│  (your AI agent)  ││
│  └──────┬───────┘        └──────────────────┘│
│         │ postMessage           ▲             │
│         ▼                       │ SIGKILL     │
│  ┌──────────────────────┐       │             │
│  │ Watcher (worker_thread)│──────┘             │
│  │ - rolling 60s windows │  + iptables DROP    │
│  │ - trip detection      │    (Linux, best-eff)│
│  └───────────────────────┘                     │
└─────────────────────────────────────────────┘
```

The watcher runs on its own thread so it keeps evaluating limits even if your main process is busy or blocked. On trip: SIGKILL the entire process group (not just the immediate PID — covers forked subprocesses too), then terminate the watcher.

## Trip conditions

| Condition | Trigger | Detail payload |
|---|---|---|
| `TOKEN_BURN_RATE_EXCEEDED` | Sum of `reportTokens()` in trailing 60s > `maxTokensPerMinute` | `{ tokensPerMinute, limit }` |
| `API_CALL_RATE_EXCEEDED` | Count of `reportApiCall()` in trailing 60s > `maxApiCallsPerMinute` | `{ callsPerMinute, limit }` |
| `REPETITIVE_LOOP_DETECTED` | Any action signature repeats > `maxRepeatedActions` times within `repeatedActionWindowMs` | `{ signature, count, limit, windowMs }` |
| `MONITOR_THREAD_ERROR` | Watcher thread itself crashed | `{ message }` |

## Network namespace isolation (optional, Linux)

For defense-in-depth beyond process kill, pass `networkNamespace: true` (requires `unshare` + `CAP_NET_ADMIN`). The agent runs in its own network namespace from the start — on trip, killing the process tears down the namespace and every socket in it, with no `iptables` race window.

## Roadmap

- [ ] Unix-socket reporting protocol so non-Node agents (Python, Go, Rust) can report metrics without an SDK
- [ ] Pluggable trip handlers (Discord webhook, PagerDuty)
- [ ] Per-tool rate limits (not just global API call rate)
- [ ] Windows job-object based hard isolation (currently falls back to `taskkill`)

## Pairs with agent-top

[`agent-top`](https://github.com/Timwal78/agent-top) is the live dashboard — "`htop` for AI agents" — showing token burn rate, $ cost, API call rate, and loop warnings in your terminal. Aegis-Node is the enforcement layer; agent-top is how you *watch* it work.

```bash
npm install @timothywalton/aegis-node @timothywalton/agent-top
```

## More from ScriptMasterLabs

Building agent-native financial infrastructure: x402 payment rails (`proof402-middleware`), autonomous trading pipelines with the same circuit-breaker philosophy in production, Pine Script v6 indicator suites, and the NEXUS-402 agent marketplace.

→ [scriptmasterlabs.com/stack](https://scriptmasterlabs.com/stack) · [Full architecture map](https://github.com/Timwal78/SqueezeOS/blob/main/docs/architecture/INDEX.md)

## License

MIT
