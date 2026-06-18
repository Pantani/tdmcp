import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreativeRagService } from "../creativeRag/types.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { ProjectRagService } from "../projectRag/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { Logger } from "../utils/logger.js";

export interface PromptContext {
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
  creativeRag?: CreativeRagService;
  /**
   * Optional local Project RAG service — present only when
   * `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`. Backs the
   * `project_rag_context` prompt.
   */
  projectRag?: ProjectRagService;
}

export type PromptRegistrar = (server: McpServer, ctx: PromptContext) => void;

/** Builds a single user-message prompt result. */
export function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}
