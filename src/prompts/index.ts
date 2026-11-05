import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeScreenshot } from "./analyzeScreenshot.js";
import { registerAudioToShow } from "./audioToShow.js";
import { registerAutoFix } from "./autoFix.js";
import { registerAutoVjDirector } from "./autoVjDirector.js";
import { registerBeatReactiveDesigner } from "./beatReactiveDesigner.js";
import { registerColorStory } from "./colorStory.js";
import { registerCreativeInspiration } from "./creativeInspiration.js";
import { registerCritiqueVisual } from "./critiqueVisual.js";
import { registerDebugNetwork } from "./debugNetwork.js";
// Campaign Wave 6 — AI & LLM (backlog 2026-05-29):
import { registerDesignBrief } from "./designBrief.js";
import { registerExplainNetwork } from "./explainNetwork.js";
import { registerExplainParam } from "./explainParam.js";
import { registerFixReactivity } from "./fixReactivity.js";
import { registerFixShader } from "./fixShader.js";
import { registerGenreVisualLanguage } from "./genreVisualLanguage.js";
import { registerImageToVisual } from "./imageToVisual.js";
import { registerLyricShow } from "./lyricShow.js";
import { registerMatchReferenceLoop } from "./matchReferenceLoop.js";
import { registerMotionCritique } from "./motionCritique.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerProjectRagContext } from "./projectRagContext.js";
import { registerRecoverShow } from "./recoverShow.js";
import { registerRemixVisual } from "./remixVisual.js";
import { registerSetlistPlanner } from "./setlistPlanner.js";
import { registerSongToShow } from "./songToShow.js";
import { registerStyleReference } from "./styleReference.js";
import { registerTeachTouchDesigner } from "./teachTouchDesigner.js";
import { registerTextToRecipe } from "./textToRecipe.js";
import { registerTextToShader } from "./textToShader.js";
import { registerTweakVisual } from "./tweakVisual.js";
import type { PromptContext } from "./types.js";
import { registerVisualAbCompare } from "./visualAbCompare.js";
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
  registerAnalyzeScreenshot(server, ctx);
  registerVjSetBuilder(server, ctx);
  registerFixShader(server, ctx);
  registerTextToShader(server, ctx);
  registerAudioToShow(server, ctx);
  registerAutoFix(server, ctx);
  registerTextToRecipe(server, ctx);
  registerStyleReference(server, ctx);
  // Phase 14 — live-operation diagnostics:
  registerFixReactivity(server, ctx);
  registerRecoverShow(server, ctx);
  registerAutoVjDirector(server, ctx);
  // Phase 14 — creative direction & critique:
  registerColorStory(server, ctx);
  registerSetlistPlanner(server, ctx);
  registerExplainParam(server, ctx);
  registerVisualAbCompare(server, ctx);
  registerLyricShow(server, ctx);
  registerSongToShow(server, ctx);
  registerGenreVisualLanguage(server, ctx);
  // Campaign Wave 6 — AI & LLM (backlog 2026-05-29):
  registerTeachTouchDesigner(server, ctx);
  registerDesignBrief(server, ctx);
  registerMotionCritique(server, ctx);
  registerMatchReferenceLoop(server, ctx);
  // v0.6.0 — Creative RAG mood-board prompt:
  registerCreativeInspiration(server, ctx);
  // Project RAG F4 — local-repertoire context injection (no-op unless ctx.projectRag set):
  registerProjectRagContext(server, ctx);
}

export type { PromptContext } from "./types.js";
