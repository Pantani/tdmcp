import type { ToolRegistrar } from "../types.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerDuplicateNetwork } from "./duplicateNetwork.js";
import { registerManagePresets } from "./managePresets.js";
import { registerSetParametersBatch } from "./setParametersBatch.js";

export const layer2Registrars: ToolRegistrar[] = [
  registerCreateNodeChain,
  registerConnectNodes,
  registerCreateGlslShader,
  registerCreatePythonScript,
  registerSetParametersBatch,
  registerCreateContainer,
  registerCreateControlPanel,
  registerAnimateParameter,
  registerManagePresets,
  registerDuplicateNetwork,
  registerArrangeNetwork,
];
