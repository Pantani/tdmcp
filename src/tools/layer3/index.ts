import type { ToolRegistrar } from "../types.js";
import { registerAnalyzeProject } from "./analyzeProject.js";
// Campaign Waves 4 & 6 (backlog 2026-05-29):
import { registerCaptionTop } from "./captionTop.js";
import { registerCollectProjectAssets } from "./collectProjectAssets.js";
import { registerCompareTdNodes } from "./compareTdNodes.js";
import { registerControlTimelineTransport } from "./controlTimelineTransport.js";
import { registerCopilotVision } from "./copilotVision.js";
import { registerCreateTdNode } from "./createTdNode.js";
import { registerDeleteTdNode } from "./deleteTdNode.js";
import { registerDiffSnapshots } from "./diffSnapshots.js";
import { registerDisconnectNodes } from "./disconnectNodes.js";
import { registerDocumentNetwork } from "./documentNetwork.js";
import { registerEditDatContent } from "./editDatContent.js";
import { registerElicitMissingArgs } from "./elicitMissingArgs.js";
import { registerEnhanceBuild } from "./enhanceBuild.js";
import { registerExecNodeMethod } from "./execNodeMethod.js";
import { registerExecutePythonScript } from "./executePythonScript.js";
import { registerExportSopToSvg } from "./exportSopToSvg.js";
import { registerExtractPalette } from "./extractPalette.js";
import { registerFindTdNodes } from "./findTdNodes.js";
import { registerGenerateReadme } from "./generateReadme.js";
import { registerGetBridgeLogs } from "./getBridgeLogs.js";
import { registerGetInlinePreview } from "./getInlinePreview.js";
import { registerGetModuleHelp } from "./getModuleHelp.js";
import { registerGetNodeStateRuntime } from "./getNodeStateRuntime.js";
import { registerGetTdClassDetails } from "./getTdClassDetails.js";
import { registerGetTdClasses } from "./getTdClasses.js";
import { registerGetTdInfo } from "./getTdInfo.js";
import { registerGetTdNodeErrors } from "./getTdNodeErrors.js";
import { registerGetTdNodeFlags } from "./getTdNodeFlags.js";
import { registerGetTdNodeParameters } from "./getTdNodeParameters.js";
import { registerGetTdNodes } from "./getTdNodes.js";
import { registerGetTdPerformance } from "./getTdPerformance.js";
import { registerGetTdTopology } from "./getTdTopology.js";
import { registerInspectComponent } from "./inspectComponent.js";
import { registerInspectGpuAndDisplays } from "./inspectGpuAndDisplays.js";
import { registerLintRecipeLibrary } from "./lintRecipeLibrary.js";
import { registerManageComponentStorage } from "./manageComponentStorage.js";
import { registerManagePackages } from "./managePackages.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerProfileCookCost } from "./profileCookCost.js";
import { registerProjectDocumentationSite } from "./projectDocumentationSite.js";
import { registerReadParameterModes } from "./readParameterModes.js";
import { registerRecordMovie } from "./recordMovie.js";
import { registerReloadBridge } from "./reloadBridge.js";
import { registerRenderOutput } from "./renderOutput.js";
import { registerRepairNetwork } from "./repairNetwork.js";
import { registerScoreBuild } from "./scoreBuild.js";
import { registerSearchOperators } from "./searchOperators.js";
import { registerSerializeNetwork } from "./serializeNetwork.js";
import { registerSetDatContent } from "./setDatContent.js";
import { registerSetParameterExpression } from "./setParameterExpression.js";
import { registerSnapshotTdGraph } from "./snapshotTdGraph.js";
import { registerSummarizeTdErrors } from "./summarizeTdErrors.js";
import { registerSwapOperator } from "./swapOperator.js";
import { registerUpdateTdNodeParameters } from "./updateTdNodeParameters.js";
import { registerWatchNode } from "./watchNode.js";
import { registerWriteAgentGuide } from "./writeAgentGuide.js";

export const layer3Registrars: ToolRegistrar[] = [
  registerGetTdInfo,
  registerCreateTdNode,
  registerDeleteTdNode,
  registerUpdateTdNodeParameters,
  registerGetTdNodes,
  registerGetTdNodeParameters,
  registerReadParameterModes,
  registerGetTdNodeErrors,
  registerExecutePythonScript,
  registerExecNodeMethod,
  registerGetTdClasses,
  registerGetTdClassDetails,
  registerGetModuleHelp,
  registerGetTdPerformance,
  registerGetTdTopology,
  registerFindTdNodes,
  registerSummarizeTdErrors,
  registerCompareTdNodes,
  registerSnapshotTdGraph,
  registerReloadBridge,
  registerSearchOperators,
  registerManagePackages,
  registerDocumentNetwork,
  registerDiffSnapshots,
  registerOptimizePerformance,
  registerRenderOutput,
  registerRecordMovie,
  // Phase 13 — project intelligence & agent-DX:
  registerAnalyzeProject,
  registerGenerateReadme,
  registerEditDatContent,
  registerSetDatContent,
  registerSetParameterExpression,
  registerWriteAgentGuide,
  // Phase 14 — parameter fidelity & wiring:
  registerDisconnectNodes,
  registerGetTdNodeFlags,
  // Phase 14 — runtime telemetry & logs:
  registerGetNodeStateRuntime,
  registerWatchNode,
  registerGetBridgeLogs,
  // Phase 15 — component introspection + network serialization:
  registerInspectComponent,
  registerSerializeNetwork,
  // Campaign Wave 4 — library/packaging (backlog 2026-05-29):
  registerCollectProjectAssets,
  registerProjectDocumentationSite,
  // Campaign Wave 6 — AI & LLM (backlog 2026-05-29):
  registerCaptionTop,
  registerRepairNetwork,
  // Campaign BEYOND Wave 1 (backlog 2026-05-30 — v0.7.0):
  registerLintRecipeLibrary,
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerScoreBuild,
  // Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
  registerProfileCookCost,
  registerControlTimelineTransport,
  registerInspectGpuAndDisplays,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerManageComponentStorage,
  registerEnhanceBuild,
  registerElicitMissingArgs,
  // Ingest-extend Wave 3 sub-batch B (2026-06-01 — v0.9.0):
  registerExtractPalette,
  registerExportSopToSvg,
  registerSwapOperator,
  registerCopilotVision,
  // Close-roadmap M4 (2026-06-01): inline preview pass — one-shot inspection snapshot.
  registerGetInlinePreview,
];
