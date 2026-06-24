import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { CreativeRagService } from "../creativeRag/index.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { ProjectRagService } from "../projectRag/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { Logger } from "../utils/logger.js";

export interface ResourceContext {
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
  /** Optional TD client — present for live-scene resources (Campaign BEYOND Wave 3). */
  client?: TouchDesignerClient;
  /** Optional local Creative RAG service — present only when `TDMCP_RAG_ENABLED=1`. */
  creativeRag?: CreativeRagService;
  /**
   * Optional local Project RAG service — present only when
   * `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`. Backs the read-only
   * `tdmcp://project/*` resources.
   */
  projectRag?: ProjectRagService;
}

export type ResourceRegistrar = (server: McpServer, ctx: ResourceContext) => void;

/** URI template variables may be string or string[]; this returns the first scalar. */
export function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function decodeResourceValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function jsonContents(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) },
    ],
  };
}
