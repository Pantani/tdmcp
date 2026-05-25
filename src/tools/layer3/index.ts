import type { ToolRegistrar } from "../types.js";
import { registerCreateTdNode } from "./createTdNode.js";
import { registerDeleteTdNode } from "./deleteTdNode.js";
import { registerExecNodeMethod } from "./execNodeMethod.js";
import { registerExecutePythonScript } from "./executePythonScript.js";
import { registerGetTdInfo } from "./getTdInfo.js";
import { registerGetTdNodeErrors } from "./getTdNodeErrors.js";
import { registerGetTdNodeParameters } from "./getTdNodeParameters.js";
import { registerGetTdNodes } from "./getTdNodes.js";
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
];
