import type { ToolRegistrar } from "../types.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerSetParametersBatch } from "./setParametersBatch.js";

export const layer2Registrars: ToolRegistrar[] = [
  registerCreateNodeChain,
  registerConnectNodes,
  registerCreateGlslShader,
  registerCreatePythonScript,
  registerSetParametersBatch,
  registerCreateContainer,
];
