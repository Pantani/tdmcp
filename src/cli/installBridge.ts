import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeModulesDir } from "../utils/paths.js";

const DEFAULT_BRIDGE_PORT = 9980;
const DEFAULT_PALETTE_PACKAGE_NAME = "tdmcp_bridge_package";
const PALETTE_PACKAGE_NAME_MESSAGE = "Expected a single filename segment.";
const VERIFY_ATTEMPT_TIMEOUT_MS = 2000;
const WAIT_TIMEOUT_MS = 10000;
const WAIT_INTERVAL_MS = 200;
const INSTALL_BRIDGE_FLAGS_WITH_VALUE = new Set([
  "--dir",
  "--port",
  "--token",
  "--palette-dir",
  "--package-name",
]);
const INSTALL_BRIDGE_FLAGS = new Set([
  ...INSTALL_BRIDGE_FLAGS_WITH_VALUE,
  "--verify",
  "--wait",
  "--palette",
  "--help",
  "-h",
]);

interface InstallBridgeOptions {
  targetRoot: string;
  verify: boolean;
  wait: boolean;
  port: number;
  token?: string;
  verifyToken?: string;
  palette: boolean;
  paletteDir?: string;
  packageName: string;
}

export interface InstallBridgeResult {
  ok: boolean;
  detail: string;
  port?: number;
  modulesDir?: string;
  textportCommand?: string;
  noPrefsTextportCommand?: string;
  verified?: boolean;
  token?: string;
  paletteDir?: string;
  palettePackageName?: string;
  palettePackageTextportCommand?: string;
}

interface BridgeInfo {
  tdVersion?: string;
  bridgeVersion?: string;
}

interface TextportCommands {
  textportCommand: string;
  noPrefsTextportCommand: string;
}

interface InstallBridgeFlagValues {
  explicitDir?: string;
  explicitToken?: string;
  port: number;
  paletteDirFlag: number;
  explicitPaletteDir?: string;
  packageNameFlag: number;
  explicitPackageName?: string;
}

/**
 * `tdmcp install-bridge [--dir <path>] [--verify] [--wait] [--port <port>] [--palette]`
 *
 * Copies the packaged TouchDesigner bridge modules (`td/modules`) to a friendly,
 * stable folder on disk and prints the two things the artist needs to turn the
 * bridge on inside TouchDesigner. This is what makes the `npx` flow work without
 * cloning the repo: the modules live in the npm cache otherwise.
 */
export function runInstallBridge(
  args: string[],
): Promise<InstallBridgeResult> | InstallBridgeResult {
  if (hasStandaloneHelpFlag(args)) {
    console.log(installBridgeHelp());
    return { ok: true, detail: "install-bridge help" };
  }

  const options = parseInstallBridgeArgs(args);
  if (!options) {
    return { ok: false, detail: "invalid install-bridge arguments" };
  }

  const dest = join(options.targetRoot, "modules");

  const src = bridgeModulesDir();
  const commands = buildTextportCommands(options.port, dest);
  const palettePackageTextportCommand = options.palette
    ? buildPalettePackageTextportCommand(options, dest)
    : undefined;
  if (!existsSync(src)) {
    console.error(
      `[tdmcp] Could not find the bridge modules to copy (looked in ${src}).\n` +
        "If you're running from source, build first with `npm run build`.",
    );
    process.exitCode = 1;
    return {
      ok: false,
      detail: `bridge modules not found at ${src}`,
      port: options.port,
      modulesDir: dest,
      ...commands,
      ...palettePackageResultFields(options, palettePackageTextportCommand),
    };
  }

  cpSync(src, dest, { recursive: true });

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
      `       ${commands.textportCommand}`,
      "",
      `  You should see: [tdmcp] bridge running on port ${options.port} (/project1/tdmcp_bridge)`,
      "",
      "  Security: the Web Server DAT listens on all network interfaces. By default,",
      "  arbitrary Python endpoints stay disabled unless you set",
      "  TDMCP_BRIDGE_ALLOW_EXEC=1 inside TouchDesigner. A token authenticates",
      "  callers but does not enable exec; on untrusted networks, set the shared",
      `  TDMCP_BRIDGE_TOKEN too and firewall port ${options.port} to localhost.`,
      "",
      "  Prefer not to touch Preferences? Paste this in the Textport instead:",
      "",
      ...commands.noPrefsTextportCommand.split("\n").map((line) => `       ${line}`),
      "",
      ...palettePackageConsoleLines(options, palettePackageTextportCommand),
    ].join("\n"),
  );

  if (options.token) {
    console.log(
      [
        "  Auth: a shared bridge token was provided. Set the SAME value in TouchDesigner's",
        "  environment BEFORE running the Textport command so the bridge enforces auth:",
        "",
        `    os.environ['TDMCP_BRIDGE_TOKEN'] = ${JSON.stringify(options.token)}`,
        "",
      ].join("\n"),
    );
  }

  const baseResult: InstallBridgeResult = {
    ok: true,
    detail: `bridge modules copied to ${dest}`,
    port: options.port,
    modulesDir: dest,
    ...commands,
    ...(options.token ? { token: options.token } : {}),
    ...palettePackageResultFields(options, palettePackageTextportCommand),
  };
  if (options.verify || options.wait) {
    return verifyInstalledBridge(options, baseResult);
  }
  return baseResult;
}

function hasStandaloneHelpFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return true;
    if (INSTALL_BRIDGE_FLAGS_WITH_VALUE.has(arg)) i++;
  }
  return false;
}

function installBridgeHelp(): string {
  return [
    "tdmcp install-bridge",
    "",
    "Usage:",
    "  tdmcp install-bridge [--dir <path>] [--verify] [--wait] [--port <port>] [--token <token>]",
    "  tdmcp install-bridge --palette [--palette-dir <path>] [--package-name <name>]",
    "",
    "Options:",
    "  --dir <path>           Copy bridge modules under this root. Defaults to ~/tdmcp-bridge.",
    "  --verify               Probe /api/info once after copying.",
    "  --wait                 Poll /api/info until the bridge responds or times out.",
    "  --port <port>          TouchDesigner bridge port. Defaults to 9980.",
    "  --token <token>        Print the matching TDMCP_BRIDGE_TOKEN setup snippet.",
    "  --palette              Also print a Palette package export command.",
    "  --palette-dir <path>   Palette export directory. Implies --palette.",
    "  --package-name <name>  Palette package component name. Implies --palette.",
    "  -h, --help             Show this help without copying files.",
  ].join("\n");
}

function parseInstallBridgeArgs(args: string[]): InstallBridgeOptions | undefined {
  const values = readInstallBridgeFlagValues(args);
  if (!values || hasUnknownInstallBridgeArg(args)) return undefined;

  return {
    targetRoot: values.explicitDir ?? join(homedir(), "tdmcp-bridge"),
    verify: args.includes("--verify"),
    wait: args.includes("--wait"),
    port: values.port,
    token: values.explicitToken,
    verifyToken: values.explicitToken ?? process.env.TDMCP_BRIDGE_TOKEN,
    palette:
      args.includes("--palette") || values.paletteDirFlag !== -1 || values.packageNameFlag !== -1,
    paletteDir: values.explicitPaletteDir,
    packageName: values.explicitPackageName ?? DEFAULT_PALETTE_PACKAGE_NAME,
  };
}

function readInstallBridgeFlagValues(args: string[]): InstallBridgeFlagValues | undefined {
  const base = readInstallBridgeBaseValues(args);
  if (!base) return undefined;
  const port = readInstallBridgePortValue(args);
  if (port === undefined) return undefined;
  const palette = readInstallBridgePaletteValues(args);
  if (!palette) return undefined;

  return { ...base, port, ...palette };
}

function readInstallBridgeBaseValues(
  args: string[],
): Pick<InstallBridgeFlagValues, "explicitDir" | "explicitToken"> | undefined {
  const dirFlag = args.indexOf("--dir");
  const explicitDir = dirFlag !== -1 ? args[dirFlag + 1] : undefined;
  if (missingInstallBridgeValue("--dir", dirFlag, explicitDir, true)) return undefined;

  const tokenFlag = args.indexOf("--token");
  const explicitToken = tokenFlag !== -1 ? args[tokenFlag + 1] : undefined;
  // Tokens generated via randomBytes(...).toString("base64url") can legitimately begin
  // with "-", so do NOT reject them as a missing-value flag. Only reject undefined / "".
  if (missingInstallBridgeValue("--token", tokenFlag, explicitToken, false)) return undefined;

  return { explicitDir, explicitToken };
}

function readInstallBridgePortValue(args: string[]): number | undefined {
  const portFlag = args.indexOf("--port");
  const explicitPort = portFlag !== -1 ? args[portFlag + 1] : undefined;
  if (missingInstallBridgeValue("--port", portFlag, explicitPort, true)) return undefined;
  return parseInstallBridgePort(explicitPort);
}

function readInstallBridgePaletteValues(
  args: string[],
):
  | Pick<
      InstallBridgeFlagValues,
      "paletteDirFlag" | "explicitPaletteDir" | "packageNameFlag" | "explicitPackageName"
    >
  | undefined {
  const paletteDirFlag = args.indexOf("--palette-dir");
  const explicitPaletteDir = paletteDirFlag !== -1 ? args[paletteDirFlag + 1] : undefined;
  if (missingInstallBridgeValue("--palette-dir", paletteDirFlag, explicitPaletteDir, true)) {
    return undefined;
  }

  const packageNameFlag = args.indexOf("--package-name");
  const explicitPackageName = packageNameFlag !== -1 ? args[packageNameFlag + 1] : undefined;
  if (missingInstallBridgeValue("--package-name", packageNameFlag, explicitPackageName, true)) {
    return undefined;
  }
  if (explicitPackageName !== undefined && !isSafePalettePackageName(explicitPackageName)) {
    console.error(
      `[tdmcp] Invalid install-bridge --package-name value. ${PALETTE_PACKAGE_NAME_MESSAGE}`,
    );
    process.exitCode = 2;
    return undefined;
  }

  return {
    paletteDirFlag,
    explicitPaletteDir,
    packageNameFlag,
    explicitPackageName,
  };
}

function missingInstallBridgeValue(
  flag: string,
  flagIndex: number,
  value: string | undefined,
  rejectLeadingDash: boolean,
): boolean {
  if (
    flagIndex === -1 ||
    (value !== undefined && value !== "" && !(rejectLeadingDash && value.startsWith("-")))
  ) {
    return false;
  }
  console.error(`[tdmcp] Missing install-bridge ${flag} value.`);
  process.exitCode = 2;
  return true;
}

function parseInstallBridgePort(value: string | undefined): number | undefined {
  const port = value === undefined ? DEFAULT_BRIDGE_PORT : Number(value);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  console.error(`[tdmcp] Invalid install-bridge --port value "${value ?? ""}". Expected 1-65535.`);
  process.exitCode = 2;
  return undefined;
}

function hasUnknownInstallBridgeArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || INSTALL_BRIDGE_FLAGS.has(arg)) {
      if (arg !== undefined && INSTALL_BRIDGE_FLAGS_WITH_VALUE.has(arg)) i += 1;
      continue;
    }
    console.error(`[tdmcp] Unknown install-bridge option or argument "${arg}".`);
    process.exitCode = 2;
    return true;
  }
  return false;
}

function isSafePalettePackageName(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/.test(value)
  );
}

function buildTextportCommands(port: number, modulesDir: string): TextportCommands {
  return {
    textportCommand: `from mcp import install; ${installRunCall(port)}`,
    noPrefsTextportCommand:
      `import sys; sys.path.insert(0, ${JSON.stringify(modulesDir)})\n` +
      `from mcp import install; ${installRunCall(port, modulesDir)}`,
  };
}

function installRunCall(port: number, modulesDir?: string): string {
  const args: string[] = [];
  if (modulesDir) args.push(`modules_dir=${JSON.stringify(modulesDir)}`);
  if (port !== DEFAULT_BRIDGE_PORT) args.push(`port=${port}`);
  return `install.run(${args.join(", ")})`;
}

function buildPalettePackageTextportCommand(
  options: InstallBridgeOptions,
  modulesDir: string,
): string {
  return [
    `import sys; sys.path.insert(0, ${JSON.stringify(modulesDir)})`,
    "from mcp import install",
    exportPalettePackageCall(options, modulesDir),
  ].join("\n");
}

function exportPalettePackageCall(options: InstallBridgeOptions, modulesDir: string): string {
  const args = [
    `modules_dir=${JSON.stringify(modulesDir)}`,
    `package_name=${JSON.stringify(options.packageName)}`,
  ];
  if (options.paletteDir) args.push(`palette_dir=${JSON.stringify(options.paletteDir)}`);
  args.push(`port=${options.port}`);
  return `install.export_palette_package(${args.join(", ")})`;
}

function palettePackageConsoleLines(
  options: InstallBridgeOptions,
  textportCommand: string | undefined,
): string[] {
  if (!options.palette || !textportCommand) return [];
  return [
    "  Palette package export:",
    "",
    "  Exporting the .tox requires a running TouchDesigner session. Paste this",
    "  in the Textport after the modules are staged:",
    "",
    ...textportCommand.split("\n").map((line) => `       ${line}`),
    "",
    "  The command calls mcp.install.export_palette_package(...) and writes the",
    "  package into TouchDesigner's user Palette folder unless --palette-dir is set.",
    "",
  ];
}

function palettePackageResultFields(
  options: InstallBridgeOptions,
  textportCommand: string | undefined,
): Pick<
  InstallBridgeResult,
  "paletteDir" | "palettePackageName" | "palettePackageTextportCommand"
> {
  if (!options.palette || !textportCommand) return {};
  return {
    ...(options.paletteDir ? { paletteDir: options.paletteDir } : {}),
    palettePackageName: options.packageName,
    palettePackageTextportCommand: textportCommand,
  };
}

async function verifyInstalledBridge(
  options: InstallBridgeOptions,
  baseResult: InstallBridgeResult,
): Promise<InstallBridgeResult> {
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
      const info = await fetchBridgeInfo(url, options.verifyToken);
      console.log(`  Bridge verified at ${url}${formatBridgeInfo(info)}.`);
      return {
        ...baseResult,
        ok: true,
        detail: `bridge verified at ${url}${formatBridgeInfo(info)}`,
        verified: true,
      };
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
  return {
    ...baseResult,
    ok: false,
    detail: `could not verify bridge at ${url}: ${errorMessage(lastError)}`,
    verified: false,
  };
}

function bridgeInfoUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/info`;
}

async function fetchBridgeInfo(url: string, token?: string): Promise<BridgeInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_ATTEMPT_TIMEOUT_MS);
  try {
    // Forward the bearer token when present so verify works once TD enforces
    // TDMCP_BRIDGE_TOKEN; without it `/api/info` returns 401 and the verify step lies.
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(url, { method: "GET", signal: controller.signal, headers });
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
