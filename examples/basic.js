/**
 * Example: trip on token burn rate.
 *
 * Run: node examples/basic.js
 *
 * Spawns a fake "agent" (infinite loop printing) and reports a token
 * count every 200ms. With maxTokensPerMinute set low, Aegis trips
 * within a couple seconds and kills the child.
 */
"use strict";

const { AegisNode } = require("../src/index.js");

const aegis = new AegisNode({
  command: process.platform === "win32" ? "cmd" : "bash",
  args:
    process.platform === "win32"
      ? ["/c", "for /l %i in () do (echo agent tick & timeout /t 1 >nul)"]
      : ["-c", "while true; do echo agent tick; sleep 1; done"],
  limits: {
    maxTokensPerMinute: 5000, // low on purpose for the demo
    maxApiCallsPerMinute: 30,
    maxRepeatedActions: 10,
    repeatedActionWindowMs: 30_000,
  },
  onTrip: (reason, detail) => {
    console.log(`\n!! AEGIS TRIPPED: ${reason}`, detail);
    console.log("Agent process killed.");
  },
  onStatus: (s) => console.log("status:", s),
});

aegis.start();

// Simulate the agent reporting heavy token usage every 200ms (= 30,000/min)
const interval = setInterval(() => {
  aegis.reportTokens(1000);
  aegis.reportAction("tool:bash:echo"); // same action repeated -> also trips loop detection
}, 200);

setTimeout(() => clearInterval(interval), 10_000);
