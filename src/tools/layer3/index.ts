import type { ToolRegistrar } from "../types.js";
import { registerAnalyzeProject } from "./analyzeProject.js";
import { registerCollectProjectAssets } from "./collectProjectAssets.js";
import { registerCompareTdNodes } from "./compareTdNodes.js";
import { registerCreateTdNode } from "./createTdNode.js";
import { registerDeleteTdNode } from "./deleteTdNode.js";
import { registerDiffSnapshots } from "./diffSnapshots.js";
import { registerDisconnectNodes } from "./disconnectNodes.js";
import { registerDocumentNetwork } from "./documentNetwork.js";
import { registerEditDatContent } from "./editDatContent.js";
import { registerExecNodeMethod } from "./execNodeMethod.js";
import { registerExecutePythonScript } from "./executePythonScript.js";
import { registerFindTdNodes } from "./findTdNodes.js";
import { registerGenerateReadme } from "./generateReadme.js";
import { registerGetBridgeLogs } from "./getBridgeLogs.js";
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
import { registerManagePackages } from "./managePackages.js";
import { registerOptimizePerformance } from "./optimizePerformance.js";
import { registerProjectDocumentationSite } from "./projectDocumentationSite.js";
import { registerReadParameterModes } from "./readParameterModes.js";
import { registerRecordMovie } from "./recordMovie.js";
import { registerReloadBridge } from "./reloadBridge.js";
import { registerRenderOutput } from "./renderOutput.js";
import { registerSearchOperators } from "./searchOperators.js";
import { registerSerializeNetwork } from "./serializeNetwork.js";
import { registerSetDatContent } from "./setDatContent.js";
import { registerSetParameterExpression } from "./setParameterExpression.js";
import { registerSnapshotTdGraph } from "./snapshotTdGraph.js";
import { registerSummarizeTdErrors } from "./summarizeTdErrors.js";
import { registerUpdateTdNodeParameters } from "./updateTdNodeParameters.js";
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
  registerGetBridgeLogs,
  // Phase 15 — component introspection + network serialization:
  registerInspectComponent,
  registerSerializeNetwork,
  // Campaign Wave 4 — library/packaging (backlog 2026-05-29):
  registerCollectProjectAssets,
  registerProjectDocumentationSite,
];
