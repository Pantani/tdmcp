import { parseArgs } from "node:util";
import type { LoadConfigOptions } from "../utils/config.js";

export interface ServeArgsResult {
  showHelp: boolean;
  loadOptions?: LoadConfigOptions;
  error?: string;
}

export type ServeInvocation =
  | { kind: "serve"; argv: string[] }
  | { kind: "error"; message: string };

export function renderServeHelp(): string {
  return [
    "Usage: tdmcp serve [--http] [--port <port>] [--profile <name>] [--config <path>]",
    "",
    "Starts the MCP server. Without flags, the configured transport is used.",
    "",
    "Flags:",
    "  --http              Start Streamable HTTP on loopback.",
    "  --port <port>       HTTP transport port (implies only the port override).",
    "  --profile <name>    Use a named profile from tdmcp.json.",
    "  --config <path>     Use a specific config file.",
    "  --help, -h          Show this help.",
  ].join("\n");
}

export function resolveServeInvocation(argv: string[]): ServeInvocation {
  if (argv.length === 0) return { kind: "serve", argv: [] };
  const command = argv[0];
  if (command === "serve") return { kind: "serve", argv: argv.slice(1) };
  if (command?.startsWith("-")) return { kind: "serve", argv };
  return {
    kind: "error",
    message: `Unknown command "${command}". Run \`tdmcp --help\` for available commands.`,
  };
}

export function parseServeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeArgsResult {
  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        http: { type: "boolean", default: false },
        port: { type: "string" },
        profile: { type: "string" },
        config: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });

    if (values.help) return { showHelp: true };

    const overrides: LoadConfigOptions["overrides"] = {};
    if (values.http) overrides.transport = "http";
    if (typeof values.port === "string") overrides.httpPort = values.port;

    return {
      showHelp: false,
      loadOptions: {
        useFiles: true,
        profile: typeof values.profile === "string" ? values.profile : env.TDMCP_PROFILE,
        configPath: typeof values.config === "string" ? values.config : undefined,
        overrides,
      },
    };
  } catch (err) {
    return { showHelp: false, error: (err as Error).message };
  }
}
