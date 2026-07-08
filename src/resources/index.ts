import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCheatsheetResource } from "./cheatsheetResource.js";
import { registerCommandCatalogResource } from "./commandCatalogResource.js";
import {
  registerOperatorCompatibilityResource,
  registerPythonApiCompatibilityResource,
} from "./compatibilityResource.js";
import { registerCookbookResource } from "./cookbookResource.js";
import { registerCreativeRagResource } from "./creativeRagResource.js";
import { registerExperimentalTechniqueResource } from "./experimentalTechniqueResource.js";
import { registerGlslPatternResource } from "./glslPatternResource.js";
import { registerGlslSnippetCatalogResource } from "./glslSnippetCatalogResource.js";
import { registerGraphDigestResource } from "./graphDigest.js";
import { registerOperatorConnectionsResource } from "./operatorConnectionsResource.js";
import { registerOperatorExamplesResource } from "./operatorExamplesResource.js";
import { registerOperatorResource } from "./operatorResource.js";
import { registerPatternResource } from "./patternResource.js";
import { registerProjectRagResource } from "./projectRagResource.js";
import { registerProjectRagSourcesResource } from "./projectRagSourcesResource.js";
import { registerPromptCatalogResource } from "./promptCatalogResource.js";
import { registerPythonApiResource } from "./pythonApiResource.js";
import { registerRaytkOperatorCatalogResource } from "./raytkOperatorCatalog.js";
import { registerRecipeResource } from "./recipeResource.js";
import { registerSceneSummaryResource } from "./sceneSummary.js";
import { registerSessionProfileResource } from "./sessionProfile.js";
import type { ResourceContext } from "./shared.js";
import { registerTdClassResource } from "./tdClassResource.js";
import { registerTdVersionResource } from "./tdVersionResource.js";
import { registerTechniquePackResource } from "./techniquePackResource.js";
import { registerTouchDesignerLearningResource } from "./touchDesignerLearningResource.js";
import { registerTutorialResource } from "./tutorialResource.js";

/** Registers every MCP resource (knowledge base) against the server. */
export function registerAllResources(server: McpServer, ctx: ResourceContext): void {
  registerCheatsheetResource(server, ctx);
  registerOperatorResource(server, ctx);
  registerOperatorConnectionsResource(server, ctx);
  registerOperatorExamplesResource(server, ctx);
  registerPythonApiResource(server, ctx);
  registerOperatorCompatibilityResource(server, ctx);
  registerPythonApiCompatibilityResource(server, ctx);
  registerPatternResource(server, ctx);
  registerGlslPatternResource(server, ctx);
  registerGlslSnippetCatalogResource(server, ctx);
  // RayTK integration (Wave W2) — native raymarching/SDF toolkit operator catalog:
  registerRaytkOperatorCatalogResource(server, ctx);
  registerTechniquePackResource(server, ctx);
  registerTdClassResource(server, ctx);
  registerTdVersionResource(server, ctx);
  registerExperimentalTechniqueResource(server, ctx);
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
  // Creative RAG (opt-in) — read-only repertoire resources; no-op unless ctx.creativeRag is set:
  registerCreativeRagResource(server, ctx);
  // Project RAG (opt-in, F0 foundations) — no-op unless ctx.projectRag is set:
  registerProjectRagResource(server, ctx);
  // Project RAG F4 — sources status resource (no-op unless ctx.projectRag is set):
  registerProjectRagSourcesResource(server, ctx);
}

export type { ResourceContext } from "./shared.js";
