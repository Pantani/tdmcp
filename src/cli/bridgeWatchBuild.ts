import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildToolContext } from "../server/context.js";
import { reloadBridgeImpl } from "../tools/layer3/reloadBridge.js";
import { loadConfig } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";

/**
 * `tdmcp watch` — dev-loop CLI that watches src/ and td/ and runs
 * tsc --noEmit + tsup on debounced file changes. Exits only on SIGINT (0),
 * validation error (2), or unrecoverable watcher error (1).
 */

export const bridgeWatchBuildSchema = z.object({
  paths: z.array(z.string()).nonempty().default(["src", "td"]),
  debounceMs: z.number().int().min(0).max(5000).default(300),
  runOn: z.enum(["typecheck", "build", "both"]).default("both"),
  ignore: z
    .array(z.string())
    .optional()
    .default([
      "**/node_modules/**",
      "**/dist/**",
      "**/__pycache__/**",
      "**/*.pyc",
      "**/.claude/**",
    ]),
  clearScreen: z.boolean().default(true),
  once: z.boolean().default(false),
  pyCompile: z.boolean().default(true),
  reloadBridge: z.boolean().default(true),
});

export type BridgeWatchBuildArgs = z.infer<typeof bridgeWatchBuildSchema>;

export interface BridgeWatchBuildDeps {
  /** Test hook / custom bridge hook. Defaults to the real `reload_bridge` tool. */
  reloadBridge?: () => Promise<Pick<CallToolResult, "content" | "isError">>;
  /** Python binary used for `python -m py_compile`; defaults to PYTHON or python3. */
  pythonBin?: string;
}

// ---- binary resolution ----

function resolveBin(pkg: string, bin: string): string {
  try {
    const req = createRequire(import.meta.url);
    // e.g. "typescript/bin/tsc" → absolute path in node_modules
    return req.resolve(`${pkg}/bin/${bin}`);
  } catch {
    // fallback: hope it's on PATH via node_modules/.bin
    return bin;
  }
}

// ---- spawn helper ----

import { type ChildProcess, spawn } from "node:child_process";

async function spawnAsync(
  cmd: string,
  args: string[],
  _label: string,
): Promise<{ code: number; ms: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, ms: Date.now() - start });
    });
  });
}

// ---- runner pipeline ----

interface RunResult {
  code: number;
  totalMs: number;
}

function normalizeWatchPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isTdPath(path: string): boolean {
  const normalized = normalizeWatchPath(path);
  return (
    normalized === "td" ||
    normalized.startsWith("td/") ||
    normalized.endsWith("/td") ||
    normalized.includes("/td/")
  );
}

function changedPythonFiles(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeWatchPath(path);
    if (normalized.endsWith(".py") && existsSync(path)) out.add(path);
  }
  return [...out].sort();
}

function resultText(result: Pick<CallToolResult, "content" | "isError">): string {
  return (result.content ?? [])
    .map((item) => (item.type === "text" ? item.text : undefined))
    .filter((text): text is string => Boolean(text))
    .join(" ")
    .trim();
}

async function defaultReloadBridge(): Promise<Pick<CallToolResult, "content" | "isError">> {
  const ctx = buildToolContext(loadConfig(process.env, { useFiles: true }), {
    logger: silentLogger,
  });
  return reloadBridgeImpl(ctx);
}

async function runPyCompile(
  files: readonly string[],
  deps: BridgeWatchBuildDeps,
): Promise<{ code: number; ms: number; skipped: boolean }> {
  if (files.length === 0) return { code: 0, ms: 0, skipped: true };
  const pythonBin = deps.pythonBin ?? process.env.PYTHON ?? "python3";
  const res = await spawnAsync(pythonBin, ["-m", "py_compile", ...files], "py_compile");
  return { ...res, skipped: false };
}

async function runBridgeReload(
  deps: BridgeWatchBuildDeps,
): Promise<{ code: number; ms: number; detail: string }> {
  const start = Date.now();
  try {
    const result = await (deps.reloadBridge ?? defaultReloadBridge)();
    const detail = resultText(result);
    return {
      code: result.isError ? 1 : 0,
      ms: Date.now() - start,
      detail: detail || (result.isError ? "reload_bridge returned an error" : "reload_bridge ok"),
    };
  } catch (err) {
    return { code: 1, ms: Date.now() - start, detail: String(err) };
  }
}

async function runPipeline(
  args: BridgeWatchBuildArgs,
  tscBin: string,
  tsupBin: string,
  options: { changedPaths?: string[]; deps?: BridgeWatchBuildDeps } = {},
): Promise<RunResult> {
  const pipeStart = Date.now();
  const deps = options.deps ?? {};
  const changedPaths = options.changedPaths ?? [];
  const tdChanged = changedPaths.some(isTdPath);

  if (args.clearScreen) {
    process.stdout.write("\x1Bc");
  }

  let code = 0;

  if (args.runOn === "typecheck" || args.runOn === "both") {
    const res = await spawnAsync(process.execPath, [tscBin, "--noEmit"], "typecheck");
    const icon = res.code === 0 ? "✔" : "✖";
    process.stdout.write(`  ${icon} typecheck (${res.ms} ms)\n`);
    if (res.code !== 0) {
      code = res.code;
      return { code, totalMs: Date.now() - pipeStart };
    }
  }

  if (args.runOn === "build" || args.runOn === "both") {
    const res = await spawnAsync(process.execPath, [tsupBin], "build");
    const icon = res.code === 0 ? "✔" : "✖";
    const detail = res.code === 0 ? "" : ` (failed, exit ${res.code})`;
    process.stdout.write(`  ${icon} build     (${res.ms} ms${detail})\n`);
    if (res.code !== 0) code = res.code;
  }

  if (code === 0 && tdChanged && args.pyCompile) {
    const files = changedPythonFiles(changedPaths);
    const res = await runPyCompile(files, deps);
    if (res.skipped) {
      process.stdout.write("  ✔ py_compile (no changed .py files)\n");
    } else {
      const icon = res.code === 0 ? "✔" : "✖";
      const detail = res.code === 0 ? "" : ` (failed, exit ${res.code})`;
      process.stdout.write(`  ${icon} py_compile (${res.ms} ms${detail})\n`);
    }
    if (res.code !== 0) {
      code = res.code;
      return { code, totalMs: Date.now() - pipeStart };
    }
  }

  if (code === 0 && tdChanged && args.reloadBridge) {
    const res = await runBridgeReload(deps);
    const icon = res.code === 0 ? "✔" : "✖";
    const detail = res.code === 0 ? "" : ` (failed: ${res.detail})`;
    process.stdout.write(`  ${icon} reload_bridge (${res.ms} ms${detail})\n`);
    if (res.code !== 0) code = res.code;
  }

  return { code, totalMs: Date.now() - pipeStart };
}

// ---- arg parsing ----

function parseCliArgs(argv: string[]): BridgeWatchBuildArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      paths: { type: "string", multiple: true },
      "debounce-ms": { type: "string" },
      "run-on": { type: "string" },
      ignore: { type: "string", multiple: true },
      "no-clear": { type: "boolean" },
      "no-py-compile": { type: "boolean" },
      "no-reload-bridge": { type: "boolean" },
      once: { type: "boolean" },
    },
    strict: false,
  });

  const raw: Record<string, unknown> = {};
  if (values.paths !== undefined) raw.paths = values.paths;
  if (values["debounce-ms"] !== undefined) raw.debounceMs = Number(values["debounce-ms"]);
  if (values["run-on"] !== undefined) raw.runOn = values["run-on"];
  if (values.ignore !== undefined) raw.ignore = values.ignore;
  if (values["no-clear"] !== undefined) raw.clearScreen = !values["no-clear"];
  if (values["no-py-compile"] !== undefined) raw.pyCompile = !values["no-py-compile"];
  if (values["no-reload-bridge"] !== undefined) raw.reloadBridge = !values["no-reload-bridge"];
  if (values.once !== undefined) raw.once = values.once;

  return bridgeWatchBuildSchema.parse(raw);
}

// ---- main export ----

export async function runBridgeWatchBuild(
  argv: string[],
  deps: BridgeWatchBuildDeps = {},
): Promise<number> {
  let args: BridgeWatchBuildArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`[watch] invalid arguments: ${String(err)}\n`);
    return 2;
  }

  const tscBin = resolveBin("typescript", "tsc");
  const tsupBin = resolveBin("tsup", "tsup");

  const sep = "─".repeat(70);

  // ---- once mode ----
  if (args.once) {
    const result = await runPipeline(args, tscBin, tsupBin, { deps });
    return result.code;
  }

  // ---- watch mode ----
  let chokidar: typeof import("chokidar");
  try {
    // Dynamic import — chokidar is a devDependency; fail gracefully if absent.
    chokidar = await import("chokidar");
  } catch {
    process.stderr.write(
      "[watch] chokidar not found. Run `npm install` to install dev dependencies.\n",
    );
    return 1;
  }

  process.stdout.write(
    `[watch] tdmcp dev loop · paths: ${args.paths.join(", ")} · debounce ${args.debounceMs}ms · runOn=${args.runOn} · tdReload=${args.reloadBridge ? "on" : "off"}\n`,
  );

  const watcher = chokidar.watch(args.paths, {
    ignored: args.ignore,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Builds are serial: debounce coalesces rapid changes into a single run, and
  // the run runs to completion before the next is allowed to fire.
  const pendingPaths = new Set<string>();

  let resolveMain: (code: number) => void;
  const mainPromise = new Promise<number>((res) => {
    resolveMain = res;
  });

  const fire = (changedPath: string) => {
    pendingPaths.add(changedPath);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const count = pendingPaths.size;
      const changedPaths = [...pendingPaths];
      const first = changedPaths[0] ?? "";
      const extra = count > 1 ? ` (+${count - 1} more)` : "";
      pendingPaths.clear();

      process.stdout.write(`\n${sep}\n`);
      process.stdout.write(`[watch] ${count} change(s): ${first}${extra} → ${args.runOn}\n`);

      const result = await runPipeline(args, tscBin, tsupBin, { changedPaths, deps });
      const status = result.code === 0 ? "PASS" : "FAIL";
      const ts = new Date().toLocaleTimeString("en-GB");
      process.stdout.write(
        `[watch] ${status} · total ${(result.totalMs / 1000).toFixed(2)}s · ${ts}\n`,
      );
      process.stdout.write(`${sep}\n`);
    }, args.debounceMs);
  };

  watcher.on("add", fire);
  watcher.on("change", fire);
  watcher.on("unlink", fire);
  watcher.on("error", (err) => {
    process.stderr.write(`[watch] watcher error: ${String(err)}\n`);
    void watcher.close();
    resolveMain(1);
  });
  watcher.on("ready", () => {
    process.stdout.write("[watch] ready — watching for changes (Ctrl-C to stop)\n");
  });

  const onSigint = () => {
    void watcher.close().then(() => resolveMain(0));
  };
  process.once("SIGINT", onSigint);

  return mainPromise;
}
