import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeModulesDir } from "../utils/paths.js";

const DEFAULT_BRIDGE_PORT = 9980;
const VERIFY_ATTEMPT_TIMEOUT_MS = 2000;
const WAIT_TIMEOUT_MS = 10000;
const WAIT_INTERVAL_MS = 200;

interface InstallBridgeOptions {
  targetRoot: string;
  verify: boolean;
  wait: boolean;
  port: number;
}

interface BridgeInfo {
  tdVersion?: string;
  bridgeVersion?: string;
}

/**
 * `tdmcp install-bridge [--dir <path>] [--verify] [--wait] [--port <port>]`
 *
 * Copies the packaged TouchDesigner bridge modules (`td/modules`) to a friendly,
 * stable folder on disk and prints the two things the artist needs to turn the
 * bridge on inside TouchDesigner. This is what makes the `npx` flow work without
 * cloning the repo: the modules live in the npm cache otherwise.
 */
export function runInstallBridge(args: string[]): Promise<void> | void {
  const options = parseInstallBridgeArgs(args);
  if (!options) return;

  const dest = join(options.targetRoot, "modules");

  const src = bridgeModulesDir();
  if (!existsSync(src)) {
    console.error(
      `[tdmcp] Could not find the bridge modules to copy (looked in ${src}).\n` +
        "If you're running from source, build first with `npm run build`.",
    );
    process.exitCode = 1;
    return;
  }

  cpSync(src, dest, { recursive: true });

  const oneLiner = `from mcp import install; ${installRunCall(options.port)}`;
  const noPrefs = `import sys; sys.path.insert(0, ${JSON.stringify(dest)})\n${installRunCall(
    options.port,
    dest,
  )}`;

  console.log(
    [
      "",
      "  tdmcp bridge installed.",
      `  Modules copied to:  ${dest}`,
      "",
      "  Now switch the bridge on inside TouchDesigner:",
      "",
      "  1. Open Preferences (Edit > Preferences, or the TouchDesigner menu on macOS).",
      '     In "Python 64-bit Module Path", add this folder:',
      "",
      `       ${dest}`,
      "",
      "  2. Open the Textport (Dialogs > Textport and DATs) and run:",
      "",
      `       ${oneLiner}`,
      "",
      `  You should see: [tdmcp] bridge running on port ${options.port} (/project1/tdmcp_bridge)`,
      "",
      "  ⚠ Security: the bridge runs arbitrary Python inside TouchDesigner and the",
      "    Web Server DAT listens on all network interfaces with no auth. Only run it",
      `    on a trusted network, or firewall port ${options.port} to localhost.`,
      "",
      "  Prefer not to touch Preferences? Paste this in the Textport instead:",
      "",
      ...noPrefs.split("\n").map((line) => `       ${line}`),
      "",
    ].join("\n"),
  );

  if (options.verify || options.wait) {
    return verifyInstalledBridge(options);
  }
}

function parseInstallBridgeArgs(args: string[]): InstallBridgeOptions | undefined {
  const dirFlag = args.indexOf("--dir");
  const explicitDir = dirFlag !== -1 ? args[dirFlag + 1] : undefined;
  if (dirFlag !== -1 && (!explicitDir || explicitDir.startsWith("-"))) {
    console.error("[tdmcp] Missing install-bridge --dir value.");
    process.exitCode = 2;
    return undefined;
  }

  const portFlag = args.indexOf("--port");
  const explicitPort = portFlag !== -1 ? args[portFlag + 1] : undefined;
  if (portFlag !== -1 && (!explicitPort || explicitPort.startsWith("-"))) {
    console.error("[tdmcp] Missing install-bridge --port value.");
    process.exitCode = 2;
    return undefined;
  }
  const port = explicitPort === undefined ? DEFAULT_BRIDGE_PORT : Number(explicitPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `[tdmcp] Invalid install-bridge --port value "${explicitPort ?? ""}". Expected 1-65535.`,
    );
    process.exitCode = 2;
    return undefined;
  }

  return {
    targetRoot: explicitDir ?? join(homedir(), "tdmcp-bridge"),
    verify: args.includes("--verify"),
    wait: args.includes("--wait"),
    port,
  };
}

function installRunCall(port: number, modulesDir?: string): string {
  const args: string[] = [];
  if (modulesDir) args.push(`modules_dir=${JSON.stringify(modulesDir)}`);
  if (port !== DEFAULT_BRIDGE_PORT) args.push(`port=${port}`);
  return `install.run(${args.join(", ")})`;
}

async function verifyInstalledBridge(options: InstallBridgeOptions): Promise<void> {
  const url = bridgeInfoUrl(options.port);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError: unknown;

  console.log(
    options.wait
      ? `\n  Waiting for TouchDesigner bridge at ${url} ...`
      : `\n  Checking TouchDesigner bridge at ${url} ...`,
  );

  do {
    try {
      const info = await fetchBridgeInfo(url);
      console.log(`  Bridge verified at ${url}${formatBridgeInfo(info)}.`);
      return;
    } catch (err) {
      lastError = err;
      if (!options.wait) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(WAIT_INTERVAL_MS, remainingMs));
    }
  } while (Date.now() < deadline);

  console.error(
    [
      `[tdmcp] Could not verify the TouchDesigner bridge at ${url}.`,
      options.wait
        ? `[tdmcp] Timed out after ${WAIT_TIMEOUT_MS}ms waiting for /api/info to respond OK.`
        : "[tdmcp] Start TouchDesigner, run the Textport one-liner above, then retry with `tdmcp install-bridge --verify`.",
      `[tdmcp] Last error: ${errorMessage(lastError)}`,
    ].join("\n"),
  );
  process.exitCode = 1;
}

function bridgeInfoUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/info`;
}

async function fetchBridgeInfo(url: string): Promise<BridgeInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status || "network error"}`);
    }

    const json = await response.json();
    if (!isRecord(json) || json.ok !== true) {
      throw new Error(extractBridgeError(json) ?? "Bridge response did not report ok: true.");
    }

    const data = json.data;
    if (!isRecord(data)) return {};
    return {
      tdVersion: stringField(data, "td_version"),
      bridgeVersion: stringField(data, "bridge_version"),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`request timed out after ${VERIFY_ATTEMPT_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function formatBridgeInfo(info: BridgeInfo): string {
  const parts = [];
  if (info.tdVersion) parts.push(`TouchDesigner ${info.tdVersion}`);
  if (info.bridgeVersion) parts.push(`bridge ${info.bridgeVersion}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function extractBridgeError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof value.message === "string") return value.message;
  return undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "unknown error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
