import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { Logger } from "../utils/logger.js";

export interface ResourceContext {
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
}

export type ResourceRegistrar = (server: McpServer, ctx: ResourceContext) => void;

/** URI template variables may be string or string[]; this returns the first scalar. */
export function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function jsonContents(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) },
    ],
  };
}

export function textContents(
  uri: URL,
  text: string,
  mimeType = "text/markdown",
): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType, text }] };
}
