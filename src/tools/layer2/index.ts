import type { ToolRegistrar } from "../types.js";
import { registerAddCustomParameters } from "./addCustomParameters.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerBatchOperations } from "./batchOperations.js";
import { registerBindToChannel } from "./bindToChannel.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateClipLauncher } from "./createClipLauncher.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateControlSurface } from "./createControlSurface.js";
import { registerCreateCueSequencer } from "./createCueSequencer.js";
import { registerCreateDataSource } from "./createDataSource.js";
import { registerCreateDecks } from "./createDecks.js";
import { registerCreateExternalIo } from "./createExternalIo.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateLedMapper } from "./createLedMapper.js";
import { registerCreateMacro } from "./createMacro.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreatePalette } from "./createPalette.js";
import { registerCreatePanic } from "./createPanic.js";
import { registerCreatePhoneRemote } from "./createPhoneRemote.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerCreateStageDashboard } from "./createStageDashboard.js";
import { registerDuplicateNetwork } from "./duplicateNetwork.js";
import { registerLearnControl } from "./learnControl.js";
import { registerManageAnnotation } from "./manageAnnotation.js";
import { registerManageCheckpoint } from "./manageCheckpoint.js";
import { registerManageComponent } from "./manageComponent.js";
import { registerManageCue } from "./manageCue.js";
import { registerManagePresets } from "./managePresets.js";
import { registerRandomizeControls } from "./randomizeControls.js";
import { registerScaffoldExtension } from "./scaffoldExtension.js";
import { registerSetParametersBatch } from "./setParametersBatch.js";
import { registerSetPerformMode } from "./setPerformMode.js";

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
  // Wave 6 — DJ decks + MIDI/OSC learn:
  registerCreateDecks,
  registerLearnControl,
  // Post-0.3.0 parallel build — wave 1:
  registerCreateCueSequencer,
  registerCreateStageDashboard,
  registerCreatePalette,
  // Post-0.3.0 parallel build — wave 2:
  registerCreateDataSource,
  // Post-0.3.0 parallel build — wave 3:
  registerCreateLedMapper,
  // Phase 13 — reusable components & agent-DX:
  registerAddCustomParameters,
  registerScaffoldExtension,
  registerBatchOperations,
  registerManageAnnotation,
  registerSetPerformMode,
];
