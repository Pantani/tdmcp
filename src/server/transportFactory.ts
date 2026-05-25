import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TdmcpConfig } from "../utils/config.js";
import type { Logger } from "../utils/logger.js";

/**
 * Connects the MCP server to a transport based on config.
 *
 * `stdio` is the default and only fully-wired transport in this build. The
 * `http` branch is reserved for a future Streamable HTTP transport and currently
 * exits with a clear message rather than starting a half-working server.
 */
export async function startTransport(
  server: McpServer,
  config: TdmcpConfig,
  logger: Logger,
): Promise<void> {
  if (config.transport === "http") {
    throw new Error(
      "TDMCP_TRANSPORT=http is not yet wired in this build. Run with stdio (the default) for now.",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("tdmcp connected over stdio", { tdHost: config.tdHost, tdPort: config.tdPort });
}
