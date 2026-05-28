import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { Logger } from "../utils/logger.js";
import type { Vault } from "../vault/index.js";

/** Shared dependencies injected into every tool handler (keeps handlers testable). */
export interface ToolContext {
  client: TouchDesignerClient;
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
  /** Optional Obsidian vault (set via TDMCP_VAULT_PATH); undefined when not configured. */
  vault?: Vault;
  /**
   * Whether the raw Python escape-hatch tools may be registered. Undefined means
   * allowed (the default); only an explicit `false` locks them out.
   */
  allowRawPython?: boolean;
  /**
   * Tool exposure profile. `"safe"` hides destructive/raw-code tools.
   * Undefined means `"full"` (the default).
   */
  toolProfile?: "full" | "safe";
}

/** A function that registers one tool against the MCP server. */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;
