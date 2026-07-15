import { isAceFeatureFlagEnabled } from "../../utils/config.js";
import type { ToolRegistrar } from "../types.js";
import { registerAnalyzeProject } from "./analyzeProject.js";
import { registerBundleDependencies } from "./bundleDependencies.js";
import { registerCancelMusicJob } from "./cancelMusicJob.js";
// Campaign Waves 4 & 6 (backlog 2026-05-29):
import { registerCaptionTop } from "./captionTop.js";
import { registerCheckOperatorAvailability } from "./checkOperatorAvailability.js";
import { registerCollectProjectAssets } from "./collectProjectAssets.js";
import { registerCompactGraphDigest } from "./compactGraphDigest.js";
import { registerCompareOperatorDocs } from "./compareOperatorDocs.js";
import { registerCompareTdNodes } from "./compareTdNodes.js";
import { registerControlTimelineTransport } from "./controlTimelineTransport.js";
import { registerCopilotVision } from "./copilotVision.js";
import { registerCreateRaytkOp } from "./createRaytkOp.js";
import { registerCreateTdNode } from "./createTdNode.js";
import { registerDeleteTdNode } from "./deleteTdNode.js";
import { registerDiagnoseHardwareEnvironment } from "./diagnoseHardwareEnvironment.js";
import { registerDiffSnapshots } from "./diffSnapshots.js";
import { registerDisconnectNodes } from "./disconnectNodes.js";
import { registerDocumentNetwork } from "./documentNetwork.js";
import { registerDraftRecipeFromOperatorChain } from "./draftRecipeFromOperatorChain.js";
import { registerDraftRecipeFromTechnique } from "./draftRecipeFromTechnique.js";
import { registerDraftRecipeFromTutorial } from "./draftRecipeFromTutorial.js";
import { registerEditDatContent } from "./editDatContent.js";
import { registerEditShaderLiveLoop } from "./editShaderLiveLoop.js";
import { registerElicitMissingArgs } from "./elicitMissingArgs.js";
import { registerExecNodeMethod } from "./execNodeMethod.js";
import { registerExecutePythonScript } from "./executePythonScript.js";
import { registerExportRenderPreset } from "./exportRenderPreset.js";
import { registerExportSopToSvg } from "./exportSopToSvg.js";
import { registerExtractPalette } from "./extractPalette.js";
import { registerFindTdNodes } from "./findTdNodes.js";
import { registerGenerateMusic } from "./generateMusic.js";
import { registerGenerateReadme } from "./generateReadme.js";
import { registerGetBridgeLogs } from "./getBridgeLogs.js";
import { registerGetDatContent } from "./getDatContent.js";
import { registerGetInlinePreview } from "./getInlinePreview.js";
import { registerGetModuleHelp } from "./getModuleHelp.js";
import { registerGetMusicJob } from "./getMusicJob.js";
import { registerGetNodeStateRuntime } from "./getNodeStateRuntime.js";
import { registerGetOperatorWorkflowGuide } from "./getOperatorWorkflowGuide.js";
import { registerGetParameterMenu } from "./getParameterMenu.js";
import { registerGetTdClassDetails } from "./getTdClassDetails.js";
import { registerGetTdClasses } from "./getTdClasses.js";
import { registerGetTdInfo } from "./getTdInfo.js";
import { registerGetTdNodeErrors } from "./getTdNodeErrors.js";
import { registerGetTdNodeFlags } from "./getTdNodeFlags.js";
import { registerGetTdNodeParameters } from "./getTdNodeParameters.js";
import { registerGetTdNodes } from "./getTdNodes.js";
import { registerGetTdPerformance } from "./getTdPerformance.js";
import { registerGetTdTopology } from "./getTdTopology.js";
import { registerGetTechniqueDetail } from "./getTechniqueDetail.js";
import { registerGetTutorial } from "./getTutorial.js";
import { registerInspectComponent } from "./inspectComponent.js";
import { registerInspectGpuAndDisplays } from "./inspectGpuAndDisplays.js";
import { registerLintRecipeLibrary } from "./lintRecipeLibrary.js";
import { registerManageComponentStorage } from "./manageComponentStorage.js";
import { registerManagePackages } from "./managePackages.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerPlanTdVersionMigration } from "./planTdVersionMigration.js";
import { registerProfileCookCost } from "./profileCookCost.js";
import { registerProjectDocumentationSite } from "./projectDocumentationSite.js";
import { registerReadParameterModes } from "./readParameterModes.js";
import { registerRecordMovie } from "./recordMovie.js";
import { registerReloadBridge } from "./reloadBridge.js";
import { registerRenderOutput } from "./renderOutput.js";
import { registerRepairNetwork } from "./repairNetwork.js";
import { registerScoreBuild } from "./scoreBuild.js";
import { registerSearchOperators } from "./searchOperators.js";
import { registerSearchPythonApi } from "./searchPythonApi.js";
import { registerSearchTouchDesignerKnowledge } from "./searchTouchDesignerKnowledge.js";
import { registerSerializeNetwork } from "./serializeNetwork.js";
import { registerSetDatContent } from "./setDatContent.js";
import { registerSetParameterExpression } from "./setParameterExpression.js";
import { registerShowPreflightReport } from "./showPreflightReport.js";
import { registerSnapshotTdGraph } from "./snapshotTdGraph.js";
import { registerSubmitMusicJob } from "./submitMusicJob.js";
import { registerSuggestOperatorChain } from "./suggestOperatorChain.js";
import { registerSummarizeTdErrors } from "./summarizeTdErrors.js";
import { registerSwapOperator } from "./swapOperator.js";
import { registerUpdateTdNodeParameters } from "./updateTdNodeParameters.js";
import { registerValidateOperatorChain } from "./validateOperatorChain.js";
import { registerWatchNode } from "./watchNode.js";
import { registerWatchParameterChanges } from "./watchParameterChanges.js";
import { registerWriteAgentGuide } from "./writeAgentGuide.js";

export const layer3Registrars: ToolRegistrar[] = [
  registerGetTdInfo,
  registerShowPreflightReport,
  // RayTK integration (Wave W3) — instance a RayTK ROP master by category/op-name:
  registerCreateRaytkOp,
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
  registerCompareOperatorDocs,
  registerGetOperatorWorkflowGuide,
  registerSuggestOperatorChain,
  registerValidateOperatorChain,
  registerDraftRecipeFromOperatorChain,
  registerGetTechniqueDetail,
  registerDraftRecipeFromTechnique,
  registerDraftRecipeFromTutorial,
  registerGetTutorial,
  registerSearchPythonApi,
  registerPlanTdVersionMigration,
  registerSearchTouchDesignerKnowledge,
  registerManagePackages,
  registerDocumentNetwork,
  registerDiffSnapshots,
  registerOptimizePerformance,
  registerRenderOutput,
  registerRecordMovie,
  registerExportRenderPreset,
  // Roadmap Wave 2 — bridge createable-truth reconciliation:
  registerCheckOperatorAvailability,
  // Phase 13 — project intelligence & agent-DX:
  registerAnalyzeProject,
  registerGenerateReadme,
  registerEditDatContent,
  registerSetDatContent,
  registerEditShaderLiveLoop,
  registerSetParameterExpression,
  registerWriteAgentGuide,
  // Phase 14 — parameter fidelity & wiring:
  registerDisconnectNodes,
  registerGetTdNodeFlags,
  // Phase 14 — runtime telemetry & logs:
  registerGetNodeStateRuntime,
  registerWatchNode,
  registerWatchParameterChanges,
  registerGetBridgeLogs,
  // Phase 15 — component introspection + network serialization:
  registerInspectComponent,
  registerSerializeNetwork,
  // Campaign Wave 4 — library/packaging (backlog 2026-05-29):
  registerBundleDependencies,
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
  registerDiagnoseHardwareEnvironment,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerManageComponentStorage,
  registerElicitMissingArgs,
  // Ingest-extend Wave 3 sub-batch B (2026-06-01 — v0.9.0):
  registerExtractPalette,
  registerExportSopToSvg,
  registerSwapOperator,
  registerCopilotVision,
  // Close-roadmap M4 (2026-06-01): inline preview pass — one-shot inspection snapshot.
  registerGetInlinePreview,
  // Wave 2026-06-02 — compact-token graph digest for small LLM context:
  registerCompactGraphDigest,
  // TDMCP-parity 2026-07-03 — read-only DAT paging + live parameter menu values
  // (patterns inspired by Derivative's official TouchDesigner TDMCP, Shared Use License):
  registerGetDatContent,
  registerGetParameterMenu,
];

// ACE-Step P0 (2026-07-07) — music generation is opt-in behind TDMCP_ACE_ENABLED.
// Registration runs before the parsed config exists, so gate on the raw env via
// the shared `isAceFeatureFlagEnabled` helper (mirrors the Creative RAG pattern).
if (isAceFeatureFlagEnabled(process.env.TDMCP_ACE_ENABLED)) {
  layer3Registrars.push(registerGenerateMusic);
  // ACE-Step P1 (2026-07-11) — async job lifecycle (submit/poll/cancel), same gate.
  layer3Registrars.push(registerSubmitMusicJob);
  layer3Registrars.push(registerGetMusicJob);
  layer3Registrars.push(registerCancelMusicJob);
}
