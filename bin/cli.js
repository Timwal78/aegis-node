#!/usr/bin/env node
/**
 * AEGIS-NODE CLI
 * ──────────────
 * Usage:
 *   npx -p @timothywalton/aegis-node aegis [options] -- <command> [args...]
 *
 * Options (env-overridable):
 *   --max-tokens-per-min <n>       (AEGIS_MAX_TOKENS_PER_MIN)
 *   --max-api-calls-per-min <n>    (AEGIS_MAX_API_CALLS_PER_MIN)
 *   --max-repeated-actions <n>     (AEGIS_MAX_REPEATED_ACTIONS)
 *   --repeated-window-ms <n>       (AEGIS_REPEATED_WINDOW_MS)
 *   --network-namespace            (AEGIS_NETWORK_NAMESPACE=1)  [Linux only]
 *
 * Reporting from the agent process to this CLI's monitor is done via a
 * tiny line protocol on a unix socket / named pipe at $AEGIS_SOCK — see
 * docs/REPORTING.md. If your agent doesn't report metrics, Aegis still
 * enforces wall-clock loop detection is unavailable, but token/API limits
 * become no-ops (set to Infinity) until you wire in reporting.
 *
 * Example:
 *   npx -p @timothywalton/aegis-node aegis --max-tokens-per-min 200000 --max-api-calls-per-min 120 \
 *     -- python my_agent.py
 */
"use strict";

const { AegisNode } = require("../src/index.js");

function parseArgs(argv) {
  const out = { limits: {}, networkNamespace: false, cmd: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.cmd = argv.slice(i + 1);
      break;
    }
    switch (a) {
      case "--max-tokens-per-min":
        out.limits.maxTokensPerMinute = Number(argv[++i]);
        break;
      case "--max-api-calls-per-min":
        out.limits.maxApiCallsPerMinute = Number(argv[++i]);
        break;
      case "--max-repeated-actions":
        out.limits.maxRepeatedActions = Number(argv[++i]);
        break;
      case "--repeated-window-ms":
        out.limits.repeatedActionWindowMs = Number(argv[++i]);
        break;
      case "--network-namespace":
        out.networkNamespace = true;
        break;
      default:
        // ignore unknown flags before --
        break;
    }
  }
  return out;
}

function envLimits() {
  const l = {};
  if (process.env.AEGIS_MAX_TOKENS_PER_MIN)
    l.maxTokensPerMinute = Number(process.env.AEGIS_MAX_TOKENS_PER_MIN);
  if (process.env.AEGIS_MAX_API_CALLS_PER_MIN)
    l.maxApiCallsPerMinute = Number(process.env.AEGIS_MAX_API_CALLS_PER_MIN);
  if (process.env.AEGIS_MAX_REPEATED_ACTIONS)
    l.maxRepeatedActions = Number(process.env.AEGIS_MAX_REPEATED_ACTIONS);
  if (process.env.AEGIS_REPEATED_WINDOW_MS)
    l.repeatedActionWindowMs = Number(process.env.AEGIS_REPEATED_WINDOW_MS);
  return l;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.cmd.length) {
  console.error(
    "AEGIS-NODE: no command given.\n\nUsage: npx -p @timothywalton/aegis-node aegis [options] -- <command> [args...]"
  );
  process.exit(2);
}

const limits = Object.assign({}, envLimits(), parsed.limits);

console.log(
  `\x1b[36m[AEGIS-NODE]\x1b[0m armed — limits: ${JSON.stringify(limits)}`
);

const aegis = new AegisNode({
  command: parsed.cmd[0],
  args: parsed.cmd.slice(1),
  limits,
  networkNamespace:
    parsed.networkNamespace || process.env.AEGIS_NETWORK_NAMESPACE === "1",
  onTrip: (reason, detail) => {
    console.error(
      `\x1b[31m[AEGIS-NODE] TRIPPED: ${reason}\x1b[0m ${JSON.stringify(detail)}`
    );
    console.error(
      "\x1b[31m[AEGIS-NODE] agent process killed, network access severed.\x1b[0m"
    );
    process.exitCode = 137; // 128+SIGKILL, conventional for killed processes
  },
  onStatus: (s) => {
    if (process.env.AEGIS_VERBOSE === "1") {
      console.log(`\x1b[90m[AEGIS-NODE] status: ${JSON.stringify(s)}\x1b[0m`);
    }
  },
});

aegis.start();

process.on("SIGINT", () => {
  aegis.shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  aegis.shutdown();
  process.exit(143);
});
