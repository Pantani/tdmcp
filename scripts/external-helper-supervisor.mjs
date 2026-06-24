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

export function runJsonLineHelper(options) {
  const {
    command,
    args = [],
    label = "external-helper",
    stallTimeoutMs = 0,
    stallCheckIntervalMs,
    killGraceMs = 1200,
    maxRestarts = Number.POSITIVE_INFINITY,
    onJson,
    onStatus,
    onStderr = defaultStderr,
    log = defaultLog,
    formatStallMessage,
    formatLineError,
    formatExitError,
    spawnImpl = spawn,
    now = () => Date.now(),
  } = options;

  if (typeof command !== "string" || command.length === 0) {
    throw new Error("runJsonLineHelper requires a command");
  }
  if (typeof onJson !== "function") {
    throw new Error("runJsonLineHelper requires onJson");
  }

  const timeoutMs = Math.max(0, Number(stallTimeoutMs ?? 0));
  const restartLimit = Number.isFinite(maxRestarts)
    ? Math.max(0, Number(maxRestarts))
    : Number.POSITIVE_INFINITY;

  return new Promise((resolve, reject) => {
    let settled = false;
    let restartCount = 0;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const launchHelper = () => {
      const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let childExited = false;
      let lastFrameAt = now();
      let restartRequested = false;
      onStatus?.({ type: "start", restartCount, pid: child.pid });

      const killAfterGrace = () => {
        const killTimer = setTimeout(() => {
          if (!childExited) child.kill("SIGKILL");
        }, killGraceMs);
        killTimer.unref?.();
      };

      const intervalMs = stallCheckIntervalMs ?? Math.max(1000, Math.min(2000, timeoutMs || 1000));
      const stallTimer =
        timeoutMs > 0
          ? setInterval(() => {
              if (childExited || restartRequested || settled) return;
              const silenceMs = now() - lastFrameAt;
              if (silenceMs <= timeoutMs) return;
              if (restartCount >= restartLimit) {
                const err = new Error(
                  `${label} stalled for ${silenceMs}ms after ${restartCount} restarts`,
                );
                onStatus?.({ type: "stall_limit", restartCount, silenceMs });
                child.kill("SIGTERM");
                killAfterGrace();
                settle(reject, err);
                return;
              }
              restartRequested = true;
              const nextRestartCount = restartCount + 1;
              const message =
                formatStallMessage?.({
                  silenceMs,
                  restartCount: nextRestartCount,
                  pid: child.pid,
                }) ?? `[${label}] stalled for ${silenceMs}ms; restarting helper`;
              log(message);
              onStatus?.({
                type: "stall",
                restartCount: nextRestartCount,
                silenceMs,
                pid: child.pid,
              });
              child.kill("SIGTERM");
              killAfterGrace();
            }, intervalMs)
          : undefined;

      child.stderr.on("data", onStderr);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.trim().startsWith("{")) return;
        lastFrameAt = now();
        try {
          onJson(JSON.parse(line));
          onStatus?.({ type: "frame", restartCount, pid: child.pid });
        } catch (err) {
          const message = formatLineError?.(err, line) ?? defaultLineError(label, err);
          log(message);
        }
      });

      const clearStallTimer = () => {
        if (stallTimer !== undefined) clearInterval(stallTimer);
      };

      child.on("error", (err) => {
        childExited = true;
        clearStallTimer();
        lines.close();
        settle(reject, err);
      });

      child.on("exit", (code, signal) => {
        childExited = true;
        clearStallTimer();
        lines.close();
        onStatus?.({ type: "exit", restartCount, code, signal, pid: child.pid });
        if (restartRequested && !settled) {
          restartCount += 1;
          launchHelper();
          return;
        }
        if (code === 0) {
          settle(resolve);
        } else {
          const message = formatExitError?.(code, signal) ?? defaultExitError(label, code, signal);
          settle(reject, new Error(message));
        }
      });
    };

    launchHelper();
  });
}
