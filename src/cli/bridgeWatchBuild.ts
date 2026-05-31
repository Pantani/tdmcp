import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { z } from "zod";

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
});

export type BridgeWatchBuildArgs = z.infer<typeof bridgeWatchBuildSchema>;

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

async function runPipeline(
  args: BridgeWatchBuildArgs,
  tscBin: string,
  tsupBin: string,
): Promise<RunResult> {
  const pipeStart = Date.now();

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
  if (values.once !== undefined) raw.once = values.once;

  return bridgeWatchBuildSchema.parse(raw);
}

// ---- main export ----

export async function runBridgeWatchBuild(argv: string[]): Promise<number> {
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
    const result = await runPipeline(args, tscBin, tsupBin);
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
    `[watch] tdmcp dev loop · paths: ${args.paths.join(", ")} · debounce ${args.debounceMs}ms · runOn=${args.runOn}\n`,
  );

  const watcher = chokidar.watch(args.paths, {
    ignored: args.ignore,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: ChildProcess | null = null;
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
      const first = [...pendingPaths][0] ?? "";
      const extra = count > 1 ? ` (+${count - 1} more)` : "";
      pendingPaths.clear();

      if (inFlight !== null) {
        inFlight.kill("SIGTERM");
        inFlight = null;
      }

      process.stdout.write(`\n${sep}\n`);
      process.stdout.write(`[watch] ${count} change(s): ${first}${extra} → ${args.runOn}\n`);

      const result = await runPipeline(args, tscBin, tsupBin);
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
    if (inFlight !== null) inFlight.kill("SIGTERM");
    void watcher.close().then(() => resolveMain(0));
  };
  process.once("SIGINT", onSigint);

  return mainPromise;
}
