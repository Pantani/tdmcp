import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KnowledgeBase } from "../knowledge/index.js";
import { registerAllPrompts } from "../prompts/index.js";
import { RecipeLibrary } from "../recipes/loader.js";
import { registerAllResources } from "../resources/index.js";
import { registerAllTools } from "../tools/index.js";
import type { TdmcpConfig } from "../utils/config.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { getVersion } from "../utils/version.js";
import { ConnectionManager } from "./connectionManager.js";

const INSTRUCTIONS = `tdmcp lets you build visual systems in TouchDesigner.

Workflow:
1. Call get_td_info first to confirm the bridge is reachable.
2. Consult the knowledge base resources (tdmcp://operators/..., tdmcp://recipes/...) before creating nodes — never invent operator types.
3. Build with the highest-level tool that fits, dropping to Layer 2/3 for fine control.
4. After building, check get_td_node_errors and capture get_preview so the artist can see the result.

The server stays usable even when TouchDesigner is offline; tools return a friendly error in that case.`;

export interface TdmcpServerOverrides {
  logger?: Logger;
  knowledge?: KnowledgeBase;
  recipes?: RecipeLibrary;
  connection?: ConnectionManager;
}

/** Builds a fully wired (but not yet connected) MCP server. */
export function createTdmcpServer(
  config: TdmcpConfig,
  overrides: TdmcpServerOverrides = {},
): McpServer {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const connection = overrides.connection ?? new ConnectionManager(config, logger);
  const knowledge = overrides.knowledge ?? new KnowledgeBase({ logger });
  const recipes = overrides.recipes ?? new RecipeLibrary({ logger });

  const server = new McpServer(
    { name: "tdmcp", version: getVersion() },
    { instructions: INSTRUCTIONS },
  );

  registerAllTools(server, { client: connection.client, knowledge, recipes, logger });
  registerAllResources(server, { knowledge, recipes, logger });
  registerAllPrompts(server, { knowledge, recipes, logger });

  logger.info("tdmcp server initialized", {
    version: getVersion(),
    knowledge: knowledge.stats(),
    recipes: recipes.list().length,
  });

  return server;
}
