import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, type TdmcpConfig } from "../utils/config.js";
import { getVersion } from "../utils/version.js";
import {
  buildTdmcpStdioServer,
  type ClientRegistrationAction,
  type ClientRegistrationClient,
  type ClientRegistrationResult,
  manageClientRegistration,
  renderClientRegistrationSnippet,
  SUPPORTED_CLIENTS,
} from "./clientRegistration.js";

const CLIENTS = new Set<string>(SUPPORTED_CLIENTS);
type Client = ClientRegistrationClient;

function defaultServer(token?: string) {
  return buildTdmcpStdioServer({ host: "127.0.0.1", port: 9980, token });
}

export function installClientSnippet(client: string, token?: string): object | string {
  return renderClientRegistrationSnippet(client as Client, "tdmcp", defaultServer(token));
}

export async function writeInstallClientConfig(
  client: Client,
  configPath: string,
  token?: string,
): Promise<Record<string, unknown> | string> {
  const result = await manageClientRegistration({
    client,
    explicitPath: configPath,
    action: "install",
    server: defaultServer(token),
    write: true,
  });
  const raw = await readFile(result.path, "utf8");
  return client === "codex" ? raw : (JSON.parse(raw) as Record<string, unknown>);
}

const HELP = `tdmcp install-client <claude|codex|cursor> [options]

Print or safely reconcile an MCP client registration for tdmcp ${getVersion()}.

Targets:
  --scope <project|user>    Resolve the host-native config target.
  --project-dir <dir>      Required for project scope.
  --path <file>             Legacy explicit client config target.
  --name <name>             Named MCP entry (default: tdmcp).
  --profile <name>          Resolve TD host/port from a tdmcp config profile.
  --config <file>           Explicit tdmcp config source.

Actions:
  --check                   Report absent, matching, or drifted; never writes.
  --diff                    Show redacted changed field names; never writes.
  --remove                  Plan removal of only the named entry.
  --dry-run                 Explicitly prevent writes.
  --write                   Apply install/removal atomically after verification.
  --json                    Emit a structured result.

Without target/action options this command preserves the legacy ready-to-paste snippet.`;

interface ParsedArgs {
  client: string;
  write: boolean;
  dryRun: boolean;
  diff: boolean;
  check: boolean;
  remove: boolean;
  json: boolean;
  configPath?: string;
  explicitPath?: string;
  token?: string;
  scope?: string;
  projectDir?: string;
  name?: string;
  profile?: string;
}

type ParseResult =
  | { kind: "help" }
  | { kind: "run"; args: ParsedArgs }
  | { kind: "error"; message: string };

function parseInstallClientArgs(argv: string[]): ParseResult {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        write: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        diff: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        remove: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        path: { type: "string" },
        token: { type: "string" },
        scope: { type: "string" },
        "project-dir": { type: "string" },
        name: { type: "string" },
        profile: { type: "string" },
        config: { type: "string" },
      },
    });
    const client = parsed.positionals[0]?.toLowerCase() ?? "";
    const positionalPath = parsed.positionals[1];
    if (parsed.positionals.length > 2) {
      return { kind: "error", message: `Unexpected argument "${parsed.positionals[2]}".` };
    }
    return {
      kind: "run",
      args: {
        client,
        write: parsed.values.write ?? false,
        dryRun: parsed.values["dry-run"] ?? false,
        diff: parsed.values.diff ?? false,
        check: parsed.values.check ?? false,
        remove: parsed.values.remove ?? false,
        json: parsed.values.json ?? false,
        explicitPath: parsed.values.path ?? positionalPath,
        token: parsed.values.token,
        scope: parsed.values.scope,
        projectDir: parsed.values["project-dir"],
        name: parsed.values.name,
        profile: parsed.values.profile,
        configPath: parsed.values.config,
      },
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

type ArgsValidator = (args: ParsedArgs) => string | undefined;

const validateClient: ArgsValidator = (args) =>
  CLIENTS.has(args.client)
    ? undefined
    : `Unknown client "${args.client || "(missing)"}". Expected claude, codex, or cursor.`;

const validateScope: ArgsValidator = (args) => {
  if (args.scope !== undefined && args.scope !== "project" && args.scope !== "user") {
    return "--scope must be project or user.";
  }
  if (args.scope === "project" && !args.projectDir) return "Project scope requires --project-dir.";
  if (args.scope !== "project" && args.projectDir) {
    return "--project-dir is only valid with --scope project.";
  }
  return undefined;
};

const validateActionCombination: ArgsValidator = (args) => {
  if (args.write && (args.dryRun || args.diff || args.check)) {
    return "--write cannot be combined with --dry-run, --diff, or --check.";
  }
  if (args.check && args.remove) return "--check cannot be combined with --remove.";
  return undefined;
};

const validateTargetSelection: ArgsValidator = (args) => {
  const targetsConfig = Boolean(args.explicitPath || args.scope || args.projectDir);
  const selectsAction = args.write || args.dryRun || args.diff || args.check || args.remove;
  if (selectsAction && !targetsConfig) {
    return "Scoped/check/remove operations require --scope <project|user> or legacy --path <file>.";
  }
  return undefined;
};

function validateArgs(args: ParsedArgs): string | undefined {
  const validators: ArgsValidator[] = [
    validateClient,
    validateScope,
    validateActionCombination,
    validateTargetSelection,
  ];
  for (const validate of validators) {
    const error = validate(args);
    if (error) return error;
  }
  return undefined;
}

function isLegacySnippet(args: ParsedArgs): boolean {
  return !(
    args.write ||
    args.dryRun ||
    args.diff ||
    args.check ||
    args.remove ||
    args.explicitPath ||
    args.scope ||
    args.projectDir ||
    args.profile ||
    args.configPath ||
    args.name ||
    args.json
  );
}

function isLegacyExplicitWrite(args: ParsedArgs): boolean {
  return Boolean(
    args.write &&
      args.explicitPath &&
      !args.scope &&
      !args.projectDir &&
      !args.diff &&
      !args.check &&
      !args.remove &&
      !args.dryRun &&
      !args.json &&
      !args.name &&
      !args.profile &&
      !args.configPath,
  );
}

function registrationAction(args: ParsedArgs): ClientRegistrationAction {
  if (args.check) return "check";
  if (args.remove) return "remove";
  return "install";
}

function renderHuman(result: ClientRegistrationResult): string {
  const fields = result.fields_changed.length > 0 ? result.fields_changed.join(", ") : "none";
  return [
    `Client registration ${result.state}: ${result.client}/${result.scope}/${result.name}`,
    `Target: ${result.path}`,
    `Changed fields: ${fields}`,
    `Token: ${result.token_presence}`,
  ].join("\n");
}

function inputFailureCode(message: string): number {
  return /requires|only valid|cannot be combined|not supported|registration name/.test(message)
    ? 2
    : 1;
}

export async function runInstallClient(argv: string[] = []): Promise<void> {
  const parsed = parseInstallClientArgs(argv);
  if (handleNonRunResult(parsed)) return;
  await runParsedInstallClient(parsed.args);
}

function handleNonRunResult(parsed: ParseResult): parsed is Exclude<ParseResult, { kind: "run" }> {
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return true;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 2;
    return true;
  }
  return false;
}

async function runParsedInstallClient(args: ParsedArgs): Promise<void> {
  const error = validateArgs(args);
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 2;
    return;
  }
  const client = args.client as Client;
  if (isLegacySnippet(args)) {
    const snippet = installClientSnippet(client, args.token);
    process.stdout.write(
      typeof snippet === "string" ? `${snippet}\n` : `${JSON.stringify(snippet, null, 2)}\n`,
    );
    return;
  }
  const config = loadRegistrationConfig(args);
  if (!config) return;
  await executeRegistration(args, client, config);
}

function loadRegistrationConfig(args: ParsedArgs): TdmcpConfig | undefined {
  try {
    return loadConfig(process.env, {
      useFiles: true,
      profile: args.profile,
      configPath: args.configPath,
      cwd: args.projectDir ?? process.cwd(),
    });
  } catch (loadError) {
    process.stderr.write(`${loadError instanceof Error ? loadError.message : String(loadError)}\n`);
    process.exitCode = 2;
    return undefined;
  }
}

async function executeRegistration(
  args: ParsedArgs,
  client: Client,
  config: TdmcpConfig,
): Promise<void> {
  try {
    const result = await manageClientRegistration({
      client,
      scope: args.scope as "project" | "user" | undefined,
      projectDir: args.projectDir,
      explicitPath: args.explicitPath,
      name: args.name,
      action: registrationAction(args),
      server: buildTdmcpStdioServer({
        host: config.tdHost,
        port: config.tdPort,
        token: args.token ?? config.bridgeToken,
      }),
      write: args.write,
    });
    if (isLegacyExplicitWrite(args)) {
      process.stdout.write(`Wrote ${result.path}\n`);
      return;
    }
    process.stdout.write(
      args.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderHuman(result)}\n`,
    );
  } catch (registrationError) {
    const message =
      registrationError instanceof Error ? registrationError.message : String(registrationError);
    process.stderr.write(`${message}\n`);
    process.exitCode = inputFailureCode(message);
  }
}
