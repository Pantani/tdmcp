import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { manageAgentSkills } from "../skills/installer.js";
import type { ManageAgentSkillsResult, SkillHost, SkillScope } from "../skills/types.js";
import { inspectRuntimeConfig, resolveHttpAuthMode, tdBaseUrl } from "../utils/config.js";
import { getVersion } from "../utils/version.js";
import type {
  RuntimeClientAdapterObservation,
  RuntimeConfigReadResult,
  RuntimeEffectiveConfig,
  RuntimeStatusArgs,
  RuntimeStatusDeps,
} from "./runtimeStatus.js";

const MAX_CLIENT_CONFIG_BYTES = 1024 * 1024;
const CLIENT_TARGETS = [
  { client: "claude", scope: "project" },
  { client: "claude", scope: "user" },
  { client: "cursor", scope: "project" },
  { client: "cursor", scope: "user" },
  { client: "codex", scope: "user" },
] as const;

interface RuntimeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

interface ClientEntry {
  command?: unknown;
  env?: Record<string, unknown>;
}

function effectiveConfig(
  input: Pick<RuntimeStatusArgs, "profile" | "config_path">,
  options: RuntimeAdapterOptions,
): RuntimeConfigReadResult {
  const env = options.env ?? process.env;
  const inspected = inspectRuntimeConfig(env, {
    cwd: options.cwd ?? process.cwd(),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.config_path ? { configPath: input.config_path } : {}),
  });
  if (inspected.state === "unavailable") {
    return {
      state: "unavailable",
      reason_code: inspected.reason,
      profile: inspected.profile,
    };
  }
  const config = inspected.config;
  return {
    state: "available",
    config: {
      profile: inspected.profile,
      source_kind: inspected.sourceKind,
      transport: config.transport,
      bridge_endpoint: tdBaseUrl(config),
      mcp_endpoint:
        config.transport === "http"
          ? `http://${config.httpHost ?? "127.0.0.1"}:${config.httpPort}`
          : null,
      http_auth_mode: resolveHttpAuthMode(config),
      request_timeout_ms: config.requestTimeoutMs,
      ...(config.bridgeToken ? { bridge_token: config.bridgeToken } : {}),
      mcp_http_token_configured: Boolean(config.httpAuthToken),
      tool_profile: config.toolProfile,
      raw_python: config.rawPython,
      yolo: config.yolo,
    },
  };
}

function readSkills(options: RuntimeAdapterOptions): ManageAgentSkillsResult[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDir ?? homedir());
  const results: ManageAgentSkillsResult[] = [];
  for (const host of ["codex", "claude"] as const) {
    for (const scope of ["project", "user"] as const) {
      results.push(readSkillInstallation(host, scope, cwd, home, options.env?.CODEX_HOME));
    }
  }
  return results;
}

function readSkillInstallation(
  host: SkillHost,
  scope: SkillScope,
  cwd: string,
  home: string,
  codexHome: string | undefined,
): ManageAgentSkillsResult {
  try {
    return manageAgentSkills(
      {
        action: "status",
        host,
        scope,
        ...(scope === "project" ? { project_root: cwd } : {}),
        dry_run: true,
        force_owned_drift: false,
      },
      { projectRoot: cwd, homeDir: home, codexHome },
    );
  } catch {
    return {
      action: "status",
      status: "failed",
      dry_run: true,
      host,
      scope,
      target_root: "",
      manifest_path: "",
      source_version: getVersion(),
      planned: [],
      applied: [],
      skills: [],
      warnings: ["Skill state could not be read safely."],
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedRegularFile(
  path: string,
): { state: "missing" } | { state: "invalid" } | { state: "available"; raw: string } {
  if (!existsSync(path)) return { state: "missing" };
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CLIENT_CONFIG_BYTES) {
      return { state: "invalid" };
    }
    return { state: "available", raw: readFileSync(path, "utf8") };
  } catch {
    return { state: "invalid" };
  }
}

function jsonClientEntry(raw: string): ClientEntry | "invalid" | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return "invalid";
    const servers = parsed.mcpServers;
    if (servers === undefined) return null;
    if (!isPlainObject(servers)) return "invalid";
    const entry = servers.tdmcp;
    if (entry === undefined) return null;
    if (!isPlainObject(entry)) return "invalid";
    if (entry.env !== undefined && !isPlainObject(entry.env)) return "invalid";
    return { command: entry.command, env: entry.env as Record<string, unknown> | undefined };
  } catch {
    return "invalid";
  }
}

function parseTomlString(value: string): string | "invalid" {
  const trimmed = value.trim();
  if (!/^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) return "invalid";
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return "invalid";
  }
}

interface CodexTomlState {
  section: string;
  seen: boolean;
  entry: ClientEntry;
}

function applyCodexAssignment(state: CodexTomlState, key: string, rawValue: string): boolean {
  if (state.section === "mcp_servers.tdmcp" && key !== "command") return true;
  const value = parseTomlString(rawValue);
  if (value === "invalid") return false;
  if (state.section === "mcp_servers.tdmcp" && key === "command") {
    state.entry.command = value;
  }
  if (state.section === "mcp_servers.tdmcp.env") {
    state.entry.env = { ...state.entry.env, [key]: value };
  }
  return true;
}

function applyCodexTomlLine(state: CodexTomlState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return true;
  const header = /^\[([^\]]+)\]$/u.exec(trimmed);
  if (header) {
    state.section = header[1]?.trim() ?? "";
    state.seen ||= state.section === "mcp_servers.tdmcp";
    return true;
  }
  const relevant =
    state.section === "mcp_servers.tdmcp" || state.section === "mcp_servers.tdmcp.env";
  if (!relevant) return true;
  const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(trimmed);
  if (!assignment?.[1] || !assignment[2]) return false;
  return applyCodexAssignment(state, assignment[1], assignment[2]);
}

function codexClientEntry(raw: string): ClientEntry | "invalid" | null {
  const state: CodexTomlState = { section: "", seen: false, entry: { env: {} } };
  for (const line of raw.split(/\r?\n/u)) {
    if (!applyCodexTomlLine(state, line)) return "invalid";
  }
  return state.seen ? state.entry : null;
}

function registrationObservation(
  target: (typeof CLIENT_TARGETS)[number],
  path: string,
  config: RuntimeEffectiveConfig,
): RuntimeClientAdapterObservation {
  const { client, scope } = target;
  const file = boundedRegularFile(path);
  if (file.state === "missing") {
    return {
      client,
      scope,
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    };
  }
  if (file.state === "invalid") {
    return {
      client,
      scope,
      registration: "invalid",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "unknown",
    };
  }
  const entry = client === "codex" ? codexClientEntry(file.raw) : jsonClientEntry(file.raw);
  if (entry === "invalid") {
    return {
      client,
      scope,
      registration: "invalid",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "unknown",
    };
  }
  if (entry === null) {
    return {
      client,
      scope,
      registration: "not_registered",
      command_matches: null,
      endpoint_matches: null,
      token_presence: "absent",
    };
  }
  const host = typeof entry.env?.TDMCP_TD_HOST === "string" ? entry.env.TDMCP_TD_HOST : "127.0.0.1";
  const port = typeof entry.env?.TDMCP_TD_PORT === "string" ? entry.env.TDMCP_TD_PORT : "9980";
  const endpoint = `http://${host}:${port}`;
  return {
    client,
    scope,
    registration: "registered",
    command_matches: entry.command === "tdmcp",
    endpoint_matches: endpoint === config.bridge_endpoint,
    token_presence:
      typeof entry.env?.TDMCP_BRIDGE_TOKEN === "string" && entry.env.TDMCP_BRIDGE_TOKEN.length > 0
        ? "configured"
        : "absent",
  };
}

function readClients(
  config: RuntimeEffectiveConfig,
  options: RuntimeAdapterOptions,
): RuntimeClientAdapterObservation[] {
  const home = resolve(options.homeDir ?? homedir());
  const project = resolve(options.cwd ?? process.cwd());
  return CLIENT_TARGETS.map((target) =>
    registrationObservation(target, clientTargetPath(target, project, home), config),
  );
}

function clientTargetPath(
  target: (typeof CLIENT_TARGETS)[number],
  project: string,
  home: string,
): string {
  if (target.scope === "project") {
    return target.client === "claude"
      ? join(project, ".mcp.json")
      : join(project, ".cursor", "mcp.json");
  }
  if (target.client === "claude") return join(home, ".claude.json");
  if (target.client === "cursor") return join(home, ".cursor", "mcp.json");
  return join(home, ".codex", "config.toml");
}

export function createRuntimeStatusDeps(options: RuntimeAdapterOptions = {}): RuntimeStatusDeps {
  return {
    readConfig: (input) => effectiveConfig(input, options),
    readSkills: () => readSkills(options),
    readClients: (config) => readClients(config, options),
    expectedBridgeVersion: getVersion(),
  };
}

export const runtimeStatusAdapterInternals = {
  effectiveConfig,
  readSkills,
  readClients,
  jsonClientEntry,
  codexClientEntry,
} as const;
