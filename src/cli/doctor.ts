import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { LlmClient } from "../llm/client.js";
import { buildToolContext } from "../server/context.js";
import { friendlyTdError } from "../td-client/types.js";
import type { ToolContext } from "../tools/types.js";
import { loadConfig, type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { type InstallBridgeResult, runInstallBridge } from "./installBridge.js";

/**
 * `tdmcp doctor` — a one-shot environment diagnostic for non-technical artists.
 *
 * It probes the things a fresh setup needs (the TouchDesigner bridge, the local
 * LLM copilot, the optional vault) and resolves the effective config, then prints
 * a plain-language pass/warn/fail report. The exit code is 0 unless a *critical*
 * check fails (the bridge or the config), so the optional copilot/vault never
 * blocks an otherwise-healthy setup.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Short stable id (machine-readable): "bridge" | "config" | "llm" | "vault". */
  id: string;
  /** Human label shown in the report. */
  title: string;
  status: CheckStatus;
  /** One-line explanation of the result. */
  detail: string;
  /** Whether a failure here is fatal (drives the exit code). */
  critical: boolean;
  /** Optional extra facts surfaced in the structured result (versions, urls, …). */
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** Safe repairs actually attempted by `doctor --fix`. */
  repairs?: Array<{ id: string; status: "applied" | "failed"; detail: string }>;
  /** Suggested remediation commands for non-passing checks (populated when `fix` is set). */
  fixes?: Array<{ id: string; command: string }>;
  /** Resolved configuration the checks ran against (handy for bug reports). */
  config: {
    tdBaseUrl: string;
    llmBaseUrl: string;
    llmModel: string;
    chatPort: number;
    vaultPath: string | null;
  };
}

/** Mirrors `CliResult` from agent.ts, plus the structured report for programmatic use. */
export interface DoctorResult {
  stdout: string;
  stderr: string;
  code: number;
  report: DoctorReport;
}

export interface RunDoctorOptions {
  /** When set, append a "Suggested fixes" section: a remediation command per non-passing check. */
  fix?: boolean;
  /** Inject a config (tests / callers that already loaded one); defaults to env. */
  config?: TdmcpConfig;
  /** Inject a context (tests); production builds one from the config. */
  makeCtx?: (config: TdmcpConfig) => ToolContext;
  /** Inject an LLM client (tests); defaults to a real `LlmClient` over the config. */
  makeLlmClient?: (config: TdmcpConfig) => Pick<LlmClient, "health">;
  /** Overridable filesystem probe for the vault check (tests); defaults to real fs. */
  vaultProbe?: (absPath: string) => { exists: boolean; isDir: boolean };
  /** Overridable vault repair hook for tests; defaults to mkdir -p. */
  vaultRepair?: (absPath: string) => void;
  /** Overridable env-file path for the bridge-token repair (tests); defaults to .env in cwd. */
  envFilePath?: string;
  /** Overridable env-file write hook for tests; defaults to fs.appendFileSync. */
  envFileWrite?: (filePath: string, token: string) => void;
  /** Overridable profile dir path for profile repair (tests); defaults to ~/.config/tdmcp/profiles. */
  profileDirPath?: string;
  /** Overridable profile dir create hook for tests; defaults to mkdir -p. */
  profileDirRepair?: (dirPath: string) => void;
  /** Overridable install-bridge runner for tests; defaults to local install-bridge --verify. */
  runInstallBridge?: (port: number) => Promise<InstallBridgeResult>;
  /** Overridable Textport auto-install runner for tests; defaults to a bounded macOS AppleScript. */
  runTextportInstall?: (command: string) => Promise<{ ok: boolean; detail: string }>;
}

const ICON: Record<CheckStatus, string> = { pass: "✔", warn: "!", fail: "✖" };

/** Expands a leading `~/` the same way the Vault does, so the report matches reality. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

function defaultVaultProbe(absPath: string): { exists: boolean; isDir: boolean } {
  if (!existsSync(absPath)) return { exists: false, isDir: false };
  try {
    return { exists: true, isDir: statSync(absPath).isDirectory() };
  } catch {
    return { exists: true, isDir: false };
  }
}

function defaultVaultRepair(absPath: string): void {
  mkdirSync(absPath, { recursive: true });
}

/**
 * Default install-bridge runner — runs `install-bridge --verify` locally unless
 * TDMCP_BIN is set, in which case it spawns that explicit binary for tests and
 * wrapper integrations.
 *
 * Spawned calls are bounded by a hard SIGKILL after
 * `TDMCP_INSTALL_BRIDGE_TIMEOUT_MS` (default 60s) so `doctor --fix` can never
 * hang indefinitely on a stuck child.
 */
function defaultRunInstallBridge(port: number): Promise<InstallBridgeResult> {
  if (!process.env.TDMCP_BIN?.trim()) {
    return runLocalInstallBridge(port);
  }

  return spawnInstallBridge(process.env.TDMCP_BIN, port);
}

function runLocalInstallBridge(port: number): Promise<InstallBridgeResult> {
  const prevExitCode = process.exitCode;
  const prevLog = console.log;
  const prevError = console.error;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    output += `${args.map(String).join(" ")}\n`;
  };
  return Promise.resolve()
    .then(() => runInstallBridge(["--verify", "--port", String(port)]))
    .then((result) => ({
      ...result,
      detail: result.detail || output.trim().split("\n").slice(-3).join(" | ") || "completed",
    }))
    .finally(() => {
      console.log = prevLog;
      console.error = prevError;
      process.exitCode = prevExitCode;
    });
}

function spawnInstallBridge(cmd: string, port: number): Promise<InstallBridgeResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["install-bridge", "--verify", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timeoutMs = Number.parseInt(process.env.TDMCP_INSTALL_BRIDGE_TIMEOUT_MS ?? "60000", 10);
    const timer = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done({
          ok: false,
          detail: `install-bridge --verify timed out after ${timeoutMs}ms`,
        });
      },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    );
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      done({ ok: false, detail: `spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      const tail = (stdout + stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 240);
      done({
        ok: code === 0,
        detail: code === 0 ? tail || "exit 0" : `exit ${code ?? "?"}: ${tail || "(no output)"}`,
      });
    });
  });
}

function defaultRunTextportInstall(command: string): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "darwin") {
    return Promise.resolve({
      ok: false,
      detail: "Textport auto-install is only supported on macOS; run the manual Textport command.",
    });
  }

  return new Promise((resolve) => {
    const script = `
on run argv
  set tdmcpCommand to item 1 of argv
  set the clipboard to tdmcpCommand
  tell application "System Events"
    set tdProcesses to (every process whose name contains "TouchDesigner")
    if (count of tdProcesses) is 0 then error "TouchDesigner process not found"
    set frontmost of item 1 of tdProcesses to true
    delay 0.3
    keystroke "t" using option down
    delay 0.3
    keystroke "v" using command down
    key code 36
  end tell
end run`;
    const child = spawn("osascript", ["-e", script, command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timeoutMs = readPositiveIntEnv("TDMCP_TEXTPORT_INSTALL_TIMEOUT_MS", 10_000);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ ok: false, detail: `Textport auto-install timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      done({ ok: false, detail: `osascript failed: ${err.message}` });
    });
    child.on("close", (code) => {
      const tail = (stdout + stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 240);
      done({
        ok: code === 0,
        detail:
          code === 0
            ? tail || "Textport command sent"
            : `osascript exit ${code ?? "?"}: ${tail || "(no output)"}`,
      });
    });
  });
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TD bridge reachability + version. Critical: a failure here fails the whole doctor. */
async function checkBridge(ctx: ToolContext): Promise<DoctorCheck> {
  const base = { id: "bridge", title: "TouchDesigner bridge", critical: true } as const;
  try {
    const info = await ctx.client.getInfo();
    const version = info.td_version ?? "unknown";
    const bridge = info.bridge_version ? ` · bridge ${info.bridge_version}` : "";
    return {
      ...base,
      status: "pass",
      detail: `reachable at ${ctx.client.endpoint} (TD ${version}${bridge})`,
      data: { endpoint: ctx.client.endpoint, ...info },
    };
  } catch (err) {
    return {
      ...base,
      status: "fail",
      detail: `not reachable at ${ctx.client.endpoint}. Start TouchDesigner with the tdmcp bridge installed. (${friendlyTdError(
        err,
      )})`,
      data: { endpoint: ctx.client.endpoint },
    };
  }
}

/**
 * Local LLM (Ollama) copilot reachability + model availability. Optional feature, so
 * this never marks the doctor as failed — unreachable or model-not-pulled is a warn.
 */
async function checkLlm(
  config: TdmcpConfig,
  makeClient: (config: TdmcpConfig) => Pick<LlmClient, "health">,
): Promise<DoctorCheck> {
  const base = { id: "llm", title: "Local LLM copilot (Ollama)", critical: false } as const;
  const data = { baseUrl: config.llmBaseUrl, model: config.llmModel };
  const health = await makeClient(config).health();
  if (!health.ok) {
    return {
      ...base,
      status: "warn",
      detail: `endpoint ${config.llmBaseUrl} not reachable — \`tdmcp chat\` is unavailable until a local LLM server is running (${health.detail}).`,
      data,
    };
  }
  if (!health.modelReady) {
    return {
      ...base,
      status: "warn",
      detail: `reachable, but ${health.detail}. Run \`ollama pull ${config.llmModel}\` to enable \`tdmcp chat\`.`,
      data,
    };
  }
  return {
    ...base,
    status: "pass",
    detail: `reachable at ${config.llmBaseUrl} — ${health.detail}.`,
    data,
  };
}

/**
 * Vault (Obsidian notes) configuration. Optional, so an unset path is a pass-with-note.
 * A configured-but-missing folder is a warn (real misconfiguration) but not fatal.
 */
function checkVault(
  config: TdmcpConfig,
  probe: (absPath: string) => { exists: boolean; isDir: boolean },
): DoctorCheck {
  const base = { id: "vault", title: "Vault (optional)", critical: false } as const;
  if (!config.vaultPath) {
    return {
      ...base,
      status: "pass",
      detail: "not configured (TDMCP_VAULT_PATH unset) — vault tools are disabled, which is fine.",
      data: { configured: false },
    };
  }
  const absPath = resolve(expandHome(config.vaultPath));
  const { exists, isDir } = probe(absPath);
  const data = { configured: true, path: absPath };
  if (!exists) {
    return {
      ...base,
      status: "warn",
      detail: `TDMCP_VAULT_PATH is set to "${config.vaultPath}" but that folder does not exist (${absPath}).`,
      data,
    };
  }
  if (!isDir) {
    return {
      ...base,
      status: "warn",
      detail: `TDMCP_VAULT_PATH "${config.vaultPath}" exists but is not a folder (${absPath}).`,
      data,
    };
  }
  return { ...base, status: "pass", detail: `folder found at ${absPath}.`, data };
}

/** Tool-exposure state: surfaces whether raw-Python / destructive tools are locked out. Never fatal. */
function checkTools(config: TdmcpConfig): DoctorCheck {
  const locked: string[] = [];
  if (config.rawPython === "off") locked.push("raw-Python escape hatches (TDMCP_RAW_PYTHON=off)");
  if (config.toolProfile === "safe")
    locked.push("destructive/raw-code tools (TDMCP_TOOL_PROFILE=safe)");
  return {
    id: "tools",
    title: "Tool exposure",
    status: "pass",
    critical: false,
    detail: locked.length
      ? `restricted: ${locked.join("; ")} are hidden. If a tool is unexpectedly missing, this is why.`
      : `full surface (profile ${config.toolProfile}, raw-Python ${config.rawPython}).`,
    data: { rawPython: config.rawPython, toolProfile: config.toolProfile },
  };
}

/** Check whether a TDMCP_BRIDGE_TOKEN is configured. Never critical. */
function checkBridgeToken(config: TdmcpConfig): DoctorCheck {
  const base = { id: "bridge_token", title: "Bridge auth token", critical: false } as const;
  if (config.bridgeToken) {
    return { ...base, status: "pass", detail: "TDMCP_BRIDGE_TOKEN is set.", data: { set: true } };
  }
  return {
    ...base,
    status: "warn",
    detail:
      "TDMCP_BRIDGE_TOKEN is not set — the bridge accepts unauthenticated requests. For a shared network, generate a token with `--fix`.",
    data: { set: false },
  };
}

/** Check whether the default profile directory exists. Never critical. */
function checkProfileDir(profileDirPath: string): DoctorCheck {
  const base = { id: "profile_dir", title: "Profile directory", critical: false } as const;
  if (existsSync(profileDirPath)) {
    let isDir = false;
    try {
      isDir = statSync(profileDirPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      return {
        ...base,
        status: "pass",
        detail: `profile directory found at ${profileDirPath}.`,
        data: { path: profileDirPath },
      };
    }
    return {
      ...base,
      status: "warn",
      detail: `path exists at ${profileDirPath} but is not a directory; remove or move it so the profile dir can be created.`,
      data: { path: profileDirPath },
    };
  }
  return {
    ...base,
    status: "warn",
    detail: `default profile directory does not exist at ${profileDirPath}.`,
    data: { path: profileDirPath },
  };
}

/** Default .env path (cwd/.env). */
function defaultEnvFilePath(): string {
  return join(process.cwd(), ".env");
}

/** Default profile dir path (~/.config/tdmcp/profiles). */
function defaultProfileDirPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configDir, "tdmcp", "profiles");
}

/**
 * Default env-file write: appends (or creates) the token line idempotently.
 * Forces owner-only permissions (0o600) on the .env to keep the bridge token
 * out of group/world-readable scrollback. Best-effort on non-POSIX where
 * chmod is a no-op.
 */
function defaultEnvFileWrite(filePath: string, token: string): void {
  const line = `TDMCP_BRIDGE_TOKEN=${token}`;
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8");
    // Line-anchored so a commented `# TDMCP_BRIDGE_TOKEN=…` doesn't block the write.
    if (/^\s*TDMCP_BRIDGE_TOKEN=/m.test(content)) return; // already set, don't double-write
    appendFileSync(filePath, `\n${line}\n`);
  } else {
    writeFileSync(filePath, `${line}\n`, { mode: 0o600 });
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod may be unsupported (Windows / unusual FS); the secret-in-.env design
    // already assumes a single-user setup so we tolerate this.
  }
}

/** Repair missing TDMCP_BRIDGE_TOKEN by generating and writing one to the .env file. */
function repairBridgeToken(
  check: DoctorCheck | undefined,
  envFilePath: string,
  write: (filePath: string, token: string) => void,
): Array<{ id: string; status: "applied" | "failed"; detail: string }> {
  if (!check || check.status === "pass") return [];
  try {
    const token = randomBytes(24).toString("hex");
    write(envFilePath, token);
    return [
      {
        id: "bridge_token",
        status: "applied",
        detail: `generated bridge token written to ${envFilePath}. Restart tdmcp, then open that .env file to copy the TDMCP_BRIDGE_TOKEN value into TouchDesigner's environment (the raw token is intentionally NOT printed here to avoid leaking it into shell scrollback / CI logs).`,
      },
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
      {
        id: "bridge_token",
        status: "failed",
        detail: `could not write token to ${envFilePath}: ${reason}`,
      },
    ];
  }
}

/** Repair missing bridge by running install-bridge --verify and, on macOS, Textport automation. */
async function repairBridge(
  check: DoctorCheck | undefined,
  runInstall: (() => Promise<InstallBridgeResult>) | undefined,
  runTextportInstall: ((command: string) => Promise<{ ok: boolean; detail: string }>) | undefined,
  verifyBridge: (() => Promise<DoctorCheck>) | undefined,
): Promise<Array<{ id: string; status: "applied" | "failed"; detail: string }>> {
  if (!check || check.status === "pass" || !runInstall) return [];
  try {
    const result = await runInstall();
    if (!result.ok) {
      const command = result.noPrefsTextportCommand ?? result.textportCommand;
      if (command && runTextportInstall) {
        const textportResult = await runTextportInstall(command);
        if (textportResult.ok && verifyBridge) {
          const timeoutMs = readPositiveIntEnv("TDMCP_TEXTPORT_VERIFY_TIMEOUT_MS", 10_000);
          const intervalMs = readPositiveIntEnv("TDMCP_TEXTPORT_VERIFY_INTERVAL_MS", 250);
          const verifiedBridge = await waitForBridgeVerification(
            verifyBridge,
            timeoutMs,
            intervalMs,
          );
          return [
            {
              id: "bridge",
              status: verifiedBridge.status === "pass" ? "applied" : "failed",
              detail:
                verifiedBridge.status === "pass"
                  ? `install-bridge --verify needed Textport; ${textportResult.detail}; bridge verified: ${verifiedBridge.detail}`
                  : `install-bridge --verify failed: ${result.detail}; ${textportResult.detail}. Bridge did not verify within ${timeoutMs}ms: ${verifiedBridge.detail}. Manual Textport command:\n${command}`,
            },
          ];
        }
        return [
          {
            id: "bridge",
            status: textportResult.ok ? "applied" : "failed",
            detail: textportResult.ok
              ? `install-bridge --verify needed Textport; ${textportResult.detail}`
              : `install-bridge --verify failed: ${result.detail}; Textport auto-install failed: ${textportResult.detail}. Manual Textport command:\n${command}`,
          },
        ];
      }
    }
    return [
      {
        id: "bridge",
        status: result.ok ? "applied" : "failed",
        detail: result.ok
          ? `install-bridge --verify succeeded: ${result.detail}`
          : `install-bridge --verify failed: ${result.detail}`,
      },
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [{ id: "bridge", status: "failed", detail: `install-bridge error: ${reason}` }];
  }
}

async function waitForBridgeVerification(
  verifyBridge: () => Promise<DoctorCheck>,
  timeoutMs: number,
  intervalMs: number,
): Promise<DoctorCheck> {
  const deadline = Date.now() + timeoutMs;
  let lastCheck = await verifyBridge();
  while (lastCheck.status !== "pass" && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    lastCheck = await verifyBridge();
  }
  return lastCheck;
}

/** Repair missing profile directory. */
function repairProfileDir(
  check: DoctorCheck | undefined,
  repair: (dirPath: string) => void,
): Array<{ id: string; status: "applied" | "failed"; detail: string }> {
  if (!check || check.status === "pass") return [];
  const dirPath = typeof check.data?.path === "string" ? check.data.path : "";
  if (!dirPath) return [];
  try {
    repair(dirPath);
    return [
      { id: "profile_dir", status: "applied", detail: `created profile directory at ${dirPath}.` },
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
      {
        id: "profile_dir",
        status: "failed",
        detail: `could not create profile directory at ${dirPath}: ${reason}`,
      },
    ];
  }
}

/** Maps a non-passing check id to a remediation command/hint for `doctor --fix`. */
function suggestFix(check: DoctorCheck, config: TdmcpConfig): string | undefined {
  if (check.status === "pass") return undefined;
  switch (check.id) {
    case "bridge":
      return "Start TouchDesigner, then run `tdmcp doctor --fix` to attempt a macOS Textport auto-install; if automation is unavailable, run `tdmcp install-bridge` and paste the Textport one-liner it prints.";
    case "bridge_token":
      return "Run `tdmcp doctor --fix` to generate a token and write it to your .env file, then set the same value in TouchDesigner's environment (TDMCP_BRIDGE_TOKEN).";
    case "profile_dir":
      return "Run `tdmcp doctor --fix` to scaffold the default profile directory, or create it manually.";
    case "llm":
      return `Start the local LLM and pull the model:  ollama serve  &&  ollama pull ${config.llmModel}`;
    case "vault":
      return config.vaultPath
        ? `Create the folder or fix the path:  mkdir -p "${config.vaultPath}"  (or unset TDMCP_VAULT_PATH).`
        : undefined;
    case "config":
      return "Fix the invalid setting shown above (check your env vars / config file), then re-run `tdmcp doctor`.";
    default:
      return undefined;
  }
}

function repairVault(
  config: TdmcpConfig,
  check: DoctorCheck | undefined,
  repair: (absPath: string) => void,
): DoctorReport["repairs"] {
  if (!check || check.status === "pass" || !config.vaultPath) return undefined;
  const absPath = resolve(expandHome(config.vaultPath));
  const dataPath = typeof check.data?.path === "string" ? check.data.path : absPath;
  try {
    repair(absPath);
    return [
      {
        id: "vault",
        status: "applied",
        detail: `created vault folder at ${dataPath}.`,
      },
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
      {
        id: "vault",
        status: "failed",
        detail: `could not create vault folder at ${dataPath}: ${reason}`,
      },
    ];
  }
}

/** Config sanity: surfaces the effective TD/LLM settings. Critical (anchors the exit code). */
function checkConfig(config: TdmcpConfig): DoctorCheck {
  const td = tdBaseUrl(config);
  return {
    id: "config",
    title: "Config",
    status: "pass",
    critical: true,
    detail: `TD ${td} · LLM ${config.llmBaseUrl} (model ${config.llmModel}) · chat port ${config.chatPort}`,
    data: {
      tdBaseUrl: td,
      llmBaseUrl: config.llmBaseUrl,
      llmModel: config.llmModel,
      chatPort: config.chatPort,
    },
  };
}

function render(report: DoctorReport): string {
  const lines: string[] = ["tdmcp doctor — environment check", ""];
  for (const c of report.checks) {
    lines.push(`  ${ICON[c.status]} ${c.title}: ${c.detail}`);
  }
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail");
  const warned = report.checks.filter((c) => c.status === "warn");
  if (report.ok && warned.length === 0) {
    lines.push("All good — TouchDesigner is reachable and your setup is ready.");
  } else if (report.ok) {
    lines.push(`Ready, with ${warned.length} optional item(s) to look at (see the ! lines above).`);
  } else {
    lines.push(
      `Setup is not ready: ${failed.length} critical check(s) failed (see the ✖ lines above).`,
    );
  }
  const appliedRepairs = report.repairs?.filter((repair) => repair.status === "applied") ?? [];
  const failedRepairs = report.repairs?.filter((repair) => repair.status === "failed") ?? [];
  if (appliedRepairs.length) {
    lines.push("", "Applied fixes:");
    for (const repair of appliedRepairs) lines.push(`  ✔ ${repair.id}: ${repair.detail}`);
  }
  if (failedRepairs.length) {
    lines.push("", "Failed fixes:");
    for (const repair of failedRepairs) lines.push(`  ✖ ${repair.id}: ${repair.detail}`);
  }
  if (report.fixes?.length) {
    lines.push("", "Suggested fixes:");
    for (const fix of report.fixes) lines.push(`  • ${fix.command}`);
  }
  return lines.join("\n");
}

/**
 * Runs every diagnostic and returns a CliResult-shaped payload (plus the structured
 * report). Exit code is 0 unless a critical check (bridge or config) fails.
 */
export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorResult> {
  // Config first: if env is invalid, loadConfig throws — that is itself a fatal result.
  let config: TdmcpConfig;
  try {
    config = opts.config ?? loadConfig();
  } catch (err) {
    const report: DoctorReport = {
      ok: false,
      checks: [
        {
          id: "config",
          title: "Config",
          status: "fail",
          critical: true,
          detail: `invalid configuration: ${(err as Error).message}`,
        },
      ],
      config: {
        tdBaseUrl: "(unresolved)",
        llmBaseUrl: "(unresolved)",
        llmModel: "(unresolved)",
        chatPort: 0,
        vaultPath: null,
      },
    };
    return {
      stdout: `${render(report)}\n`,
      stderr: "Setup is not ready: invalid configuration.\n",
      code: 1,
      report,
    };
  }

  const ctx = opts.makeCtx
    ? opts.makeCtx(config)
    : buildToolContext(config, { logger: silentLogger });
  const makeLlmClient = opts.makeLlmClient ?? ((c: TdmcpConfig) => new LlmClient(c));
  const vaultProbe = opts.vaultProbe ?? defaultVaultProbe;
  const vaultRepair = opts.vaultRepair ?? defaultVaultRepair;
  const envFilePath = opts.envFilePath ?? defaultEnvFilePath();
  const envFileWrite = opts.envFileWrite ?? defaultEnvFileWrite;
  const profileDirPath = opts.profileDirPath ?? defaultProfileDirPath();
  const profileDirRepair =
    opts.profileDirRepair ?? ((dir: string) => mkdirSync(dir, { recursive: true }));

  let checks: DoctorCheck[] = [
    await checkBridge(ctx),
    checkConfig(config),
    checkTools(config),
    await checkLlm(config, makeLlmClient),
    checkVault(config, vaultProbe),
    checkBridgeToken(config),
    checkProfileDir(profileDirPath),
  ];

  let allRepairs: NonNullable<DoctorReport["repairs"]> = [];

  if (opts.fix) {
    const vaultRepairs =
      repairVault(
        config,
        checks.find((c) => c.id === "vault"),
        vaultRepair,
      ) ?? [];
    allRepairs = allRepairs.concat(vaultRepairs);
    if (vaultRepairs.some((r) => r.status === "applied")) {
      const refreshedVault = checkVault(config, vaultProbe);
      checks = checks.map((check) => (check.id === "vault" ? refreshedVault : check));
    }

    const tokenRepairs = repairBridgeToken(
      checks.find((c) => c.id === "bridge_token"),
      envFilePath,
      envFileWrite,
    );
    allRepairs = allRepairs.concat(tokenRepairs);

    const bridgeRepairs = await repairBridge(
      checks.find((c) => c.id === "bridge"),
      () => (opts.runInstallBridge ?? defaultRunInstallBridge)(config.tdPort),
      opts.runTextportInstall ?? defaultRunTextportInstall,
      () => checkBridge(ctx),
    );
    allRepairs = allRepairs.concat(bridgeRepairs);
    // Re-probe the bridge after a successful repair so the report (and the
    // exit code, since bridge is critical) reflect the post-fix state instead
    // of contradicting the "Applied fixes" output with a stale fail row.
    if (bridgeRepairs.some((r) => r.status === "applied")) {
      const refreshedBridge = await checkBridge(ctx);
      checks = checks.map((check) => (check.id === "bridge" ? refreshedBridge : check));
    }

    const profileRepairs = repairProfileDir(
      checks.find((c) => c.id === "profile_dir"),
      profileDirRepair,
    );
    allRepairs = allRepairs.concat(profileRepairs);
    if (profileRepairs.some((r) => r.status === "applied")) {
      const refreshed = checkProfileDir(profileDirPath);
      checks = checks.map((check) => (check.id === "profile_dir" ? refreshed : check));
    }
  }

  const repairs = allRepairs.length > 0 ? allRepairs : undefined;

  const ok = !checks.some((c) => c.critical && c.status === "fail");
  const fixes = opts.fix
    ? checks
        .map((c) => ({ id: c.id, command: suggestFix(c, config) }))
        .filter((f): f is { id: string; command: string } => f.command !== undefined)
    : undefined;
  const report: DoctorReport = {
    ok,
    checks,
    ...(repairs?.length ? { repairs } : {}),
    ...(fixes?.length ? { fixes } : {}),
    config: {
      tdBaseUrl: tdBaseUrl(config),
      llmBaseUrl: config.llmBaseUrl,
      llmModel: config.llmModel,
      chatPort: config.chatPort,
      vaultPath: config.vaultPath ?? null,
    },
  };

  const summary = ok
    ? "Setup is ready."
    : "Setup is not ready: a critical check failed (run `tdmcp doctor` for details).";
  return { stdout: `${render(report)}\n`, stderr: `${summary}\n`, code: ok ? 0 : 1, report };
}
