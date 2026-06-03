import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCheatsheetResource } from "./cheatsheetResource.js";
import { registerCommandCatalogResource } from "./commandCatalogResource.js";
import { registerCookbookResource } from "./cookbookResource.js";
import { registerGlslPatternResource } from "./glslPatternResource.js";
import { registerGlslSnippetCatalogResource } from "./glslSnippetCatalogResource.js";
import { registerGraphDigestResource } from "./graphDigest.js";
import { registerOperatorResource } from "./operatorResource.js";
import { registerPatternResource } from "./patternResource.js";
import { registerPromptCatalogResource } from "./promptCatalogResource.js";
import { registerPythonApiResource } from "./pythonApiResource.js";
import { registerRecipeResource } from "./recipeResource.js";
import { registerSceneSummaryResource } from "./sceneSummary.js";
import { registerSessionProfileResource } from "./sessionProfile.js";
import type { ResourceContext } from "./shared.js";
import { registerTouchDesignerLearningResource } from "./touchDesignerLearningResource.js";
import { registerTutorialResource } from "./tutorialResource.js";

/** Registers every MCP resource (knowledge base) against the server. */
export function registerAllResources(server: McpServer, ctx: ResourceContext): void {
  registerCheatsheetResource(server, ctx);
  registerOperatorResource(server, ctx);
  registerPythonApiResource(server, ctx);
  registerPatternResource(server, ctx);
  registerGlslPatternResource(server, ctx);
  registerGlslSnippetCatalogResource(server, ctx);
  registerRecipeResource(server, ctx);
  registerTutorialResource(server, ctx);
  registerCookbookResource(server, ctx);
  registerCommandCatalogResource(server, ctx);
  registerPromptCatalogResource(server, ctx);
  registerTouchDesignerLearningResource(server, ctx);
  registerSessionProfileResource(server, ctx);
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerSceneSummaryResource(server, ctx);
  // Wave 2026-06-02 — compact, token-bounded graph digest:
  registerGraphDigestResource(server, ctx);
}

export type { ResourceContext } from "./shared.js";
