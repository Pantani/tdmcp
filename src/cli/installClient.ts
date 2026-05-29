import { getVersion } from "../utils/version.js";

const CLIENTS = new Set(["claude", "codex", "cursor"]);

export function installClientSnippet(client: string): object {
  const command = "tdmcp";
  const server = {
    command,
    args: [],
    env: {
      TDMCP_TD_HOST: "127.0.0.1",
      TDMCP_TD_PORT: "9980",
    },
  };
  if (client === "codex") {
    return { client, mcp_servers: { tdmcp: server } };
  }
  if (client === "cursor") {
    return { client, mcpServers: { tdmcp: server } };
  }
  return { client, mcpServers: { tdmcp: server } };
}

const HELP = `tdmcp install-client <claude|codex|cursor>

Print a ready-to-paste MCP client configuration snippet for tdmcp ${getVersion()}.
This command does not overwrite client config files.`;

export async function runInstallClient(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const client = argv[0]?.toLowerCase() ?? "";
  if (!CLIENTS.has(client)) {
    process.stderr.write(`Unknown client "${argv[0]}". Expected claude, codex, or cursor.\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(installClientSnippet(client), null, 2)}\n`);
}
