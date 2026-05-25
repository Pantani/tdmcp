import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDebugNetwork } from "./debugNetwork.js";
import { registerExplainNetwork } from "./explainNetwork.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerRemixVisual } from "./remixVisual.js";
import type { PromptContext } from "./types.js";
import { registerVisualArtistMode } from "./visualArtistMode.js";

/** Registers every MCP prompt against the server. */
export function registerAllPrompts(server: McpServer, ctx: PromptContext): void {
  registerVisualArtistMode(server, ctx);
  registerDebugNetwork(server, ctx);
  registerOptimizePerformance(server, ctx);
  registerExplainNetwork(server, ctx);
  registerRemixVisual(server, ctx);
}

export type { PromptContext } from "./types.js";
