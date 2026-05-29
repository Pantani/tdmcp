import type { ToolRegistrar } from "../types.js";
import { registerAddCustomParameters } from "./addCustomParameters.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerBatchOperations } from "./batchOperations.js";
import { registerBindAudioReactive } from "./bindAudioReactive.js";
import { registerBindToChannel } from "./bindToChannel.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateBeatGridSequencer } from "./createBeatGridSequencer.js";
import { registerCreateClipLauncher } from "./createClipLauncher.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateControlSurface } from "./createControlSurface.js";
import { registerCreateCueSequencer } from "./createCueSequencer.js";
import { registerCreateDataReactive } from "./createDataReactive.js";
import { registerCreateDataSource } from "./createDataSource.js";
import { registerCreateDecks } from "./createDecks.js";
import { registerCreateEnvelopeFollower } from "./createEnvelopeFollower.js";
import { registerCreateExternalIo } from "./createExternalIo.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateLedMapper } from "./createLedMapper.js";
import { registerCreateLookBank } from "./createLookBank.js";
import { registerCreateMacro } from "./createMacro.js";
import { registerCreateMidiMap } from "./createMidiMap.js";
import { registerCreateModulators } from "./createModulators.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreatePalette } from "./createPalette.js";
import { registerCreatePanic } from "./createPanic.js";
import { registerCreatePhoneRemote } from "./createPhoneRemote.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerCreateReplicator } from "./createReplicator.js";
import { registerCreateStageDashboard } from "./createStageDashboard.js";
import { registerDuplicateNetwork } from "./duplicateNetwork.js";
import { registerLearnControl } from "./learnControl.js";
import { registerManageAnnotation } from "./manageAnnotation.js";
import { registerManageCheckpoint } from "./manageCheckpoint.js";
import { registerManageComponent } from "./manageComponent.js";
import { registerManageCue } from "./manageCue.js";
import { registerManagePresets } from "./managePresets.js";
import { registerRandomizeControls } from "./randomizeControls.js";
import { registerRebuildNetwork } from "./rebuildNetwork.js";
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
  // Make a generated COMP into a reusable, parameterized, scriptable component:
  registerAddCustomParameters,
  registerScaffoldExtension,
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
  // Phase 13 — agent-DX & perform mode (reusable-component tools registered above):
  registerBatchOperations,
  registerManageAnnotation,
  registerSetPerformMode,
  // Phase 14 — one-shot audio-reactive binding (v0.5.0):
  registerBindAudioReactive,
  // Phase 14 — data-driven cloning:
  registerCreateReplicator,
  // Phase 15 — data reactivity, step sequencing, network round-trip:
  registerCreateDataReactive,
  registerCreateBeatGridSequencer,
  registerRebuildNetwork,
  // Phase 15 — envelope/sidechain + MIDI map (hardware path held pending gear):
  registerCreateEnvelopeFollower,
  registerCreateMidiMap,
  // v0.6.0 — controls instruments:
  registerCreateModulators,
  registerCreateLookBank,
];
