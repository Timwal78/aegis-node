/**
 * AEGIS-NODE — Isolated Monitor Thread
 * ════════════════════════════════════
 * Runs on a separate worker thread from the agent's main process so that
 * a hung, blocked, or runaway main thread cannot prevent a trip.
 *
 * Receives metric reports via parentPort messages:
 *   { type: "tokens",  amount: number }
 *   { type: "api_call", name: string }
 *   { type: "action",  signature: string }
 *   { type: "ping" }
 *
 * Emits back to parent:
 *   { type: "trip", reason: string, detail: object }
 *   { type: "status", ...rolling stats }
 */
"use strict";

const { parentPort, workerData } = require("worker_threads");

const limits = Object.assign(
  {
    maxTokensPerMinute: Infinity,
    maxApiCallsPerMinute: Infinity,
    maxRepeatedActions: Infinity,
    repeatedActionWindowMs: 60_000,
    statusIntervalMs: 5_000,
  },
  workerData && workerData.limits ? workerData.limits : {}
);

// Rolling 60s windows (ring buffer of timestamps/amounts)
const tokenEvents = [];   // { t, amount }
const apiCallEvents = []; // { t }
const actionLog = [];     // { t, signature }

function pruneOld(arr, now, windowMs) {
  while (arr.length && now - arr[0].t > windowMs) arr.shift();
}

function sumAmounts(arr) {
  let total = 0;
  for (const e of arr) total += e.amount;
  return total;
}

function trip(reason, detail) {
  parentPort.postMessage({ type: "trip", reason, detail, at: Date.now() });
}

function checkLimits() {
  const now = Date.now();

  pruneOld(tokenEvents, now, 60_000);
  pruneOld(apiCallEvents, now, 60_000);
  pruneOld(actionLog, now, limits.repeatedActionWindowMs);

  const tokensPerMin = sumAmounts(tokenEvents);
  if (tokensPerMin > limits.maxTokensPerMinute) {
    trip("TOKEN_BURN_RATE_EXCEEDED", {
      tokensPerMinute: tokensPerMin,
      limit: limits.maxTokensPerMinute,
    });
    return true;
  }

  const callsPerMin = apiCallEvents.length;
  if (callsPerMin > limits.maxApiCallsPerMinute) {
    trip("API_CALL_RATE_EXCEEDED", {
      callsPerMinute: callsPerMin,
      limit: limits.maxApiCallsPerMinute,
    });
    return true;
  }

  // Loop detection: count occurrences of each signature within the window
  if (Number.isFinite(limits.maxRepeatedActions)) {
    const counts = new Map();
    for (const e of actionLog) {
      counts.set(e.signature, (counts.get(e.signature) || 0) + 1);
    }
    for (const [signature, count] of counts) {
      if (count > limits.maxRepeatedActions) {
        trip("REPETITIVE_LOOP_DETECTED", {
          signature,
          count,
          limit: limits.maxRepeatedActions,
          windowMs: limits.repeatedActionWindowMs,
        });
        return true;
      }
    }
  }

  return false;
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  const now = Date.now();

  switch (msg.type) {
    case "tokens":
      tokenEvents.push({ t: now, amount: Number(msg.amount) || 0 });
      break;
    case "api_call":
      apiCallEvents.push({ t: now, name: msg.name || "unknown" });
      break;
    case "action":
      actionLog.push({ t: now, signature: String(msg.signature) });
      break;
    case "ping":
      // no-op, used to verify the monitor thread is alive
      break;
    default:
      return;
  }

  checkLimits();
});

// Periodic check + status heartbeat — catches rate decay even with no new events,
// and lets the parent verify this thread hasn't silently died.
setInterval(() => {
  const tripped = checkLimits();
  if (!tripped) {
    parentPort.postMessage({
      type: "status",
      at: Date.now(),
      tokensPerMinute: sumAmounts(tokenEvents),
      apiCallsPerMinute: apiCallEvents.length,
      trackedActions: actionLog.length,
    });
  }
}, limits.statusIntervalMs);
