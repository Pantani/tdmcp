/**
 * Project RAG — `.toe`/`.tox` static analysis via an external `toeexpand` CLI.
 *
 * Safety model — we treat `.toe`/`.tox` files as untrusted:
 *
 * - Node never opens the artifact itself; the file is copied into a UUID temp
 *   directory under `os.tmpdir()` and only the **basename** is passed to the
 *   subprocess (no user-supplied absolute paths cross the spawn boundary).
 * - The subprocess is invoked with `spawn` (never `exec`/shell) and a reduced
 *   env containing only `PATH`, `HOME`, and `LANG=C.UTF-8`.
 * - The child is its own process group leader (`detached: true`); on timeout we
 *   `kill(-pid, "SIGKILL")` so the entire group dies — `toeexpand` can fork
 *   helpers, and a plain SIGKILL on the leader would orphan them.
 * - The quarantine directory is always removed on every exit path
 *   (success / failure / timeout) via `try/finally`.
 * - Missing binary degrades to `status: "skipped"` (not failed) so the rest of
 *   the Project RAG pipeline can proceed.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type ToeExpandStatus = "ok" | "failed" | "skipped";

export interface ToeExpandResult {
  status: ToeExpandStatus;
  /** Full ASCII output captured from stdout. Present only when status === "ok". */
  asciiText?: string;
  /** Heuristic op count derived from a regex over the ASCII. */
  opCount?: number;
  /** Reason for skipped, or short error message for failed. */
  reason?: string;
  error?: string;
}

export interface ToeExpandOptions {
  /** Absolute path to the .toe or .tox file. */
  artifactPath: string;
  /** Path to the toeExpand-like binary (default "toeexpand"). */
  binaryPath?: string;
  /** Hard timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Optional override for child_process.spawn — TESTS ONLY. */
  spawnImpl?: typeof defaultSpawn;
  /** Optional override for the temp dir base — TESTS ONLY. */
  tmpDirBase?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BINARY = "toeexpand";
const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
const SKIPPED_REASON = "toeExpand binary not installed (set TDMCP_PROJECT_RAG_TOEEXPAND_BIN)";

/** Counts operators in `toeexpand` ASCII output (prefers `OP ` lines, falls back to `node:`). */
export function parseAsciiOpCount(ascii: string): number {
  const opMatches = ascii.match(/^OP\s+/gm);
  if (opMatches !== null && opMatches.length > 0) return opMatches.length;
  const nodeMatches = ascii.match(/^node:/gm);
  return nodeMatches !== null ? nodeMatches.length : 0;
}

interface QuarantineSetup {
  qdir: string;
  copiedBasename: string;
}

function prepareQuarantine(artifactPath: string, tmpDirBase: string): QuarantineSetup {
  const qdir = path.join(tmpDirBase, "tdmcp-prag-toe", randomUUID());
  mkdirSync(qdir, { recursive: true });
  const ext = path.extname(artifactPath);
  const copiedBasename = `input${ext}`;
  copyFileSync(artifactPath, path.join(qdir, copiedBasename));
  return { qdir, copiedBasename };
}

function cleanupQuarantine(qdir: string): void {
  try {
    rmSync(qdir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

interface SubprocessOutcome {
  status: ToeExpandStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
  capExceeded: boolean;
}

function runSubprocess(
  binaryPath: string,
  args: string[],
  qdir: string,
  timeoutMs: number,
  spawnImpl: typeof defaultSpawn,
): Promise<SubprocessOutcome> {
  return new Promise((resolve) => {
    const child = spawnImpl(binaryPath, args, {
      cwd: qdir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: "C.UTF-8",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let capExceeded = false;
    let settled = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH (already dead) is fine
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // Resolve immediately — child may not emit close after group-kill on every platform.
      if (!settled) {
        settled = true;
        resolve({
          status: "failed",
          stdout,
          stderr,
          exitCode: null,
          timedOut: true,
          capExceeded,
        });
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (capExceeded) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP_BYTES) {
        capExceeded = true;
        killGroup();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDOUT_CAP_BYTES) {
        capExceeded = true;
        killGroup();
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        status: "failed",
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        spawnError: err,
        capExceeded,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        status: "ok",
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        capExceeded,
      });
    });
  });
}

function classifyOutcome(outcome: SubprocessOutcome): ToeExpandResult {
  if (outcome.spawnError !== undefined) {
    if (outcome.spawnError.code === "ENOENT") {
      return { status: "skipped", reason: SKIPPED_REASON };
    }
    return { status: "failed", error: outcome.spawnError.message };
  }
  if (outcome.timedOut) {
    return { status: "failed", error: "timeout exceeded" };
  }
  if (outcome.capExceeded) {
    return { status: "failed", error: "stdout exceeded cap" };
  }
  if (outcome.exitCode !== 0) {
    const tail = outcome.stderr.trim().slice(0, 500);
    return {
      status: "failed",
      error: tail.length > 0 ? tail : `exited with code ${outcome.exitCode}`,
    };
  }
  return {
    status: "ok",
    asciiText: outcome.stdout,
    opCount: parseAsciiOpCount(outcome.stdout),
  };
}

/**
 * Runs an external `toeexpand`-like CLI on a `.toe`/`.tox` file and returns the
 * ASCII representation plus a heuristic op count. Never throws — degrades to
 * `{status: "skipped"}` when the binary is missing or `{status: "failed"}`
 * for any other error.
 */
export async function runToeExpand(opts: ToeExpandOptions): Promise<ToeExpandResult> {
  const artifactPath = opts.artifactPath;
  if (!path.isAbsolute(artifactPath)) {
    return { status: "failed", error: "artifactPath must be absolute" };
  }
  if (!existsSync(artifactPath)) {
    return { status: "failed", error: `artifact not found: ${artifactPath}` };
  }

  const binaryPath = opts.binaryPath ?? DEFAULT_BINARY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const tmpDirBase = opts.tmpDirBase ?? tmpdir();

  let qdir: string | undefined;
  try {
    const setup = prepareQuarantine(artifactPath, tmpDirBase);
    qdir = setup.qdir;
    const outcome = await runSubprocess(
      binaryPath,
      [setup.copiedBasename],
      qdir,
      timeoutMs,
      spawnImpl,
    );
    return classifyOutcome(outcome);
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (qdir !== undefined) cleanupQuarantine(qdir);
  }
}
