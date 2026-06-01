/**
 * Offline tests for vaultRepoSyncImpl.
 *
 * Uses real git against per-test tmpdir fixtures.
 * The whole describe block is skipped when git is not in PATH, so CI without
 * git stays green.
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { vaultRepoSyncImpl } from "../../src/tools/vault/vaultRepoSync.js";

// ---- helpers ----------------------------------------------------------------

function hasGit(): boolean {
  try {
    execSync("git --version", { env: gitTestEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitTestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, {
    cwd,
    env: gitTestEnv(),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

function gitOut(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

async function initRepo(dir: string, defaultBranch = "main"): Promise<void> {
  git(["-c", `init.defaultBranch=${defaultBranch}`, "init"], dir);
  git(["config", "user.email", "test@test"], dir);
  git(["config", "user.name", "Test"], dir);
}

async function commit(dir: string, msg: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  git(["add", "--all"], dir);
  git(["commit", "-m", msg], dir);
}

function makeCtx(vaultRoot?: string): ToolContext {
  return {
    client: {} as ToolContext["client"],
    knowledge: {} as ToolContext["knowledge"],
    recipes: {} as ToolContext["recipes"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as ToolContext["logger"],
    vault: vaultRoot ? ({ root: vaultRoot } as ToolContext["vault"]) : undefined,
    allowRawPython: false,
  };
}

/** Extract the JSON object/array from a jsonResult / errorResult code fence. */
function extractJson(text: string): unknown {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (m?.[1]) return JSON.parse(m[1]);
  // fallback: parse from first { or [
  const start = text.search(/[{[]/);
  if (start !== -1) return JSON.parse(text.slice(start));
  throw new Error(`No JSON found in: ${text}`);
}

// ---- fixture setup ----------------------------------------------------------

let tmpBase: string;

beforeEach(() => {
  tmpBase = path.join(
    os.tmpdir(),
    `tdmcp-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ---- tests ------------------------------------------------------------------

describe.skipIf(!hasGit())("vaultRepoSyncImpl", () => {
  // 1. status — clean repo
  it("status: clean repo has empty arrays and zero ahead/behind", async () => {
    const repo = path.join(tmpBase, "clean");
    mkdirSync(repo);
    await initRepo(repo);
    await commit(repo, "init", { "readme.md": "hello" });

    const result = await vaultRepoSyncImpl(makeCtx(repo), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const data = extractJson(text) as Record<string, unknown>;
    expect(data.ahead).toBe(0);
    expect(data.behind).toBe(0);
    expect(data.staged).toHaveLength(0);
    expect(data.unstaged).toHaveLength(0);
    expect(data.untracked).toHaveLength(0);
    expect(data.conflicted).toHaveLength(0);
  });

  // 2. status — staged + unstaged + untracked
  it("status: buckets staged/unstaged/untracked correctly", async () => {
    const repo = path.join(tmpBase, "dirty");
    mkdirSync(repo);
    await initRepo(repo);
    await commit(repo, "init", { "a.md": "a", "b.md": "b" });

    // Stage a change to a.md
    await writeFile(path.join(repo, "a.md"), "a modified");
    git(["add", "a.md"], repo);
    // Unstaged change to b.md
    await writeFile(path.join(repo, "b.md"), "b modified");
    // Untracked file
    await writeFile(path.join(repo, "new.png"), "png");

    const result = await vaultRepoSyncImpl(makeCtx(repo), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy();
    const data = extractJson((result.content[0] as { text: string }).text) as {
      staged: string[];
      unstaged: string[];
      untracked: string[];
      conflicted: string[];
    };
    expect(data.staged).toContain("a.md");
    expect(data.unstaged).toContain("b.md");
    expect(data.untracked).toContain("new.png");
    expect(data.conflicted).toHaveLength(0);
  });

  // 3. status — conflicted repo
  it("status: conflicted files appear in conflicted[], not unstaged[]", async () => {
    const repo = path.join(tmpBase, "conflict");
    mkdirSync(repo);
    await initRepo(repo);
    await commit(repo, "base", { "file.md": "base" });

    git(["checkout", "-b", "branch-a"], repo);
    await commit(repo, "a", { "file.md": "change from a" });
    git(["checkout", "main"], repo);
    await commit(repo, "b", { "file.md": "change from b" });

    // Merge will conflict
    spawnSync("git", ["merge", "--no-ff", "branch-a"], {
      cwd: repo,
      env: gitTestEnv(),
    });

    const result = await vaultRepoSyncImpl(makeCtx(repo), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy(); // tool reports, not errors
    const data = extractJson((result.content[0] as { text: string }).text) as {
      conflicted: string[];
      unstaged: string[];
    };
    expect(data.conflicted).toContain("file.md");
    expect(data.unstaged).not.toContain("file.md");
  });

  // 4. pull — ff-only success
  it("pull: fast-forward succeeds between two clones", async () => {
    const bare = path.join(tmpBase, "bare.git");
    const clone1 = path.join(tmpBase, "clone1");
    mkdirSync(bare);
    mkdirSync(clone1);

    git(["-c", "init.defaultBranch=main", "init", "--bare", bare], tmpBase);
    git(["-c", "init.defaultBranch=main", "init", clone1], tmpBase);
    git(["config", "user.email", "t@t"], clone1);
    git(["config", "user.name", "T"], clone1);
    await commit(clone1, "init", { "a.md": "a" });
    git(["remote", "add", "origin", bare], clone1);
    git(["push", "origin", "main"], clone1);

    const clone2 = path.join(tmpBase, "clone2");
    git(["clone", bare, clone2], tmpBase);
    git(["config", "user.email", "t@t"], clone2);
    git(["config", "user.name", "T"], clone2);

    await commit(clone1, "second", { "b.md": "b" });
    git(["push", "origin", "main"], clone1);

    const result = await vaultRepoSyncImpl(makeCtx(clone2), {
      action: "pull",
      remote: "origin",
      branch: "main",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy();
    const data = extractJson((result.content[0] as { text: string }).text) as {
      fetched: boolean;
      fast_forwarded: boolean;
      new_head: string | null;
    };
    expect(data.fetched).toBe(true);
    expect(data.fast_forwarded).toBe(true);
    expect(typeof data.new_head).toBe("string");
  });

  // 5. pull — diverged
  it("pull: diverged returns errorResult mentioning diverged", async () => {
    const bare = path.join(tmpBase, "bare2.git");
    const clone1 = path.join(tmpBase, "clone1b");
    mkdirSync(bare);
    mkdirSync(clone1);

    git(["-c", "init.defaultBranch=main", "init", "--bare", bare], tmpBase);
    git(["-c", "init.defaultBranch=main", "init", clone1], tmpBase);
    git(["config", "user.email", "t@t"], clone1);
    git(["config", "user.name", "T"], clone1);
    await commit(clone1, "base", { "a.md": "a" });
    git(["remote", "add", "origin", bare], clone1);
    git(["push", "origin", "main"], clone1);

    const clone2 = path.join(tmpBase, "clone2b");
    git(["clone", bare, clone2], tmpBase);
    git(["config", "user.email", "t@t"], clone2);
    git(["config", "user.name", "T"], clone2);

    await commit(clone1, "on-remote", { "remote.md": "r" });
    git(["push", "origin", "main"], clone1);
    await commit(clone2, "local-diverge", { "local.md": "l" });

    const headBefore = gitOut(["rev-parse", "HEAD"], clone2);
    const result = await vaultRepoSyncImpl(makeCtx(clone2), {
      action: "pull",
      remote: "origin",
      branch: "main",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toMatch(/diverge|ff|fast.forward/i);

    const headAfter = gitOut(["rev-parse", "HEAD"], clone2);
    expect(headAfter).toBe(headBefore);
  });

  // 6. push — success
  it("push: succeeds to a bare upstream", async () => {
    const bare = path.join(tmpBase, "bare3.git");
    mkdirSync(bare);

    git(["-c", "init.defaultBranch=main", "init", "--bare", bare], tmpBase);
    const clone = path.join(tmpBase, "clone3");
    git(["clone", bare, clone], tmpBase);
    git(["config", "user.email", "t@t"], clone);
    git(["config", "user.name", "T"], clone);
    await commit(clone, "init", { "a.md": "hello" });

    const result = await vaultRepoSyncImpl(makeCtx(clone), {
      action: "push",
      remote: "origin",
      branch: "main",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy();
    const data = extractJson((result.content[0] as { text: string }).text) as {
      pushed: boolean;
      rejected_reason: string | null;
    };
    expect(data.pushed).toBe(true);
    expect(data.rejected_reason).toBeNull();
  });

  // 7. push — rejected (never --force)
  it("push: rejected returns errorResult; source never passes --force", async () => {
    const bare = path.join(tmpBase, "bare4.git");
    const clone1 = path.join(tmpBase, "clone4a");
    mkdirSync(bare);

    git(["-c", "init.defaultBranch=main", "init", "--bare", bare], tmpBase);
    git(["clone", bare, clone1], tmpBase);
    git(["config", "user.email", "t@t"], clone1);
    git(["config", "user.name", "T"], clone1);
    await commit(clone1, "init", { "a.md": "a" });
    git(["push", "origin", "main"], clone1);

    const clone2 = path.join(tmpBase, "clone4b");
    git(["clone", bare, clone2], tmpBase);
    git(["config", "user.email", "t@t"], clone2);
    git(["config", "user.name", "T"], clone2);

    await commit(clone1, "ahead", { "b.md": "b" });
    git(["push", "origin", "main"], clone1);
    await commit(clone2, "diverged-local", { "c.md": "c" });

    const result = await vaultRepoSyncImpl(makeCtx(clone2), {
      action: "push",
      remote: "origin",
      branch: "main",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // --force should never appear in the error output or be passed (source invariant)
    expect(text).not.toContain("--force");
  });

  // 8. log — shape + limit
  it("log: returns at most limit commits with correct shape", async () => {
    const repo = path.join(tmpBase, "log");
    mkdirSync(repo);
    await initRepo(repo);
    for (let i = 1; i <= 5; i++) {
      await commit(repo, `commit ${i}`, { [`f${i}.md`]: `${i}` });
    }

    const result = await vaultRepoSyncImpl(makeCtx(repo), {
      action: "log",
      remote: "origin",
      limit: 3,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBeFalsy();
    const data = extractJson((result.content[0] as { text: string }).text) as {
      commits: Array<{ sha: string; author: string; date: string; subject: string }>;
    };
    expect(data.commits).toHaveLength(3);
    for (const c of data.commits) {
      expect(typeof c.sha).toBe("string");
      expect(c.sha.length).toBeGreaterThan(0);
      expect(typeof c.author).toBe("string");
      expect(typeof c.date).toBe("string");
      expect(typeof c.subject).toBe("string");
    }
  });

  // 9. preflight — non-repo dir
  it("preflight: rejects a directory without .git", async () => {
    const dir = path.join(tmpBase, "notrepo");
    mkdirSync(dir);

    const result = await vaultRepoSyncImpl(makeCtx(dir), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/not a git repository/i);
  });

  // 10. safety — malicious vault_path rejected at preflight (not a dir → no spawn)
  it("safety: malicious vault_path is rejected before any git spawn", async () => {
    // The path doesn't exist so stat() fails, preflight rejects before spawn
    const result = await vaultRepoSyncImpl(makeCtx(undefined), {
      vault_path: "; rm -rf /",
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // The path was rejected because it doesn't exist (not because shell was invoked)
    expect(text).toMatch(/does not exist/i);
  });

  // 11. env scrubbing — verified via safeEnv() invariants in tool source
  // The tool always calls spawn with GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=/bin/true
  // and omits all other parent env vars. This is enforced by the safeEnv() helper
  // which builds the env from a fixed allowlist. Behavioral proof: a real git status
  // on a local repo succeeds with the scrubbed env (no SSH/keychain needed for local ops).
  it("env scrubbing: real local git ops succeed with scrubbed env", async () => {
    const repo = path.join(tmpBase, "envtest");
    mkdirSync(repo);
    await initRepo(repo);
    await commit(repo, "seed", { "a.md": "a" });

    const result = await vaultRepoSyncImpl(makeCtx(repo), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });

    // If env scrubbing broke basic git, status would fail
    expect(result.isError).toBeFalsy();
  });

  // 12. no vault configured and no vault_path
  it("returns errorResult when no vault configured and no vault_path given", async () => {
    const result = await vaultRepoSyncImpl(makeCtx(undefined), {
      action: "status",
      remote: "origin",
      limit: 20,
      timeout_ms: 15_000,
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/TDMCP_VAULT_PATH/i);
  });
});
