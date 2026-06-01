import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getVersion } from "../utils/version.js";

const SUPPORTED_CLIENTS = ["claude", "codex", "cursor"] as const;
const CLIENTS = new Set<string>(SUPPORTED_CLIENTS);
type Client = (typeof SUPPORTED_CLIENTS)[number];

function tdmcpServerConfig(): object {
  const command = "tdmcp";
  return {
    command,
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

export function installClientSnippet(client: string): object {
  return { client, ...installClientConfig(client) };
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

export async function writeInstallClientConfig(
  client: Client,
  configPath: string,
): Promise<Record<string, unknown>> {
  const existing = await readExistingJsonConfig(configPath);
  const merged = deepMergeConfig(existing, installClientConfig(client));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  JSON.parse(serialized);
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
Without --write, this command only prints JSON and does not modify files.
With --write, it deep-merges the client config into the explicit JSON file.`;

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
    process.stdout.write(`${JSON.stringify(installClientSnippet(client), null, 2)}\n`);
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
