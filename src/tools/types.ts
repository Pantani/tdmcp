import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { Logger } from "../utils/logger.js";

/** Shared dependencies injected into every tool handler (keeps handlers testable). */
export interface ToolContext {
  client: TouchDesignerClient;
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
}

/** A function that registers one tool against the MCP server. */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;
