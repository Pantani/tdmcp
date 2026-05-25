import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { layer1Registrars } from "./layer1/index.js";
import { layer2Registrars } from "./layer2/index.js";
import { layer3Registrars } from "./layer3/index.js";
import type { ToolContext } from "./types.js";

/** Registers every tool (all layers) against the MCP server. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  const registrars = [...layer3Registrars, ...layer2Registrars, ...layer1Registrars];
  for (const register of registrars) register(server, ctx);
}

export type { ToolContext, ToolRegistrar } from "./types.js";
