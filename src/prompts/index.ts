import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAudioToShow } from "./audioToShow.js";
import { registerAutoFix } from "./autoFix.js";
import { registerBeatReactiveDesigner } from "./beatReactiveDesigner.js";
import { registerCritiqueVisual } from "./critiqueVisual.js";
import { registerDebugNetwork } from "./debugNetwork.js";
import { registerExplainNetwork } from "./explainNetwork.js";
import { registerFixShader } from "./fixShader.js";
import { registerImageToVisual } from "./imageToVisual.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerRemixVisual } from "./remixVisual.js";
import { registerStyleReference } from "./styleReference.js";
import { registerTextToRecipe } from "./textToRecipe.js";
import { registerTextToShader } from "./textToShader.js";
import { registerTweakVisual } from "./tweakVisual.js";
import type { PromptContext } from "./types.js";
import { registerVisualArtistMode } from "./visualArtistMode.js";
import { registerVjSetBuilder } from "./vjSetBuilder.js";

/** Registers every MCP prompt against the server. */
export function registerAllPrompts(server: McpServer, ctx: PromptContext): void {
  registerVisualArtistMode(server, ctx);
  registerDebugNetwork(server, ctx);
  registerOptimizePerformance(server, ctx);
  registerExplainNetwork(server, ctx);
  registerRemixVisual(server, ctx);
  registerBeatReactiveDesigner(server, ctx);
  registerImageToVisual(server, ctx);
  registerTweakVisual(server, ctx);
  registerCritiqueVisual(server, ctx);
  registerVjSetBuilder(server, ctx);
  registerFixShader(server, ctx);
  registerTextToShader(server, ctx);
  registerAudioToShow(server, ctx);
  registerAutoFix(server, ctx);
  registerTextToRecipe(server, ctx);
  registerStyleReference(server, ctx);
}

export type { PromptContext } from "./types.js";
