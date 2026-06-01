import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getVersion } from "../utils/version.js";

const SUPPORTED_CLIENTS = ["claude", "codex", "cursor"] as const;
const CLIENTS = new Set<string>(SUPPORTED_CLIENTS);
type Client = (typeof SUPPORTED_CLIENTS)[number];

function tdmcpServerConfig(): object {
  return {
    command: "tdmcp",
    args: [],
    env: {
      TDMCP_TD_HOST: "127.0.0.1",
      TDMCP_TD_PORT: "9980",
    },
  };
}

function installClientConfig(client: string): Record<string, unknown> {
  const server = tdmcpServerConfig();
  if (client === "codex") {
    return { mcp_servers: { tdmcp: server } };
  }
  return { mcpServers: { tdmcp: server } };
}

function codexTomlSnippet(): string {
  return [
    "[mcp_servers.tdmcp]",
    'command = "tdmcp"',
    "args = []",
    "",
    "[mcp_servers.tdmcp.env]",
    'TDMCP_TD_HOST = "127.0.0.1"',
    'TDMCP_TD_PORT = "9980"',
  ].join("\n");
}

export function installClientSnippet(client: string): object | string {
  if (client === "codex") return codexTomlSnippet();
  return installClientConfig(client);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeConfig(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = deepMergeConfig(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readExistingJsonConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return {};
    }
    throw new Error(`Failed to read ${configPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid JSON in ${configPath}: expected a top-level object.`);
  }
  return parsed;
}

async function readExistingTextConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "";
    throw new Error(`Failed to read ${configPath}: ${errorMessage(error)}`);
  }
}

function tomlSectionName(line: string): string | undefined {
  const match = line.trim().match(/^\[([^\]]+)\]$/);
  return match?.[1]?.trim();
}

function withoutCodexTdmcpServer(raw: string): string {
  const kept: string[] = [];
  let skip = false;
  for (const line of raw.split(/\r?\n/)) {
    const section = tomlSectionName(line);
    if (section !== undefined) {
      skip = section === "mcp_servers.tdmcp" || section.startsWith("mcp_servers.tdmcp.");
    }
    if (!skip) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

async function writeCodexConfig(configPath: string): Promise<string> {
  const existing = await readExistingTextConfig(configPath);
  const preserved = withoutCodexTdmcpServer(existing);
  const serialized = `${preserved ? `${preserved}\n\n` : ""}${codexTomlSnippet()}\n`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serialized, "utf8");

  const verified = await readFile(configPath, "utf8");
  if (!verified.includes("[mcp_servers.tdmcp]")) {
    throw new Error(`Failed to verify ${configPath}: missing [mcp_servers.tdmcp].`);
  }
  if (!verified.includes("[mcp_servers.tdmcp.env]")) {
    throw new Error(`Failed to verify ${configPath}: missing [mcp_servers.tdmcp.env].`);
  }
  return verified;
}

export async function writeInstallClientConfig(
  client: Client,
  configPath: string,
): Promise<Record<string, unknown> | string> {
  if (client === "codex") return writeCodexConfig(configPath);

  const existing = await readExistingJsonConfig(configPath);
  const merged = deepMergeConfig(existing, installClientConfig(client));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serialized, "utf8");

  const verified = JSON.parse(await readFile(configPath, "utf8"));
  if (!isPlainObject(verified)) {
    throw new Error(`Failed to verify ${configPath}: expected a top-level object.`);
  }
  return verified;
}

const HELP = `tdmcp install-client <claude|codex|cursor> [--write --path <file>]

Print a ready-to-paste MCP client configuration snippet for tdmcp ${getVersion()}.
Without --write, this command only prints a snippet and does not modify files.
With --write, it deep-merges Claude/Cursor JSON or Codex TOML into the explicit config file.`;

type ParsedArgs =
  | { kind: "help" }
  | { kind: "run"; client: string; write: boolean; configPath?: string }
  | { kind: "error"; message: string; exitCode: number };

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    return { kind: "help" };
  }

  let client = "";
  let write = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--path") {
      const value = argv[index + 1];
      if (!value) {
        return { kind: "error", message: "--path requires a file path.\n", exitCode: 2 };
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      return { kind: "error", message: `Unknown option "${arg}".\n`, exitCode: 2 };
    }
    if (!client) {
      client = arg?.toLowerCase() ?? "";
      continue;
    }
    if (write && !configPath) {
      configPath = arg;
      continue;
    }
    return { kind: "error", message: `Unexpected argument "${arg}".\n`, exitCode: 2 };
  }

  return { kind: "run", client, write, configPath };
}

export async function runInstallClient(argv: string[] = []): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "error") {
    process.stderr.write(parsed.message);
    process.exitCode = parsed.exitCode;
    return;
  }

  const client = parsed.client;
  if (!CLIENTS.has(client)) {
    process.stderr.write(
      `Unknown client "${client || "(missing)"}". Expected claude, codex, or cursor.\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (!parsed.write) {
    const snippet = installClientSnippet(client);
    process.stdout.write(
      typeof snippet === "string" ? `${snippet}\n` : `${JSON.stringify(snippet, null, 2)}\n`,
    );
    return;
  }

  if (!parsed.configPath) {
    process.stderr.write(
      "--write requires --path <file> or a positional file path after --write.\n",
    );
    process.exitCode = 2;
    return;
  }

  try {
    await writeInstallClientConfig(client as Client, parsed.configPath);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Wrote ${parsed.configPath}\n`);
}
