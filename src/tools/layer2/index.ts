import type { ToolRegistrar } from "../types.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerBindToChannel } from "./bindToChannel.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateClipLauncher } from "./createClipLauncher.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateControlSurface } from "./createControlSurface.js";
import { registerCreateExternalIo } from "./createExternalIo.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateMacro } from "./createMacro.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreatePanic } from "./createPanic.js";
import { registerCreatePhoneRemote } from "./createPhoneRemote.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerDuplicateNetwork } from "./duplicateNetwork.js";
import { registerManageCheckpoint } from "./manageCheckpoint.js";
import { registerManageComponent } from "./manageComponent.js";
import { registerManageCue } from "./manageCue.js";
import { registerManagePresets } from "./managePresets.js";
import { registerRandomizeControls } from "./randomizeControls.js";
import { registerSetParametersBatch } from "./setParametersBatch.js";

export const layer2Registrars: ToolRegistrar[] = [
  registerCreateNodeChain,
  registerConnectNodes,
  registerCreateGlslShader,
  registerCreatePythonScript,
  registerSetParametersBatch,
  registerCreateContainer,
  registerCreateControlPanel,
  registerCreateControlSurface,
  registerAnimateParameter,
  registerBindToChannel,
  registerManagePresets,
  registerManageCheckpoint,
  registerManageCue,
  registerManageComponent,
  registerCreateMacro,
  registerRandomizeControls,
  registerCreatePhoneRemote,
  registerCreateExternalIo,
  registerDuplicateNetwork,
  registerArrangeNetwork,
  // Wave 4 — live-performance ergonomics:
  registerCreatePanic,
  registerCreateClipLauncher,
];
