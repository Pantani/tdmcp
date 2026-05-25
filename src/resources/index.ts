import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGlslPatternResource } from "./glslPatternResource.js";
import { registerOperatorResource } from "./operatorResource.js";
import { registerPatternResource } from "./patternResource.js";
import { registerPythonApiResource } from "./pythonApiResource.js";
import { registerRecipeResource } from "./recipeResource.js";
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
}

export type { ResourceContext } from "./shared.js";
