import type { ToolRegistrar } from "../types.js";
import { registerCompareTdNodes } from "./compareTdNodes.js";
import { registerCreateTdNode } from "./createTdNode.js";
import { registerDeleteTdNode } from "./deleteTdNode.js";
import { registerDocumentNetwork } from "./documentNetwork.js";
import { registerExecNodeMethod } from "./execNodeMethod.js";
import { registerExecutePythonScript } from "./executePythonScript.js";
import { registerFindTdNodes } from "./findTdNodes.js";
import { registerGetModuleHelp } from "./getModuleHelp.js";
import { registerGetTdClassDetails } from "./getTdClassDetails.js";
import { registerGetTdClasses } from "./getTdClasses.js";
import { registerGetTdInfo } from "./getTdInfo.js";
import { registerGetTdNodeErrors } from "./getTdNodeErrors.js";
import { registerGetTdNodeParameters } from "./getTdNodeParameters.js";
import { registerGetTdNodes } from "./getTdNodes.js";
import { registerGetTdPerformance } from "./getTdPerformance.js";
import { registerGetTdTopology } from "./getTdTopology.js";
import { registerReloadBridge } from "./reloadBridge.js";
import { registerSearchOperators } from "./searchOperators.js";
import { registerSnapshotTdGraph } from "./snapshotTdGraph.js";
import { registerSummarizeTdErrors } from "./summarizeTdErrors.js";
import { registerUpdateTdNodeParameters } from "./updateTdNodeParameters.js";

export const layer3Registrars: ToolRegistrar[] = [
  registerGetTdInfo,
  registerCreateTdNode,
  registerDeleteTdNode,
  registerUpdateTdNodeParameters,
  registerGetTdNodes,
  registerGetTdNodeParameters,
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
  registerDocumentNetwork,
];
