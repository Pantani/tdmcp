/**
 * Build the distributable, self-bootstrapping bridge package `.tox`.
 *
 *   npm run build:bridge-tox
 *
 * A `.tox` is TouchDesigner's proprietary serialization: it can only be written
 * from inside a live TD session, never in headless CI. So this is the maintainer's
 * ONE per-release step — after it, every end user installs the bridge by dragging
 * the `.tox` into a project and clicking **Install**: no Textport, no Preferences.
 *
 * The generated package is tag-pinned and self-bootstrapping — on the user's
 * machine it downloads `td/modules` from the matching release zip and starts the
 * bridge. Attach the resulting file to the GitHub Release for that tag.
 *
 * Two modes:
 *  - Bridge reachable (default): drives `install.export_package(...)` over
 *    `/api/exec`, so the maintainer never touches the Textport either. Requires
 *    ALLOW_EXEC enabled on that (trusted, local) TD.
 *  - Bridge offline: prints the exact tag-pinned Textport one-liner to paste once.
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TouchDesignerClient } from "../src/td-client/touchDesignerClient.js";
import { TdConnectionError } from "../src/td-client/types.js";
import { loadConfig, tdBaseUrl } from "../src/utils/config.js";
import { createLogger } from "../src/utils/logger.js";

const REPO_ZIP_BASE = "https://github.com/Pantani/tdmcp/archive/refs/tags";
const DEFAULT_OUT = "dist/tdmcp_bridge_package.tox";

interface BuildToxOptions {
  out: string;
  repoZip: string;
  host?: string;
  port?: number;
  token?: string;
}

/** Repo root, resolved from this script's location (scripts/ -> ..). */
function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("Could not read a version from package.json.");
  }
  return pkg.version;
}

function parseArgs(args: string[]): BuildToxOptions {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const value = args[i + 1];
    // Reject any following token that looks like a flag — including unknown ones
    // (`--out --foo`) — so a missing value never silently swallows the next flag.
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  const explicitPort = get("--port");
  const port = explicitPort === undefined ? undefined : Number(explicitPort);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid --port value "${explicitPort}". Expected 1-65535.`);
  }

  const repoZip = get("--repo-zip") ?? `${REPO_ZIP_BASE}/v${packageVersion()}.zip`;
  return {
    out: resolve(get("--out") ?? DEFAULT_OUT),
    repoZip,
    host: get("--host"),
    port,
    token: get("--token"),
  };
}

/** The `install.export_package(...)` call shared by the exec path and the fallback. */
function exportCall(options: BuildToxOptions): string {
  return (
    `install.export_package(path=${JSON.stringify(options.out)}, ` +
    `modules_dir=None, repo_zip=${JSON.stringify(options.repoZip)})`
  );
}

/**
 * The lines a maintainer pastes into the Textport when the bridge is offline.
 * Prepends this checkout's `td/modules` to `sys.path` so `import mcp` works even
 * in a clean TD session with no Preferences module path set.
 */
function textportCommand(options: BuildToxOptions): string {
  const modulesDir = join(repoRoot(), "td", "modules");
  return [
    `import sys; sys.path.insert(0, ${JSON.stringify(modulesDir)})`,
    "from mcp import install",
    exportCall(options),
  ].join("\n");
}

/** The Python `install.export_package(...)` call driven over /api/exec. */
function exportScript(options: BuildToxOptions): string {
  return ["from mcp import install", exportCall(options)].join("\n");
}

function buildClient(options: BuildToxOptions): TouchDesignerClient {
  const config = loadConfig();
  const host = options.host ?? config.tdHost;
  const port = options.port ?? config.tdPort;
  return new TouchDesignerClient({
    baseUrl: tdBaseUrl({ ...config, tdHost: host, tdPort: port }),
    timeoutMs: Math.max(config.requestTimeoutMs, 60_000),
    token: options.token ?? config.bridgeToken,
    logger: createLogger("warn"),
  });
}

function reportSuccess(options: BuildToxOptions): void {
  const bytes = statSync(options.out).size;
  const tag =
    options.repoZip
      .split("/")
      .pop()
      ?.replace(/\.zip$/, "") ?? "the release";
  console.log(
    [
      "",
      `  ✓ Bridge package exported: ${options.out} (${(bytes / 1024).toFixed(1)} KiB)`,
      `    Tag-pinned to: ${options.repoZip}`,
      "",
      "  Next: attach this .tox to the GitHub Release for that tag. End users then:",
      "    1. Download the .tox from the release.",
      "    2. Drag it from Finder/Explorer into the TouchDesigner network.",
      "    3. Click Install on the tdmcp_bridge_package COMP.",
      "  No Textport, no Preferences, no clone.",
      "",
      `  Release check: the zip URL above must resolve once ${tag} is pushed.`,
      "",
    ].join("\n"),
  );
}

function reportOffline(options: BuildToxOptions, reason: string): void {
  console.error(
    [
      "",
      `[tdmcp] Bridge not reachable (${reason}).`,
      "[tdmcp] A .tox can only be serialized from a live TouchDesigner session.",
      "",
      "  Either start TD with the bridge (ALLOW_EXEC enabled) and re-run this,",
      "  or paste these lines ONCE into the Textport (Dialogs -> Textport and DATs):",
      "",
      ...textportCommand(options)
        .split("\n")
        .map((line) => `       ${line}`),
      "",
      `  It writes the package to ${options.out}. Then attach that .tox to the release.`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = buildClient(options);
  console.log(`[build:bridge-tox] Target bridge: ${client.endpoint}`);
  console.log(`[build:bridge-tox] Exporting -> ${options.out}`);

  try {
    await client.getInfo();
  } catch (err) {
    // Only a genuine connection failure means "offline". API/timeout/back-pressure
    // errors are real bridge faults and must surface, not hide behind the fallback.
    if (err instanceof TdConnectionError) {
      reportOffline(options, err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Remove any stale artifact first so the post-export existsSync check can only
  // pass on a freshly written file, never on a leftover from an earlier run.
  rmSync(options.out, { force: true });
  await client.executePythonScript(exportScript(options), true);
  if (!existsSync(options.out)) {
    throw new Error(
      `The bridge reported no error but ${options.out} was not written. ` +
        "Confirm the TD process can write that path and that ALLOW_EXEC is enabled.",
    );
  }
  reportSuccess(options);
}

main().catch((err) => {
  console.error("[build:bridge-tox] FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
