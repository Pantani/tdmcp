import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CLIENT_REGISTRATION_MAX_BYTES = 1024 * 1024;
export const SUPPORTED_CLIENTS = ["claude", "codex", "cursor"] as const;
export type ClientRegistrationClient = (typeof SUPPORTED_CLIENTS)[number];
export type ClientRegistrationScope = "project" | "user";
export type ClientRegistrationAction = "check" | "install" | "remove";
type ClientRegistrationFormat = "json" | "toml";

export interface TdmcpStdioServer {
  command: "tdmcp";
  args: string[];
  env: Record<string, string>;
}

export interface ResolveClientTargetOptions {
  client: ClientRegistrationClient;
  scope?: ClientRegistrationScope;
  projectDir?: string;
  explicitPath?: string;
  homeDir?: string;
  cwd?: string;
  name?: string;
}

export interface ClientRegistrationTarget {
  client: ClientRegistrationClient;
  scope: ClientRegistrationScope;
  name: string;
  path: string;
  format: ClientRegistrationFormat;
  source: "explicit" | "native";
}

export interface ManageClientRegistrationOptions extends ResolveClientTargetOptions {
  action: ClientRegistrationAction;
  server: TdmcpStdioServer;
  write?: boolean;
}

export interface ManageClientRegistrationDeps {
  beforeWrite?: () => void | Promise<void>;
}

export interface ClientRegistrationResult {
  action: ClientRegistrationAction;
  client: ClientRegistrationClient;
  scope: ClientRegistrationScope;
  name: string;
  path: string;
  state: "absent" | "applied" | "matching" | "planned" | "removed" | "drifted";
  changed: boolean;
  wrote: boolean;
  fields_changed: string[];
  token_presence: "absent" | "present";
}

interface RegistrationPlan {
  currentRaw: string;
  nextRaw: string;
  exists: boolean;
  matching: boolean;
  fieldsChanged: string[];
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertSafeName(value: string | undefined): string {
  const name = value?.trim() || "tdmcp";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "Client registration name must use 1-64 letters, digits, underscores or hyphens.",
    );
  }
  return name;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function assertNoParentTraversal(path: string, label: string): void {
  if (path.split(/[\\/]+/u).includes("..")) {
    throw new Error(`${label} must not contain parent traversal segments.`);
  }
}

function nativeTargetPath(
  client: ClientRegistrationClient,
  scope: ClientRegistrationScope,
  base: string,
): string {
  if (client === "claude")
    return scope === "project" ? join(base, ".mcp.json") : join(base, ".claude.json");
  if (client === "cursor") return join(base, ".cursor", "mcp.json");
  if (scope === "project") {
    throw new Error(
      "Codex project-scoped MCP configuration is not supported by the verified client contract; use user scope or an explicit legacy --path.",
    );
  }
  return join(base, ".codex", "config.toml");
}

export async function resolveClientRegistrationTarget(
  options: ResolveClientTargetOptions,
): Promise<ClientRegistrationTarget> {
  const name = assertSafeName(options.name);
  const cwd = options.cwd ?? process.cwd();
  return options.explicitPath
    ? explicitClientTarget(options, name, cwd)
    : nativeClientTarget(options, name, cwd);
}

function explicitClientTarget(
  options: ResolveClientTargetOptions,
  name: string,
  cwd: string,
): ClientRegistrationTarget {
  if (options.projectDir) {
    throw new Error("An explicit client config path cannot be combined with project_dir.");
  }
  return {
    client: options.client,
    scope: options.scope ?? "user",
    name,
    path: resolve(cwd, options.explicitPath ?? ""),
    format: options.client === "codex" ? "toml" : "json",
    source: "explicit",
  };
}

async function nativeClientTarget(
  options: ResolveClientTargetOptions,
  name: string,
  cwd: string,
): Promise<ClientRegistrationTarget> {
  const scope = options.scope ?? "user";
  const base = await nativeClientBase(options, scope, cwd);
  return {
    client: options.client,
    scope,
    name,
    path: nativeTargetPath(options.client, scope, base),
    format: options.client === "codex" ? "toml" : "json",
    source: "native",
  };
}

async function nativeClientBase(
  options: ResolveClientTargetOptions,
  scope: ClientRegistrationScope,
  cwd: string,
): Promise<string> {
  if (scope === "project") {
    const rawProjectDir = options.projectDir?.trim();
    if (!rawProjectDir) throw new Error("Project client scope requires --project-dir.");
    assertNoParentTraversal(rawProjectDir, "Project directory");
    const projectDir = resolve(cwd, rawProjectDir);
    await assertDirectory(projectDir, "Project directory");
    return projectDir;
  }
  if (options.projectDir) throw new Error("project_dir is only valid with project client scope.");
  const home = resolve(options.homeDir ?? homedir());
  await assertDirectory(home, "User home directory");
  return home;
}

export function buildTdmcpStdioServer(options: {
  host: string;
  port: number;
  token?: string;
}): TdmcpStdioServer {
  const host = options.host.trim();
  if (!host) throw new Error("TouchDesigner host must not be empty.");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("TouchDesigner port must be an integer between 1 and 65535.");
  }
  const env: Record<string, string> = {
    TDMCP_TD_HOST: host,
    TDMCP_TD_PORT: String(options.port),
  };
  if (options.token) env.TDMCP_BRIDGE_TOKEN = options.token;
  return { command: "tdmcp", args: [], env };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function isSubset(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isSubset(value, actual[index]))
    );
  }
  return Object.is(expected, actual);
}

async function readBoundedTarget(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "";
    if (hasCode(error, "ELOOP"))
      throw new Error(`Client config must not be a symbolic link: ${path}`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Client config must be a regular file: ${path}`);
    if (info.size > CLIENT_REGISTRATION_MAX_BYTES) {
      throw new Error(`Client config exceeds ${CLIENT_REGISTRATION_MAX_BYTES} bytes: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseJsonConfig(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid JSON in ${path}: expected an object.`);
  return parsed;
}

function changedFields(server: TdmcpStdioServer, actual: unknown): string[] {
  const fields: string[] = [];
  if (!isPlainObject(actual) || actual.command !== server.command) fields.push("command");
  if (!isPlainObject(actual) || !isSubset(server.args, actual.args)) fields.push("args");
  const actualEnv = isPlainObject(actual) && isPlainObject(actual.env) ? actual.env : {};
  for (const key of Object.keys(server.env).sort()) {
    if (actualEnv[key] !== server.env[key]) fields.push(`env.${key}`);
  }
  return fields;
}

function jsonPlan(
  target: ClientRegistrationTarget,
  raw: string,
  action: ClientRegistrationAction,
  server: TdmcpStdioServer,
): RegistrationPlan {
  const config = parseJsonConfig(raw, target.path);
  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  const actual = servers[target.name];
  const exists = actual !== undefined;
  const fields = exists ? changedFields(server, actual) : ["entry"];
  const matching = exists && fields.length === 0;
  if (action === "check") return checkedPlan(raw, exists, matching, fields);
  const nextServers = nextJsonServers(action, servers, target.name, actual, server);
  const nextRaw = `${JSON.stringify({ ...config, mcpServers: nextServers }, null, 2)}\n`;
  return changedPlan(raw, nextRaw, exists, matching, action, fields);
}

function checkedPlan(
  raw: string,
  exists: boolean,
  matching: boolean,
  fieldsChanged: string[],
): RegistrationPlan {
  return { currentRaw: raw, nextRaw: raw, exists, matching, fieldsChanged };
}

function changedPlan(
  currentRaw: string,
  nextRaw: string,
  exists: boolean,
  matching: boolean,
  action: Exclude<ClientRegistrationAction, "check">,
  fields: string[],
): RegistrationPlan {
  return {
    currentRaw,
    nextRaw,
    exists,
    matching,
    fieldsChanged: action === "remove" ? (exists ? ["entry"] : []) : fields,
  };
}

function nextJsonServers(
  action: Exclude<ClientRegistrationAction, "check">,
  servers: Record<string, unknown>,
  name: string,
  actual: unknown,
  server: TdmcpStdioServer,
): Record<string, unknown> {
  const nextServers = { ...servers };
  if (action === "remove") {
    delete nextServers[name];
    return nextServers;
  }
  const prior = isPlainObject(actual) ? actual : {};
  nextServers[name] = deepMerge(prior, server as unknown as Record<string, unknown>);
  return nextServers;
}

function tomlSectionName(line: string): string | undefined {
  return line
    .trim()
    .match(/^\[([^\]]+)\]$/)?.[1]
    ?.trim();
}

function tomlSectionBelongs(section: string | undefined, name: string): boolean {
  return section === `mcp_servers.${name}` || section?.startsWith(`mcp_servers.${name}.`) === true;
}

function withoutTomlServer(raw: string, name: string): string {
  const kept: string[] = [];
  let skip = false;
  for (const line of raw.split(/\r?\n/)) {
    const section = tomlSectionName(line);
    if (section !== undefined) skip = tomlSectionBelongs(section, name);
    if (!skip) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

function parseTomlLiteral(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

function tomlServer(raw: string, name: string): Record<string, unknown> | undefined {
  const state: TomlServerState = { found: false, server: {}, env: {} };
  for (const line of raw.split(/\r?\n/)) {
    consumeTomlServerLine(state, line, name);
  }
  if (!state.found) return undefined;
  if (Object.keys(state.env).length > 0) state.server.env = state.env;
  return state.server;
}

interface TomlServerState {
  section?: string;
  found: boolean;
  server: Record<string, unknown>;
  env: Record<string, unknown>;
}

function consumeTomlServerLine(state: TomlServerState, line: string, name: string): void {
  const nextSection = tomlSectionName(line);
  if (nextSection !== undefined) {
    state.section = nextSection;
    state.found ||= tomlSectionBelongs(nextSection, name);
    return;
  }
  if (!tomlSectionBelongs(state.section, name)) return;
  const assignment = line.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
  const key = assignment?.[1];
  const value = assignment?.[2];
  if (!key || value === undefined) return;
  const destination = state.section === `mcp_servers.${name}.env` ? state.env : state.server;
  destination[key] = parseTomlLiteral(value);
}

export function renderCodexServer(name: string, server: TdmcpStdioServer): string {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    "",
    `[mcp_servers.${name}.env]`,
  ];
  for (const [key, value] of Object.entries(server.env).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

function tomlPlan(
  target: ClientRegistrationTarget,
  raw: string,
  action: ClientRegistrationAction,
  server: TdmcpStdioServer,
): RegistrationPlan {
  const actual = tomlServer(raw, target.name);
  const exists = actual !== undefined;
  const fields = exists ? changedFields(server, actual) : ["entry"];
  const matching = exists && fields.length === 0;
  if (action === "check") return checkedPlan(raw, exists, matching, fields);
  const preserved = withoutTomlServer(raw, target.name);
  const nextRaw = nextTomlRaw(action, preserved, target.name, server);
  return changedPlan(raw, nextRaw, exists, matching, action, fields);
}

function nextTomlRaw(
  action: Exclude<ClientRegistrationAction, "check">,
  preserved: string,
  name: string,
  server: TdmcpStdioServer,
): string {
  if (action === "remove") return `${preserved}${preserved ? "\n" : ""}`;
  return `${preserved ? `${preserved}\n\n` : ""}${renderCodexServer(name, server)}\n`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertSafeParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Client config parent must be a real directory: ${parent}`);
  }
}

async function atomicWrite(path: string, expectedRaw: string, nextRaw: string): Promise<void> {
  await assertSafeParent(path);
  if (digest(await readBoundedTarget(path)) !== digest(expectedRaw)) {
    throw new Error("Client config changed while the update was being prepared; no write applied.");
  }
  const tempPath = join(dirname(path), `.${basename(path)}.tdmcp-${randomUUID()}.tmp`);
  let promoted = false;
  try {
    const handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(nextRaw, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    promoted = true;
    if ((await readBoundedTarget(path)) !== nextRaw) {
      throw new Error("Client config read-back verification failed after atomic promotion.");
    }
  } finally {
    if (!promoted) await rm(tempPath, { force: true });
  }
}

function resultState(
  action: ClientRegistrationAction,
  plan: RegistrationPlan,
  write: boolean,
): ClientRegistrationResult["state"] {
  if (action === "check") return checkResultState(plan);
  if (action === "remove") return removeResultState(plan, write);
  return installResultState(plan, write);
}

function checkResultState(plan: RegistrationPlan): ClientRegistrationResult["state"] {
  if (!plan.exists) return "absent";
  return plan.matching ? "matching" : "drifted";
}

function removeResultState(
  plan: RegistrationPlan,
  write: boolean,
): ClientRegistrationResult["state"] {
  if (!plan.exists || plan.currentRaw === plan.nextRaw) return "absent";
  return write ? "removed" : "planned";
}

function installResultState(
  plan: RegistrationPlan,
  write: boolean,
): ClientRegistrationResult["state"] {
  if (plan.currentRaw === plan.nextRaw) return "matching";
  return write ? "applied" : "planned";
}

export async function manageClientRegistration(
  options: ManageClientRegistrationOptions,
  deps: ManageClientRegistrationDeps = {},
): Promise<ClientRegistrationResult> {
  const target = await resolveClientRegistrationTarget(options);
  const raw = await readBoundedTarget(target.path);
  const plan =
    target.format === "toml"
      ? tomlPlan(target, raw, options.action, options.server)
      : jsonPlan(target, raw, options.action, options.server);
  const changed = plan.currentRaw !== plan.nextRaw;
  const write = options.write === true && options.action !== "check" && changed;
  if (write) {
    await deps.beforeWrite?.();
    await atomicWrite(target.path, plan.currentRaw, plan.nextRaw);
  }
  return {
    action: options.action,
    client: target.client,
    scope: target.scope,
    name: target.name,
    path: target.path,
    state: resultState(options.action, plan, write),
    changed,
    wrote: write,
    fields_changed: plan.fieldsChanged,
    token_presence: options.server.env.TDMCP_BRIDGE_TOKEN ? "present" : "absent",
  };
}

export function renderClientRegistrationSnippet(
  client: ClientRegistrationClient,
  name: string,
  server: TdmcpStdioServer,
): object | string {
  const safeName = assertSafeName(name);
  if (client === "codex") return renderCodexServer(safeName, server);
  return { mcpServers: { [safeName]: server } };
}
