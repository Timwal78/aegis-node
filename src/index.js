/**
 * AEGIS-NODE — Autonomous Agent Blast Shield
 * ════════════════════════════════════════════
 * Hardware-agnostic, zero-dependency kill switch for AI agent processes.
 *
 * - Spawns your agent as a child process.
 * - Runs a separate watcher thread (worker_threads) that tracks token burn
 *   rate, API call rate, and repeated-action loops on rolling 60s windows.
 * - On breach: kills the agent process tree immediately and (best-effort,
 *   Linux) tears down its network namespace so it cannot make further
 *   outbound calls even mid-shutdown.
 *
 * Zero npm dependencies — Node builtins only.
 */
"use strict";

const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { Worker } = require("worker_threads");

const MONITOR_PATH = path.join(__dirname, "monitor.js");

class AegisNode {
  /**
   * @param {object} opts
   * @param {string} opts.command - executable to run as the agent
   * @param {string[]} [opts.args] - args for the command
   * @param {object} [opts.env] - extra env vars for the agent process
   * @param {object} [opts.limits]
   * @param {number} [opts.limits.maxTokensPerMinute]
   * @param {number} [opts.limits.maxApiCallsPerMinute]
   * @param {number} [opts.limits.maxRepeatedActions]
   * @param {number} [opts.limits.repeatedActionWindowMs]
   * @param {function(string, object): void} [opts.onTrip] - called with (reason, detail)
   * @param {function(object): void} [opts.onStatus] - called with rolling stats every heartbeat
   * @param {boolean} [opts.networkNamespace] - Linux only: run agent in an isolated
   *   network namespace (requires `unshare` + root/CAP_NET_ADMIN). Default false.
   */
  constructor(opts) {
    if (!opts || !opts.command) {
      throw new Error("AegisNode requires { command }");
    }
    this.command = opts.command;
    this.args = opts.args || [];
    this.env = opts.env || {};
    this.limits = opts.limits || {};
    this.onTrip = opts.onTrip || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.networkNamespace =
      !!opts.networkNamespace && os.platform() === "linux";

    this.child = null;
    this.monitor = null;
    this.tripped = false;
    this.tripReason = null;
  }

  /** Start the agent process and the watcher thread. */
  start() {
    this.monitor = new Worker(MONITOR_PATH, {
      workerData: { limits: this.limits },
    });

    this.monitor.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "trip") this._trip(msg.reason, msg.detail);
      else if (msg.type === "status") this.onStatus(msg);
    });

    this.monitor.on("error", (err) => {
      // The watcher thread itself crashing is treated as a trip condition —
      // a dead blast shield is worse than a noisy one.
      this._trip("MONITOR_THREAD_ERROR", { message: err.message });
    });

    const spawnCmd = this.command;
    const spawnArgs = this.args;
    const spawnOpts = {
      env: Object.assign({}, process.env, this.env),
      stdio: "inherit",
      // detached so we can kill the whole process group, not just one pid
      detached: os.platform() !== "win32",
    };

    if (this.networkNamespace) {
      // Best-effort: run inside a fresh, unconnected network namespace.
      // Requires CAP_NET_ADMIN. Falls back silently to normal spawn if it fails.
      this.child = spawn(
        "unshare",
        ["--net", "--map-root-user", spawnCmd, ...spawnArgs],
        spawnOpts
      );
      this.child.on("error", () => {
        this.child = spawn(spawnCmd, spawnArgs, spawnOpts);
        this._wireExit();
      });
    } else {
      this.child = spawn(spawnCmd, spawnArgs, spawnOpts);
    }

    this._wireExit();
    return this;
  }

  _wireExit() {
    if (!this.child) return;
    this.child.on("exit", (code, signal) => {
      if (!this.tripped) this.shutdown();
    });
  }

  // ── Reporting hooks — call these from your agent's instrumentation ──

  /** Report N tokens consumed (prompt + completion combined or separately). */
  reportTokens(amount) {
    this._send({ type: "tokens", amount });
  }

  /** Report an outbound API call by name/endpoint. */
  reportApiCall(name) {
    this._send({ type: "api_call", name });
  }

  /** Report a discrete agent action for loop detection (e.g. tool+args hash). */
  reportAction(signature) {
    this._send({ type: "action", signature });
  }

  _send(msg) {
    if (this.monitor && !this.tripped) {
      try {
        this.monitor.postMessage(msg);
      } catch (_) {
        /* monitor thread gone — ignore, exit handler will handle cleanup */
      }
    }
  }

  // ── Trip / shutdown ──

  _trip(reason, detail) {
    if (this.tripped) return;
    this.tripped = true;
    this.tripReason = reason;
    try {
      this.onTrip(reason, detail);
    } catch (_) {
      /* swallow user callback errors — shutdown must proceed */
    }
    this._severNetwork();
    this._killChild();
    this._stopMonitor();
  }

  _severNetwork() {
    if (os.platform() !== "linux" || !this.child || !this.child.pid) return;
    // Best-effort: drop all outbound traffic for this PID via iptables owner match.
    // Requires root. Silently no-ops if unavailable — process kill below is the
    // guaranteed fallback.
    execFile(
      "iptables",
      [
        "-I", "OUTPUT", "1",
        "-m", "owner", "--pid-owner", String(this.child.pid),
        "-j", "DROP",
      ],
      () => {}
    );
  }

  _killChild() {
    if (!this.child) return;
    try {
      if (os.platform() === "win32") {
        spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"]);
      } else {
        // negative pid = kill the whole process group (we spawned detached)
        process.kill(-this.child.pid, "SIGKILL");
      }
    } catch (_) {
      try {
        this.child.kill("SIGKILL");
      } catch (_) {}
    }
  }

  _stopMonitor() {
    if (this.monitor) {
      this.monitor.terminate().catch(() => {});
      this.monitor = null;
    }
  }

  /** Clean shutdown without flagging a trip (e.g. agent exited normally). */
  shutdown() {
    this._stopMonitor();
  }
}

module.exports = { AegisNode };
