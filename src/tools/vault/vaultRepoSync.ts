import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const vaultRepoSyncSchema = z.object({
  vault_path: z
    .string()
    .optional()
    .describe("Absolute path to the vault git repo. Defaults to the configured TDMCP_VAULT_PATH."),
  action: z
    .enum(["status", "pull", "push", "log"])
    .default("status")
    .describe(
      "status: staged/unstaged/untracked + ahead/behind counts. " +
        "pull: fetch + ff-only merge; reports conflicts but never auto-resolves. " +
        "push: push current branch to its upstream; reports rejections. " +
        "log: last N commits on the current branch.",
    ),
  remote: z.string().default("origin").describe("Remote name for pull/push."),
  branch: z
    .string()
    .optional()
    .describe("Branch for pull/push. Defaults to the currently checked-out branch."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe("Max commits returned by action:'log'."),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(30_000)
    .describe("Hard timeout for the git child process."),
});

type VaultRepoSyncArgs = z.infer<typeof vaultRepoSyncSchema>;

export interface StatusResult {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}

export interface PullResult {
  fetched: boolean;
  fast_forwarded: boolean;
  new_head: string | null;
  conflicts: string[];
  message: string;
}

export interface PushResult {
  pushed: boolean;
  rejected_reason: string | null;
  remote_ref: string | null;
}

export interface LogCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

// Unit separator / record separator characters used in git pretty format
const US = "\x1f";
const RS = "\x1e";

/** Scrubbed env for git child processes — never propagate host secrets to git. */
function safeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };
}

/** Run git with a hard timeout. Returns { stdout, stderr, code }. */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: safeEnv(),
      signal: ac.signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
        killed: signal === "SIGTERM" || signal === "SIGKILL" || child.killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      // AbortController turns into an error with code ABORT_ERR
      const killed = (err as NodeJS.ErrnoException).code === "ABORT_ERR" || child.killed;
      resolve({ stdout, stderr: err.message, code: 1, killed });
    });
  });
}

/** Resolve and validate the vault path, returning an error string on failure. */
async function resolveVaultPath(
  args: VaultRepoSyncArgs,
  ctx: ToolContext,
): Promise<{ vaultPath: string } | { errMsg: string }> {
  const raw = args.vault_path ?? ctx.vault?.root;
  if (!raw) {
    return {
      errMsg:
        "No vault path provided and TDMCP_VAULT_PATH is not set. " +
        "Supply vault_path or configure TDMCP_VAULT_PATH.",
    };
  }
  if (raw.includes("\0")) {
    return { errMsg: "vault_path contains a null byte and is not valid." };
  }
  const vaultPath = path.resolve(raw);
  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(vaultPath);
  } catch {
    return { errMsg: `vault_path does not exist: ${vaultPath}` };
  }
  if (!dirStat.isDirectory()) {
    return { errMsg: `vault_path is not a directory: ${vaultPath}` };
  }
  try {
    await stat(path.join(vaultPath, ".git"));
  } catch {
    return {
      errMsg:
        `${vaultPath} is not a git repository (no .git entry found). ` +
        "Run 'git init' or point vault_path at your vault's git root.",
    };
  }
  return { vaultPath };
}

/** Parse git status --porcelain=v2 -z output. */
function parseStatusV2(
  raw: string,
): Omit<StatusResult, "branch" | "upstream" | "ahead" | "behind"> {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  // Split on NUL; headers start with '#', entries don't
  const lines = raw.split("\0").filter((l) => l.length > 0 && !l.startsWith("#"));
  for (const line of lines) {
    if (line.startsWith("?")) {
      // untracked: "? filename"
      untracked.push(line.slice(2));
      continue;
    }
    if (line.startsWith("!")) continue; // ignored
    if (line.startsWith("u ")) {
      // unmerged
      const parts = line.split(" ");
      const fname = parts.slice(10).join(" ");
      conflicted.push(fname);
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const X = xy[0] ?? ".";
      const Y = xy[1] ?? ".";
      const fname = line.startsWith("1 ") ? parts.slice(8).join(" ") : parts.slice(9).join(" ");
      if (X !== "." && X !== "?") staged.push(fname);
      if (Y !== "." && Y !== "?") unstaged.push(fname);
    }
  }
  return { staged, unstaged, untracked, conflicted };
}

/** Parse # branch.* headers from porcelain v2 output. */
function parseBranchHeaders(raw: string): {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
} {
  let branch = "HEAD";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of raw.split("\0")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1] ?? "0", 10);
        behind = parseInt(m[2] ?? "0", 10);
      }
    }
  }
  return { branch, upstream, ahead, behind };
}

async function resolveCurrentBranch(vaultPath: string, timeoutMs: number): Promise<string | null> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], vaultPath, timeoutMs);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

async function resolveCurrentHead(vaultPath: string, timeoutMs: number): Promise<string | null> {
  const r = await runGit(["rev-parse", "HEAD"], vaultPath, timeoutMs);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

async function doStatus(vaultPath: string, timeoutMs: number): Promise<StatusResult> {
  const r = await runGit(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    vaultPath,
    timeoutMs,
  );
  // status can exit non-zero in weird states; best-effort parse
  const headers = parseBranchHeaders(r.stdout);
  const entries = parseStatusV2(r.stdout);
  return { ...headers, ...entries };
}

// ---- public impl ----

export async function vaultRepoSyncImpl(ctx: ToolContext, args: VaultRepoSyncArgs) {
  const resolved = await resolveVaultPath(args, ctx);
  if ("errMsg" in resolved) return errorResult(resolved.errMsg);
  const { vaultPath } = resolved;
  const timeout = args.timeout_ms;

  if (args.action === "status") {
    let status: StatusResult;
    try {
      status = await doStatus(vaultPath, timeout);
    } catch (err) {
      return errorResult(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return jsonResult("Vault git status.", status);
  }

  if (args.action === "log") {
    const fmt = `%H${US}%an${US}%aI${US}%s`;
    const r = await runGit(
      ["log", `-n${args.limit}`, `--pretty=format:${fmt}`, "--no-color"],
      vaultPath,
      timeout,
    );
    if (r.killed) return errorResult(`git log timed out after ${timeout}ms.`);
    if (r.code !== 0) return errorResult(`git log failed: ${r.stderr.trim()}`);

    const commits: LogCommit[] = r.stdout
      .split(RS)
      .flatMap((block) => block.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(US);
        return {
          sha: parts[0] ?? "",
          author: parts[1] ?? "",
          date: parts[2] ?? "",
          subject: parts[3] ?? "",
        };
      })
      .filter((c) => c.sha.length > 0);

    return jsonResult(`Last ${commits.length} commit(s).`, { commits });
  }

  // Resolve branch
  const branch = args.branch ?? (await resolveCurrentBranch(vaultPath, timeout));
  if (!branch) return errorResult("Could not determine current branch (git rev-parse failed).");

  if (args.action === "pull") {
    const fetch = await runGit(
      ["fetch", "--no-tags", "--", args.remote, branch],
      vaultPath,
      timeout,
    );
    if (fetch.killed) return errorResult(`git fetch timed out after ${timeout}ms.`);
    if (fetch.code !== 0) {
      return errorResult(`git fetch failed: ${fetch.stderr.trim()}`);
    }

    const merge = await runGit(["merge", "--ff-only", "FETCH_HEAD"], vaultPath, timeout);
    if (merge.killed) return errorResult(`git merge timed out after ${timeout}ms.`);

    if (merge.code !== 0) {
      const headBefore = await resolveCurrentHead(vaultPath, timeout);
      const result: PullResult = {
        fetched: true,
        fast_forwarded: false,
        new_head: headBefore,
        conflicts: [],
        message:
          "Diverged — manual merge required. " +
          "This tool never auto-resolves conflicts. Run 'git merge' or 'git rebase' manually.",
      };
      return errorResult(`Fast-forward merge failed: ${merge.stderr.trim()}`, result);
    }

    const newHead = await resolveCurrentHead(vaultPath, timeout);
    const alreadyUpToDate = merge.stdout.includes("Already up to date");
    const status = await doStatus(vaultPath, timeout);

    const result: PullResult = {
      fetched: true,
      fast_forwarded: true,
      new_head: newHead,
      conflicts: status.conflicted,
      message: alreadyUpToDate
        ? "Already up to date."
        : `Fast-forwarded to ${newHead?.slice(0, 8) ?? "unknown"}.`,
    };
    return jsonResult(result.message, result);
  }

  // push
  const push = await runGit(["push", "--", args.remote, branch], vaultPath, timeout);
  if (push.killed) return errorResult(`git push timed out after ${timeout}ms.`);

  if (push.code !== 0) {
    const result: PushResult = {
      pushed: false,
      rejected_reason: push.stderr.trim(),
      remote_ref: null,
    };
    return errorResult(`git push rejected: ${push.stderr.trim()}`, result);
  }

  // Parse remote tracking ref from stderr (git push prints "branch -> remote/branch")
  const refMatch = push.stderr.match(/\*\s+\S+\s+->\s+(\S+)/);
  const remoteRef = refMatch ? `refs/heads/${refMatch[1] ?? branch}` : `refs/heads/${branch}`;

  const result: PushResult = {
    pushed: true,
    rejected_reason: null,
    remote_ref: remoteRef,
  };
  return jsonResult(`Pushed ${branch} to ${args.remote}.`, result);
}

export const registerVaultRepoSync: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "vault_repo_sync",
    {
      title: "Vault git status and conflict-aware sync",
      description:
        "Read-mostly git wrapper for the configured Obsidian vault directory. " +
        "Lets an artist see what's changed (status), fetch/fast-forward-only pull, push, " +
        "or read recent history (log). " +
        "Never auto-resolves conflicts. Never uses --force. Never invokes a shell. " +
        "Conflicts are surfaced as structured data for manual resolution. " +
        "Requires TDMCP_VAULT_PATH or the vault_path argument.",
      inputSchema: vaultRepoSyncSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args) => vaultRepoSyncImpl(ctx, args),
  );
};
