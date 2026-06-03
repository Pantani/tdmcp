import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { runConfigInit } from "./configInit.js";
import { runDoctor } from "./doctor.js";
import { type InstallBridgeResult, runInstallBridge } from "./installBridge.js";
import { writeInstallClientConfig } from "./installClient.js";

const SUPPORTED_CLIENTS = ["claude", "cursor", "codex"] as const;
export type InitClient = (typeof SUPPORTED_CLIENTS)[number];

const STEP_IDS = ["detect", "token", "bridge", "config", "clients", "open", "doctor"] as const;
type StepId = (typeof STEP_IDS)[number];

const SKIPPABLE = new Set(["bridge", "clients", "config", "token", "open", "doctor"]);

export interface InitFlags {
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  noToken: boolean;
  openTd: boolean | "prompt";
  showToken: boolean;
  bridgeDir: string;
  bridgePort: number;
  token?: string;
  profile: string;
  clients: "auto" | "none" | InitClient[];
  tdPath?: string;
  skip: Set<string>;
  help: boolean;
}

export interface DetectionResult {
  os: NodeJS.Platform;
  td: { found: boolean; path?: string };
  bridge: { running: boolean; port: number };
  existingConfig: {
    exists: boolean;
    path: string;
    token?: string;
    port?: number;
    profile?: string;
  };
  clients: {
    claude: { exists: boolean; path: string };
    cursor: { exists: boolean; path: string };
    codex: { exists: boolean; path: string };
  };
}

export interface StepReport {
  id: StepId;
  status: "ok" | "skipped" | "failed" | "would";
  detail: string;
  retry?: string;
}

export interface InitResult {
  ok: boolean;
  flags: Omit<InitFlags, "token"> & { token?: string; tokenSet: boolean };
  detection?: DetectionResult;
  steps: StepReport[];
  textportCommand?: string;
}

export interface RunInitDeps {
  platform?: () => NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (p: string) => boolean;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, body: string) => Promise<void>;
  mkdir?: (p: string) => Promise<void>;
  randomToken?: () => string;
  fetchBridge?: (port: number) => Promise<boolean>;
  spawnTd?: (path: string) => void;
  copyToClipboard?: (text: string) => Promise<boolean>;
  runInstallBridge?: typeof runInstallBridge;
  writeInstallClientConfig?: typeof writeInstallClientConfig;
  runConfigInit?: typeof runConfigInit;
  runDoctor?: typeof runDoctor;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

const ERR_UNKNOWN_FLAG = 2;

function parseClientsList(raw: string): "auto" | "none" | InitClient[] | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "auto") return "auto";
  if (trimmed === "none" || trimmed === "") return "none";
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const result: InitClient[] = [];
  for (const p of parts) {
    if (!(SUPPORTED_CLIENTS as readonly string[]).includes(p)) return undefined;
    result.push(p as InitClient);
  }
  return result;
}

export function parseInitArgs(argv: string[]): InitFlags | { error: string; code: number } {
  const flags: InitFlags = {
    yes: false,
    dryRun: false,
    json: false,
    noToken: false,
    openTd: "prompt",
    showToken: false,
    bridgeDir: join(homedir(), "tdmcp-bridge"),
    bridgePort: 9980,
    profile: "local",
    clients: "auto",
    skip: new Set(),
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--no-token":
        flags.noToken = true;
        break;
      case "--open-td":
        flags.openTd = true;
        break;
      case "--no-open-td":
        flags.openTd = false;
        break;
      case "--show-token":
        flags.showToken = true;
        break;
      case "--bridge-dir": {
        const v = argv[++i];
        if (!v) return { error: "--bridge-dir requires a value", code: ERR_UNKNOWN_FLAG };
        flags.bridgeDir = v;
        break;
      }
      case "--bridge-port": {
        const v = argv[++i];
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n < 1 || n > 65535) {
          return {
            error: `--bridge-port expects an integer 1-65535, got ${v ?? ""}`,
            code: ERR_UNKNOWN_FLAG,
          };
        }
        flags.bridgePort = n;
        break;
      }
      case "--token": {
        const v = argv[++i];
        if (!v) return { error: "--token requires a value", code: ERR_UNKNOWN_FLAG };
        flags.token = v;
        break;
      }
      case "--profile": {
        const v = argv[++i];
        if (!v) return { error: "--profile requires a value", code: ERR_UNKNOWN_FLAG };
        flags.profile = v;
        break;
      }
      case "--td-path": {
        const v = argv[++i];
        if (!v) return { error: "--td-path requires a value", code: ERR_UNKNOWN_FLAG };
        flags.tdPath = v;
        break;
      }
      case "--clients": {
        const v = argv[++i];
        if (v === undefined) return { error: "--clients requires a value", code: ERR_UNKNOWN_FLAG };
        const parsed = parseClientsList(v);
        if (parsed === undefined) {
          return {
            error: `--clients accepts auto, none, or csv of claude,cursor,codex (got "${v}")`,
            code: ERR_UNKNOWN_FLAG,
          };
        }
        flags.clients = parsed;
        break;
      }
      case "--skip": {
        const v = argv[++i];
        if (v === undefined) return { error: "--skip requires a value", code: ERR_UNKNOWN_FLAG };
        for (const part of v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          if (!SKIPPABLE.has(part)) {
            return {
              error: `--skip accepts ${[...SKIPPABLE].join(",")} (got "${part}")`,
              code: ERR_UNKNOWN_FLAG,
            };
          }
          flags.skip.add(part);
        }
        break;
      }
      default:
        if (a.startsWith("-")) {
          return { error: `Unknown flag "${a}"`, code: ERR_UNKNOWN_FLAG };
        }
        return { error: `Unexpected argument "${a}"`, code: ERR_UNKNOWN_FLAG };
    }
  }

  if (flags.noToken && flags.token !== undefined) {
    return { error: "--no-token cannot be combined with --token", code: ERR_UNKNOWN_FLAG };
  }
  return flags;
}

function defaultClientPath(client: InitClient, plat: NodeJS.Platform, home: string): string {
  if (client === "claude") {
    if (plat === "darwin")
      return join(home, "Library/Application Support/Claude/claude_desktop_config.json");
    if (plat === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Claude", "claude_desktop_config.json");
    }
    return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  if (client === "cursor") return join(home, ".cursor", "mcp.json");
  return join(home, ".codex", "config.toml");
}

function defaultTdPath(plat: NodeJS.Platform): string | undefined {
  if (plat === "darwin") return "/Applications/TouchDesigner.app";
  if (plat === "win32")
    return "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe";
  return undefined;
}

export async function detectEnvironment(
  flags: InitFlags,
  deps: Required<
    Pick<RunInitDeps, "platform" | "homedir" | "existsSync" | "fetchBridge" | "readFile">
  >,
): Promise<DetectionResult> {
  const plat = deps.platform();
  const home = deps.homedir();
  const tdCandidate = flags.tdPath ?? defaultTdPath(plat);
  const tdFound = tdCandidate ? deps.existsSync(tdCandidate) : false;
  const tdData: { found: boolean; path?: string } =
    tdFound && tdCandidate ? { found: true, path: tdCandidate } : { found: false };

  const configPath = join(process.cwd(), "tdmcp.json");
  let existingConfig: DetectionResult["existingConfig"] = { exists: false, path: configPath };
  if (deps.existsSync(configPath)) {
    try {
      const raw = await deps.readFile(configPath);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        existingConfig = {
          exists: true,
          path: configPath,
          token: typeof parsed.token === "string" ? parsed.token : undefined,
          port: typeof parsed.bridgePort === "number" ? parsed.bridgePort : undefined,
          profile: typeof parsed.profile === "string" ? parsed.profile : undefined,
        };
      } else {
        existingConfig = { exists: true, path: configPath };
      }
    } catch {
      existingConfig = { exists: true, path: configPath };
    }
  }

  const running = await deps.fetchBridge(flags.bridgePort).catch(() => false);

  return {
    os: plat,
    td: tdData,
    bridge: { running, port: flags.bridgePort },
    existingConfig,
    clients: {
      claude: {
        exists: deps.existsSync(defaultClientPath("claude", plat, home)),
        path: defaultClientPath("claude", plat, home),
      },
      cursor: {
        exists: deps.existsSync(defaultClientPath("cursor", plat, home)),
        path: defaultClientPath("cursor", plat, home),
      },
      codex: {
        exists: deps.existsSync(defaultClientPath("codex", plat, home)),
        path: defaultClientPath("codex", plat, home),
      },
    },
  };
}

function resolveClients(flags: InitFlags, detection: DetectionResult): InitClient[] {
  if (flags.clients === "none") return [];
  if (Array.isArray(flags.clients)) return flags.clients;
  const found: InitClient[] = [];
  if (detection.clients.claude.exists) found.push("claude");
  if (detection.clients.cursor.exists) found.push("cursor");
  if (detection.clients.codex.exists) found.push("codex");
  return found.length > 0 ? found : ["claude"];
}

function redactToken(token: string | undefined, show: boolean): string | undefined {
  if (token === undefined) return undefined;
  return show ? token : "***";
}

function help(): string {
  return [
    "tdmcp init [options]",
    "",
    "Interactive setup wizard: install bridge + write starter config + patch MCP clients.",
    "",
    "  -y, --yes             Accept defaults, non-interactive",
    "      --dry-run         Plan only; do not touch files or launch TD",
    "      --json            Emit a JSON envelope and suppress banners",
    "      --clients <list>  auto | none | csv of claude,cursor,codex (default: auto)",
    "      --skip <steps>    csv of bridge,clients,config,token,open,doctor",
    "      --bridge-dir <p>  Bridge install dir (default: ~/tdmcp-bridge)",
    "      --bridge-port <n> Bridge port (default: 9980)",
    "      --token <v>       Use this TDMCP_BRIDGE_TOKEN",
    "      --no-token        Skip token generation",
    "      --profile <name>  Profile name in tdmcp.json (default: local)",
    "      --open-td         Launch TouchDesigner after install",
    "      --no-open-td      Do not launch TouchDesigner",
    "      --td-path <p>     Override TD discovery",
    "      --show-token      Do not redact token in --json output",
    "  -h, --help            Show this help",
    "",
  ].join("\n");
}

export async function runInit(argv: string[], depsIn: RunInitDeps = {}): Promise<InitResult> {
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    const stderr = depsIn.stderr ?? ((s) => process.stderr.write(s));
    stderr(`${parsed.error}\nRun \`tdmcp init --help\` for usage.\n`);
    process.exitCode = parsed.code;
    return {
      ok: false,
      flags: makeFlagsView(defaultFlags(), false),
      steps: [],
    };
  }

  const flags = parsed;
  const stdout = depsIn.stdout ?? ((s) => process.stdout.write(s));
  const stderr = depsIn.stderr ?? ((s) => process.stderr.write(s));

  if (flags.help) {
    stdout(`${help()}\n`);
    return { ok: true, flags: makeFlagsView(flags, false), steps: [] };
  }

  const deps = {
    platform: depsIn.platform ?? (() => platform()),
    homedir: depsIn.homedir ?? (() => homedir()),
    existsSync: depsIn.existsSync ?? existsSync,
    readFile: depsIn.readFile ?? ((p: string) => readFile(p, "utf8")),
    writeFile:
      depsIn.writeFile ??
      (async (p: string, body: string) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, body, "utf8");
      }),
    mkdir: depsIn.mkdir ?? (async (p: string) => void (await mkdir(p, { recursive: true }))),
    randomToken: depsIn.randomToken ?? (() => randomBytes(24).toString("base64url")),
    fetchBridge:
      depsIn.fetchBridge ??
      (async (port: number) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2000);
          const r = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: ctrl.signal });
          clearTimeout(t);
          return r.ok;
        } catch {
          return false;
        }
      }),
    spawnTd: depsIn.spawnTd ?? (() => undefined),
    copyToClipboard: depsIn.copyToClipboard ?? (async () => false),
    runInstallBridge: depsIn.runInstallBridge ?? runInstallBridge,
    writeInstallClientConfig: depsIn.writeInstallClientConfig ?? writeInstallClientConfig,
    runConfigInit: depsIn.runConfigInit ?? runConfigInit,
    runDoctor: depsIn.runDoctor ?? runDoctor,
  };

  const detection = await detectEnvironment(flags, deps);
  const steps: StepReport[] = [];
  steps.push({
    id: "detect",
    status: "ok",
    detail: `os=${detection.os} td=${detection.td.found ? "found" : "missing"} bridge=${detection.bridge.running ? "running" : "idle"}`,
  });

  // Step 2: token
  let token: string | undefined;
  if (flags.skip.has("token") || flags.noToken) {
    steps.push({ id: "token", status: "skipped", detail: flags.noToken ? "no-token" : "skip" });
  } else if (flags.dryRun) {
    token = flags.token ?? detection.existingConfig.token ?? "<would-generate>";
    steps.push({
      id: "token",
      status: "would",
      detail: "would generate or reuse TDMCP_BRIDGE_TOKEN",
    });
  } else if (flags.token) {
    token = flags.token;
    steps.push({ id: "token", status: "ok", detail: "using --token" });
  } else if (detection.existingConfig.token) {
    token = detection.existingConfig.token;
    steps.push({ id: "token", status: "skipped", detail: "reusing existing token" });
  } else {
    token = deps.randomToken();
    steps.push({ id: "token", status: "ok", detail: "generated 24-byte base64url token" });
  }

  // Step 3: bridge
  let textportCommand: string | undefined;
  if (flags.skip.has("bridge")) {
    steps.push({ id: "bridge", status: "skipped", detail: "skip" });
  } else if (flags.dryRun) {
    steps.push({
      id: "bridge",
      status: "would",
      detail: `would install bridge to ${flags.bridgeDir} on port ${flags.bridgePort}`,
    });
  } else {
    try {
      const bridgeArgs = ["--dir", flags.bridgeDir, "--port", String(flags.bridgePort), "--verify"];
      if (token) bridgeArgs.push("--token", token);
      const result: InstallBridgeResult = await Promise.resolve(deps.runInstallBridge(bridgeArgs));
      textportCommand = result.textportCommand ?? result.noPrefsTextportCommand;
      if (result.ok) {
        steps.push({
          id: "bridge",
          status: "ok",
          detail: result.verified ? "bridge verified" : "modules copied",
        });
      } else {
        steps.push({
          id: "bridge",
          status: detection.bridge.running ? "skipped" : "failed",
          detail: result.detail,
          retry: "tdmcp install-bridge --verify",
        });
      }
    } catch (err) {
      steps.push({
        id: "bridge",
        status: "failed",
        detail: (err as Error).message,
        retry: "tdmcp install-bridge --verify",
      });
    }
  }

  // Step 4: config
  if (flags.skip.has("config")) {
    steps.push({ id: "config", status: "skipped", detail: "skip" });
  } else if (flags.dryRun) {
    steps.push({
      id: "config",
      status: "would",
      detail: `would write starter config (profile=${flags.profile})`,
    });
  } else {
    try {
      const r = deps.runConfigInit({ force: false, bridgeToken: token });
      if (r.code === 0) {
        steps.push({ id: "config", status: "ok", detail: `wrote ${r.path}` });
      } else if (r.code === 1) {
        steps.push({ id: "config", status: "skipped", detail: `kept existing ${r.path}` });
      } else {
        steps.push({
          id: "config",
          status: "failed",
          detail: r.stderr.trim() || "config init failed",
        });
      }
    } catch (err) {
      steps.push({ id: "config", status: "failed", detail: (err as Error).message });
    }
  }

  // Step 5: clients
  if (flags.skip.has("clients") || flags.clients === "none") {
    steps.push({ id: "clients", status: "skipped", detail: "skip" });
  } else {
    const targets = resolveClients(flags, detection);
    if (targets.length === 0) {
      steps.push({ id: "clients", status: "skipped", detail: "no clients detected" });
    } else if (flags.dryRun) {
      steps.push({
        id: "clients",
        status: "would",
        detail: `would patch ${targets.join(",")}`,
      });
    } else {
      const okClients: string[] = [];
      const failedClients: string[] = [];
      for (const c of targets) {
        const cfgPath = defaultClientPath(c, detection.os, deps.homedir());
        try {
          await deps.writeInstallClientConfig(c, cfgPath, token);
          okClients.push(c);
        } catch (err) {
          failedClients.push(`${c}:${(err as Error).message}`);
        }
      }
      if (failedClients.length === 0) {
        steps.push({ id: "clients", status: "ok", detail: `patched ${okClients.join(",")}` });
      } else if (okClients.length === 0) {
        steps.push({
          id: "clients",
          status: "failed",
          detail: failedClients.join("; "),
          retry: "tdmcp install-client <name> --write --path <file>",
        });
      } else {
        steps.push({
          id: "clients",
          status: "ok",
          detail: `patched ${okClients.join(",")}; failed ${failedClients.join("; ")}`,
        });
      }
    }
  }

  // Step 6: open TD
  if (flags.skip.has("open")) {
    steps.push({ id: "open", status: "skipped", detail: "skip" });
  } else {
    const wantOpen =
      flags.openTd === true || (flags.openTd === "prompt" && !flags.yes && !flags.json);
    if (!wantOpen) {
      steps.push({ id: "open", status: "skipped", detail: "not requested" });
    } else if (!detection.td.found) {
      steps.push({ id: "open", status: "skipped", detail: "TouchDesigner not found" });
    } else if (flags.dryRun) {
      steps.push({ id: "open", status: "would", detail: `would launch ${detection.td.path}` });
    } else {
      try {
        if (textportCommand) await deps.copyToClipboard(textportCommand);
        if (detection.td.path) deps.spawnTd(detection.td.path);
        steps.push({ id: "open", status: "ok", detail: "launched TouchDesigner" });
      } catch (err) {
        steps.push({ id: "open", status: "failed", detail: (err as Error).message });
      }
    }
  }

  // Step 7: doctor
  if (flags.skip.has("doctor")) {
    steps.push({ id: "doctor", status: "skipped", detail: "skip" });
  } else if (flags.dryRun) {
    steps.push({ id: "doctor", status: "would", detail: "would run tdmcp doctor --json" });
  } else {
    try {
      const r = await deps.runDoctor({});
      steps.push({
        id: "doctor",
        status: r.report.ok ? "ok" : "failed",
        detail: r.report.ok ? "all checks pass" : "some checks failed (run `tdmcp doctor`)",
      });
    } catch (err) {
      steps.push({ id: "doctor", status: "failed", detail: (err as Error).message });
    }
  }

  const ok = steps.every((s) => s.status !== "failed");
  const result: InitResult = {
    ok,
    flags: { ...flags, token: redactToken(token, flags.showToken), tokenSet: token !== undefined },
    detection,
    steps,
    textportCommand,
  };

  if (flags.json) {
    stdout(`${JSON.stringify(result, replacerForSet, 2)}\n`);
  } else {
    stdout(`${renderSummary(result)}\n`);
  }
  if (!ok) {
    process.exitCode = 1;
    stderr("Some steps failed. Re-run with --json for details.\n");
  }
  return result;
}

function defaultFlags(): InitFlags {
  return {
    yes: false,
    dryRun: false,
    json: false,
    noToken: false,
    openTd: "prompt",
    showToken: false,
    bridgeDir: join(homedir(), "tdmcp-bridge"),
    bridgePort: 9980,
    profile: "local",
    clients: "auto",
    skip: new Set(),
    help: false,
  };
}

function makeFlagsView(flags: InitFlags, tokenSet: boolean): InitResult["flags"] {
  return { ...flags, token: undefined, tokenSet };
}

function replacerForSet(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  return value;
}

function renderSummary(r: InitResult): string {
  const lines = ["tdmcp init —", ""];
  for (const s of r.steps) {
    const icon =
      s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : s.status === "would" ? "?" : "✖";
    lines.push(`  ${icon} ${s.id}: ${s.detail}`);
  }
  lines.push("", r.ok ? "Ready." : "Some steps failed.");
  return lines.join("\n");
}

export { defaultClientPath, resolveClients };
