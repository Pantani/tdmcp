import type { ToolRegistrar } from "../types.js";
import { registerAddCustomParameters } from "./addCustomParameters.js";
import { registerAddTimecodeOverlay } from "./addTimecodeOverlay.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerApplyLut } from "./applyLut.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerAuthorScriptOperator } from "./authorScriptOperator.js";
import { registerAutoRepairLoop } from "./autoRepairLoop.js";
import { registerBatchOperations } from "./batchOperations.js";
import { registerBindAudioReactive } from "./bindAudioReactive.js";
import { registerBindToChannel } from "./bindToChannel.js";
import { registerBuildChopChain } from "./buildChopChain.js";
import { registerBuildPopChain } from "./buildPopChain.js";
import { registerBuildSopGeometry } from "./buildSopGeometry.js";
import { registerConnectComfyui } from "./connectComfyui.js";
import { registerConnectDaydreamCloud } from "./connectDaydreamCloud.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerCreateAiTexture } from "./createAiTexture.js";
import { registerCreateAudioGlslUniforms } from "./createAudioGlslUniforms.js";
// Campaign Wave 3 — artist controls (backlog 2026-05-29):
import { registerCreateAutoMontage } from "./createAutoMontage.js";
import { registerCreateBandRouter } from "./createBandRouter.js";
import { registerCreateBeatGridSequencer } from "./createBeatGridSequencer.js";
import { registerCreateCaptureLoop } from "./createCaptureLoop.js";
import { registerCreateClipLauncher } from "./createClipLauncher.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateControlSurface } from "./createControlSurface.js";
import { registerCreateCueSequencer } from "./createCueSequencer.js";
import { registerCreateDataReactive } from "./createDataReactive.js";
import { registerCreateDataSource } from "./createDataSource.js";
import { registerCreateDataSourceHttpWs } from "./createDataSourceHttpWs.js";
import { registerCreateDecks } from "./createDecks.js";
import { registerCreateEnvelopeFollower } from "./createEnvelopeFollower.js";
import { registerCreateEuclideanSequencer } from "./createEuclideanSequencer.js";
import { registerCreateExternalIo } from "./createExternalIo.js";
import { registerCreateFlowAbstraction } from "./createFlowAbstraction.js";
import { registerCreateGlslMaterial } from "./createGlslMaterial.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateHandAbletonMapper } from "./createHandAbletonMapper.js";
import { registerCreateHandGestureBus } from "./createHandGestureBus.js";
import { registerCreateLedMapper } from "./createLedMapper.js";
import { registerCreateLlmChain } from "./createLlmChain.js";
import { registerCreateLookBank } from "./createLookBank.js";
import { registerCreateMacro } from "./createMacro.js";
import { registerCreateMidiMap } from "./createMidiMap.js";
import { registerCreateModulators } from "./createModulators.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreateNprFilter } from "./createNprFilter.js";
import { registerCreatePalette } from "./createPalette.js";
import { registerCreatePanic } from "./createPanic.js";
import { registerCreatePhoneRemote } from "./createPhoneRemote.js";
import { registerCreatePresetMorph } from "./createPresetMorph.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerCreateReplicator } from "./createReplicator.js";
import { registerCreateSceneTimeline } from "./createSceneTimeline.js";
import { registerCreateScheduler } from "./createScheduler.js";
import { registerCreateSharedMemoryBridge } from "./createSharedMemoryBridge.js";
import { registerCreateSidechainPump } from "./createSidechainPump.js";
import { registerCreateStageDashboard } from "./createStageDashboard.js";
import { registerCreateSynesthesiaUnrealOsc } from "./createSynesthesiaUnrealOsc.js";
import { registerCreateTimeEcho } from "./createTimeEcho.js";
import { registerCreateXyPad } from "./createXyPad.js";
import { registerDiagnoseTdabletonMapper } from "./diagnoseTdabletonMapper.js";
import { registerDuplicateNetwork } from "./duplicateNetwork.js";
import { registerExtendDataSourceFabric } from "./extendDataSourceFabric.js";
import { registerFocusNetworkEditor } from "./focusNetworkEditor.js";
import { registerLearnControl } from "./learnControl.js";
import { registerManageAnnotation } from "./manageAnnotation.js";
import { registerManageCheckpoint } from "./manageCheckpoint.js";
import { registerManageComponent } from "./manageComponent.js";
import { registerManageCue } from "./manageCue.js";
import { registerManagePresets } from "./managePresets.js";
import { registerPostPasses3d } from "./postPasses3d.js";
import { registerRandomizeControls } from "./randomizeControls.js";
import { registerRebuildNetwork } from "./rebuildNetwork.js";
import { registerScaffoldExtension } from "./scaffoldExtension.js";
import { registerScaffoldToolGenerator } from "./scaffoldToolGenerator.js";
import { registerScaffoldVjDeck } from "./scaffoldVjDeck.js";
import { registerSetParametersBatch } from "./setParametersBatch.js";
import { registerSetPerformMode } from "./setPerformMode.js";
import { registerSetupFaceTracking } from "./setupFaceTracking.js";
import { registerSetupHandTracking } from "./setupHandTracking.js";
import { registerSetupSegmentation } from "./setupSegmentation.js";
import { registerSyncTimecode } from "./syncTimecode.js";

export const layer2Registrars: ToolRegistrar[] = [
  registerFocusNetworkEditor,
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
  // Wave 5a — integrations: VJ deck scaffold + Synesthesia/Unreal OSC preset:
  registerScaffoldVjDeck,
  registerCreateSynesthesiaUnrealOsc,
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
  // Campaign Wave 3 — artist controls (backlog 2026-05-29):
  registerCreateSidechainPump,
  registerCreateBandRouter,
  registerCreateXyPad,
  registerCreateTimeEcho,
  registerCreateCaptureLoop,
  // Campaign BEYOND Wave 1 (backlog 2026-05-30 — v0.7.0):
  registerCreateAutoMontage,
  registerCreateEuclideanSequencer,
  registerCreatePresetMorph,
  registerCreateSceneTimeline,
  registerCreateScheduler,
  registerCreateGlslMaterial,
  // Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
  registerScaffoldToolGenerator,
  registerExtendDataSourceFabric,
  registerBuildChopChain,
  registerAuthorScriptOperator,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerCreateSharedMemoryBridge,
  registerBuildSopGeometry,
  registerSyncTimecode,
  // Campaign ingest-extend Wave 2 (2026-05-31): LUT/NPR/post-3d/flow/HTTP+WS:
  registerApplyLut,
  registerCreateNprFilter,
  registerPostPasses3d,
  registerCreateFlowAbstraction,
  registerCreateDataSourceHttpWs,
  // New wave: MediaPipe face + hand tracking:
  registerSetupFaceTracking,
  registerSetupHandTracking,
  registerSetupSegmentation,
  // Live Ableton/TDAbleton performance control from MediaPipe hands:
  registerCreateHandGestureBus,
  registerCreateHandAbletonMapper,
  registerDiagnoseTdabletonMapper,
  // Wave 2026-06-02 — fail-forward auto-repair loop:
  registerAutoRepairLoop,
  // Hype-scout Round 4 Wave 1 (2026-06-09) — typed POP chain builder:
  registerBuildPopChain,
  // Hype-scout Round 4 Wave 2 (2026-06-09) — audio→GLSL uniform binder:
  registerCreateAudioGlslUniforms,
  // Hype-scout Round 4 Wave 4 (2026-06-09) — AI bridges:
  registerConnectComfyui,
  registerConnectDaydreamCloud,
  registerCreateLlmChain,
  // Roadmap-to-1.0 Wave 3 (2026-07-06) — visual timecode overlay:
  registerAddTimecodeOverlay,
  // AI texture generation (2026-07-07) — prompt → fal.ai image → Movie File In TOP:
  registerCreateAiTexture,
];
