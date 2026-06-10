import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cliRegistrars } from "./cli/index.js";
import { registerToolRegistrars, runtimeToolRegistrars } from "./registry.js";
import type { ToolContext } from "./types.js";

/** Registers every tool (all layers) against the MCP server, honoring the profile. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerToolRegistrars(server, ctx, [...runtimeToolRegistrars, ...cliRegistrars]);
}

export type { ToolContext, ToolRegistrar } from "./types.js";
