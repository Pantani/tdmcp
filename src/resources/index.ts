import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGlslPatternResource } from "./glslPatternResource.js";
import { registerOperatorResource } from "./operatorResource.js";
import { registerPatternResource } from "./patternResource.js";
import { registerPromptCatalogResource } from "./promptCatalogResource.js";
import { registerPythonApiResource } from "./pythonApiResource.js";
import { registerRecipeResource } from "./recipeResource.js";
import { registerSceneSummaryResource } from "./sceneSummary.js";
import type { ResourceContext } from "./shared.js";
import { registerTutorialResource } from "./tutorialResource.js";

/** Registers every MCP resource (knowledge base) against the server. */
export function registerAllResources(server: McpServer, ctx: ResourceContext): void {
  registerOperatorResource(server, ctx);
  registerPythonApiResource(server, ctx);
  registerPatternResource(server, ctx);
  registerGlslPatternResource(server, ctx);
  registerRecipeResource(server, ctx);
  registerTutorialResource(server, ctx);
  registerPromptCatalogResource(server, ctx);
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerSceneSummaryResource(server, ctx);
}

export type { ResourceContext } from "./shared.js";
