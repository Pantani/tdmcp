import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function defaultLog(line) {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

function defaultStderr(chunk) {
  process.stderr.write(chunk);
}

function defaultLineError(label, err) {
  return `[${label}] ignored helper line: ${err.message}`;
}

function defaultExitError(label, code, signal) {
  return `${label} exited with code ${code ?? signal}`;
}

function statusDefaults(type, code) {
  if (type === "start") return { state: "starting", ok: true, stale: false };
  if (type === "frame") return { state: "running", ok: true, stale: false };
  if (type === "stall" || type === "stall_limit") {
    return { state: "stalled", ok: false, stale: true };
  }
  if (type === "line_error") return { state: "running", ok: false, stale: false };
  if (type === "error") return { state: "failed", ok: false, stale: false };
  if (type === "exit" && code === 0) return { state: "exited", ok: true, stale: false };
  return { state: "failed", ok: false, stale: false };
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function restartLimit(maxRestarts) {
  return Number.isFinite(maxRestarts) ? Math.max(0, Number(maxRestarts)) : Number.POSITIVE_INFINITY;
}

function commandOptions(options) {
  return {
    args: options.args ?? [],
    command: options.command,
    label: options.label ?? "external-helper",
  };
}

function timingOptions(options) {
  return {
    killGraceMs: options.killGraceMs ?? 1200,
    restartLimit: restartLimit(options.maxRestarts ?? Number.POSITIVE_INFINITY),
    stallCheckIntervalMs: options.stallCheckIntervalMs,
    timeoutMs: Math.max(0, Number(options.stallTimeoutMs ?? 0)),
  };
}

function callbackOptions(options) {
  return {
    formatExitError: options.formatExitError,
    formatLineError: options.formatLineError,
    formatStallMessage: options.formatStallMessage,
    log: options.log ?? defaultLog,
    now: options.now ?? (() => Date.now()),
    onJson: options.onJson,
    onStatus: options.onStatus,
    onStderr: options.onStderr ?? defaultStderr,
    spawnImpl: options.spawnImpl ?? spawn,
  };
}

class JsonLineHelperRun {
  constructor(options) {
    Object.assign(this, commandOptions(options), timingOptions(options), callbackOptions(options));
    this.settled = false;
    this.restartCount = 0;
  }

  run() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.launchHelper();
    });
  }

  settleResolve() {
    if (this.settled) return;
    this.settled = true;
    this.resolve();
  }

  settleReject(err) {
    if (this.settled) return;
    this.settled = true;
    this.reject(err);
  }

  launchHelper() {
    const child = this.spawnImpl(this.command, this.args, { stdio: ["ignore", "pipe", "pipe"] });
    const run = {
      child,
      childExited: false,
      lastFrameAt: this.now(),
      restartRequested: false,
      startedAtMs: 0,
      stallTimer: undefined,
    };
    run.startedAtMs = run.lastFrameAt;
    this.emitStatus(run, { type: "start", restartCount: this.restartCount, pid: child.pid });
    run.stallTimer = this.createStallTimer(run);
    child.stderr.on("data", this.onStderr);
    run.lines = createInterface({ input: child.stdout });
    run.lines.on("line", (line) => this.handleLine(run, line));
    child.on("error", (err) => this.handleChildError(run, err));
    child.on("exit", (code, signal) => this.handleChildExit(run, code, signal));
  }

  buildStatus(run, event, observedAtMs = this.now()) {
    const defaults = statusDefaults(event.type, event.code);
    return {
      label: this.label,
      ...defaults,
      ...event,
      restartCount: event.restartCount ?? this.restartCount,
      pid: event.pid ?? run.child.pid,
      startedAtMs: run.startedAtMs,
      lastFrameAtMs: run.lastFrameAt,
      lastFrameAgeMs: Math.max(0, observedAtMs - run.lastFrameAt),
    };
  }

  emitStatus(run, event, observedAtMs = this.now()) {
    this.onStatus?.(this.buildStatus(run, event, observedAtMs));
  }

  killAfterGrace(run) {
    const killTimer = setTimeout(() => {
      if (!run.childExited) run.child.kill("SIGKILL");
    }, this.killGraceMs);
    killTimer.unref?.();
  }

  createStallTimer(run) {
    if (this.timeoutMs <= 0) return undefined;
    const intervalMs =
      this.stallCheckIntervalMs ?? Math.max(1000, Math.min(2000, this.timeoutMs || 1000));
    return setInterval(() => this.handleStallCheck(run), intervalMs);
  }

  handleStallCheck(run) {
    if (run.childExited || run.restartRequested || this.settled) return;
    const observedAtMs = this.now();
    const silenceMs = observedAtMs - run.lastFrameAt;
    if (silenceMs <= this.timeoutMs) return;
    if (this.restartCount >= this.restartLimit) {
      this.rejectStalledRun(run, silenceMs, observedAtMs);
      return;
    }
    this.requestRestart(run, silenceMs, observedAtMs);
  }

  rejectStalledRun(run, silenceMs, observedAtMs) {
    const err = new Error(
      `${this.label} stalled for ${silenceMs}ms after ${this.restartCount} restarts`,
    );
    this.emitStatus(
      run,
      { type: "stall_limit", restartCount: this.restartCount, silenceMs, error: err.message },
      observedAtMs,
    );
    run.child.kill("SIGTERM");
    this.killAfterGrace(run);
    this.settleReject(err);
  }

  requestRestart(run, silenceMs, observedAtMs) {
    run.restartRequested = true;
    const nextRestartCount = this.restartCount + 1;
    const message =
      this.formatStallMessage?.({
        silenceMs,
        restartCount: nextRestartCount,
        pid: run.child.pid,
      }) ?? `[${this.label}] stalled for ${silenceMs}ms; restarting helper`;
    this.log(message);
    this.emitStatus(
      run,
      { type: "stall", restartCount: nextRestartCount, silenceMs, pid: run.child.pid },
      observedAtMs,
    );
    run.child.kill("SIGTERM");
    this.killAfterGrace(run);
  }

  handleLine(run, line) {
    if (!line.trim().startsWith("{")) return;
    const observedAtMs = this.now();
    run.lastFrameAt = observedAtMs;
    try {
      this.onJson(JSON.parse(line));
      this.emitStatus(
        run,
        { type: "frame", restartCount: this.restartCount, pid: run.child.pid },
        observedAtMs,
      );
    } catch (err) {
      this.handleLineError(run, err, line, observedAtMs);
    }
  }

  handleLineError(run, err, line, observedAtMs) {
    const message = this.formatLineError?.(err, line) ?? defaultLineError(this.label, err);
    this.log(message);
    this.emitStatus(
      run,
      { type: "line_error", restartCount: this.restartCount, pid: run.child.pid, error: message },
      observedAtMs,
    );
  }

  clearStallTimer(run) {
    if (run.stallTimer !== undefined) clearInterval(run.stallTimer);
  }

  handleChildError(run, err) {
    run.childExited = true;
    this.clearStallTimer(run);
    run.lines.close();
    this.emitStatus(run, {
      type: "error",
      restartCount: this.restartCount,
      pid: run.child.pid,
      error: errorMessage(err),
    });
    this.settleReject(err);
  }

  handleChildExit(run, code, signal) {
    run.childExited = true;
    this.clearStallTimer(run);
    run.lines.close();
    if (this.settled && !run.restartRequested) return;
    this.emitStatus(run, {
      type: "exit",
      restartCount: this.restartCount,
      code,
      signal,
      pid: run.child.pid,
    });
    if (run.restartRequested && !this.settled) {
      this.restartCount += 1;
      this.launchHelper();
      return;
    }
    if (code === 0) {
      this.settleResolve();
      return;
    }
    const message =
      this.formatExitError?.(code, signal) ?? defaultExitError(this.label, code, signal);
    this.settleReject(new Error(message));
  }
}

export function runJsonLineHelper(options) {
  if (typeof options.command !== "string" || options.command.length === 0) {
    throw new Error("runJsonLineHelper requires a command");
  }
  if (typeof options.onJson !== "function") {
    throw new Error("runJsonLineHelper requires onJson");
  }
  return new JsonLineHelperRun(options).run();
}
