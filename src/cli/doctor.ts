import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { LlmClient } from "../llm/client.js";
import { buildToolContext } from "../server/context.js";
import { friendlyTdError } from "../td-client/types.js";
import type { ToolContext } from "../tools/types.js";
import { loadConfig, type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";

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

/** Maps a non-passing check id to a remediation command/hint for `doctor --fix`. */
function suggestFix(check: DoctorCheck, config: TdmcpConfig): string | undefined {
  if (check.status === "pass") return undefined;
  switch (check.id) {
    case "bridge":
      return "Start TouchDesigner, then run `tdmcp install-bridge` and paste the Textport one-liner it prints.";
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

  const checks: DoctorCheck[] = [
    await checkBridge(ctx),
    checkConfig(config),
    checkTools(config),
    await checkLlm(config, makeLlmClient),
    checkVault(config, vaultProbe),
  ];

  const ok = !checks.some((c) => c.critical && c.status === "fail");
  const fixes = opts.fix
    ? checks
        .map((c) => ({ id: c.id, command: suggestFix(c, config) }))
        .filter((f): f is { id: string; command: string } => f.command !== undefined)
    : undefined;
  const report: DoctorReport = {
    ok,
    checks,
    ...(fixes && fixes.length ? { fixes } : {}),
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
