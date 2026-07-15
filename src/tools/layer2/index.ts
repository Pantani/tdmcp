import type { ToolRegistrar } from "../types.js";
import { registerAddCustomParameters } from "./addCustomParameters.js";
import { registerAddTimecodeOverlay } from "./addTimecodeOverlay.js";
import { registerAnimateParameter } from "./animateParameter.js";
import { registerApplyLut } from "./applyLut.js";
import { registerArrangeNetwork } from "./arrangeNetwork.js";
import { registerAtemSwitcherControl } from "./atemSwitcherControl.js";
import { registerAuthorScriptOperator } from "./authorScriptOperator.js";
import { registerAutoRepairLoop } from "./autoRepairLoop.js";
import { registerAutoUiFromParams } from "./autoUiFromParams.js";
import { registerBatchOperations } from "./batchOperations.js";
import { registerBindAudioReactive } from "./bindAudioReactive.js";
import { registerBindToChannel } from "./bindToChannel.js";
import { registerBuildChopChain } from "./buildChopChain.js";
import { registerBuildPopChain } from "./buildPopChain.js";
import { registerBuildSopGeometry } from "./buildSopGeometry.js";
import { registerClipAudioTransport } from "./clipAudioTransport.js";
import { registerConnectA1111WebuiBridge } from "./connectA1111WebuiBridge.js";
import { registerConnectAbletonLinkSession } from "./connectAbletonLinkSession.js";
import { registerConnectAdsbAircraftBus } from "./connectAdsbAircraftBus.js";
import { registerConnectAirtableContentBus } from "./connectAirtableContentBus.js";
import { registerConnectAisVesselBus } from "./connectAisVesselBus.js";
import { registerConnectArkitFaceCapture } from "./connectArkitFaceCapture.js";
import { registerConnectBlackmagicAtem } from "./connectBlackmagicAtem.js";
import { registerConnectBleBeaconBus } from "./connectBleBeaconBus.js";
import { registerConnectCalendarScheduleBus } from "./connectCalendarScheduleBus.js";
import { registerConnectCasparcgServer } from "./connectCasparcgServer.js";
import { registerConnectComfyui } from "./connectComfyui.js";
import { registerConnectCompanionSurface } from "./connectCompanionSurface.js";
import { registerConnectDaydreamCloud } from "./connectDaydreamCloud.js";
import { registerConnectDiscordInteractionBus } from "./connectDiscordInteractionBus.js";
import { registerConnectDisguiseStage } from "./connectDisguiseStage.js";
import { registerConnectDoorAccessBus } from "./connectDoorAccessBus.js";
import { registerConnectEnvironmentalSensorBus } from "./connectEnvironmentalSensorBus.js";
import { registerConnectFigmaDesignTokens } from "./connectFigmaDesignTokens.js";
import { registerConnectGeojsonFeatureBus } from "./connectGeojsonFeatureBus.js";
import { registerConnectGoogleSheetsCueTable } from "./connectGoogleSheetsCueTable.js";
import { registerConnectGpsFleetTracker } from "./connectGpsFleetTracker.js";
import { registerConnectGrafanaAnnotationBridge } from "./connectGrafanaAnnotationBridge.js";
import { registerConnectGtfsTransitFeed } from "./connectGtfsTransitFeed.js";
import { registerConnectHomeassistantStateBus } from "./connectHomeassistantStateBus.js";
import { registerConnectHoudiniEngineBridge } from "./connectHoudiniEngineBridge.js";
import { registerConnectHuggingfaceInferenceBridge } from "./connectHuggingfaceInferenceBridge.js";
import { registerConnectInfluxdbTimeseriesBridge } from "./connectInfluxdbTimeseriesBridge.js";
import { registerConnectIsadoraPatch } from "./connectIsadoraPatch.js";
import { registerConnectKafkaEventBus } from "./connectKafkaEventBus.js";
import { registerConnectLightingConsoleOsc } from "./connectLightingConsoleOsc.js";
import { registerConnectMadmapperSurface } from "./connectMadmapperSurface.js";
import { registerConnectMapTileOverlay } from "./connectMapTileOverlay.js";
import { registerConnectMatrixRoomBus } from "./connectMatrixRoomBus.js";
import { registerConnectMaxMspBridge } from "./connectMaxMspBridge.js";
import { registerConnectMidiMpeController } from "./connectMidiMpeController.js";
import { registerConnectMilluminShow } from "./connectMilluminShow.js";
import { registerConnectMqttIotBus } from "./connectMqttIotBus.js";
import { registerConnectNfcTapBus } from "./connectNfcTapBus.js";
import { registerConnectNodes } from "./connectNodes.js";
import { registerConnectNoiseLevelBus } from "./connectNoiseLevelBus.js";
import { registerConnectNotionShowRundown } from "./connectNotionShowRundown.js";
import { registerConnectObsRecorder } from "./connectObsRecorder.js";
import { registerConnectOmniverseUsdBridge } from "./connectOmniverseUsdBridge.js";
import { registerConnectOpcuaIndustrialBus } from "./connectOpcuaIndustrialBus.js";
import { registerConnectOscqueryNamespace } from "./connectOscqueryNamespace.js";
import { registerConnectPangolinBeyond } from "./connectPangolinBeyond.js";
import { registerConnectParkingOccupancyBus } from "./connectParkingOccupancyBus.js";
import { registerConnectPeopleCountingBus } from "./connectPeopleCountingBus.js";
import { registerConnectPosSalesTelemetry } from "./connectPosSalesTelemetry.js";
import { registerConnectPowerMeterBus } from "./connectPowerMeterBus.js";
import { registerConnectPrometheusMetricsPanel } from "./connectPrometheusMetricsPanel.js";
import { registerConnectPublicAlertsBus } from "./connectPublicAlertsBus.js";
import { registerConnectQlabCueStack } from "./connectQlabCueStack.js";
import { registerConnectQrScanBus } from "./connectQrScanBus.js";
import { registerConnectQueueLengthBus } from "./connectQueueLengthBus.js";
import { registerConnectReaperTransport } from "./connectReaperTransport.js";
import { registerConnectRedisPubsubBus } from "./connectRedisPubsubBus.js";
import { registerConnectReplicatePredictionBridge } from "./connectReplicatePredictionBridge.js";
import { registerConnectResolumeArena } from "./connectResolumeArena.js";
import { registerConnectRfidBadgeBus } from "./connectRfidBadgeBus.js";
import { registerConnectRssFeedBus } from "./connectRssFeedBus.js";
import { registerConnectRunwayVideoBridge } from "./connectRunwayVideoBridge.js";
import { registerConnectRvcVoiceConversionBus } from "./connectRvcVoiceConversionBus.js";
import { registerConnectS3MediaBucket } from "./connectS3MediaBucket.js";
import { registerConnectSerialDeviceBus } from "./connectSerialDeviceBus.js";
import { registerConnectSlackOpsBridge } from "./connectSlackOpsBridge.js";
import { registerConnectSpoutSyphonRouter } from "./connectSpoutSyphonRouter.js";
import { registerConnectSupercolliderSynth } from "./connectSupercolliderSynth.js";
import { registerConnectTicketingCheckinBus } from "./connectTicketingCheckinBus.js";
import { registerConnectTidalcyclesLivecoding } from "./connectTidalcyclesLivecoding.js";
import { registerConnectTiktokLiveEventsBus } from "./connectTiktokLiveEventsBus.js";
import { registerConnectTouchengineNotch } from "./connectTouchengineNotch.js";
import { registerConnectTuioTouchSurface } from "./connectTuioTouchSurface.js";
import { registerConnectTwitchEventsubBus } from "./connectTwitchEventsubBus.js";
import { registerConnectUdpTelemetryBridge } from "./connectUdpTelemetryBridge.js";
import { registerConnectUnityOscBridge } from "./connectUnityOscBridge.js";
import { registerConnectUwbAnchorBus } from "./connectUwbAnchorBus.js";
import { registerConnectVdmxWorkspace } from "./connectVdmxWorkspace.js";
import { registerConnectVideoStreamReceiver } from "./connectVideoStreamReceiver.js";
import { registerConnectVmixProduction } from "./connectVmixProduction.js";
import { registerConnectWeatherForecastBus } from "./connectWeatherForecastBus.js";
import { registerConnectWebrtcBrowserInput } from "./connectWebrtcBrowserInput.js";
import { registerConnectWebsocketControlBus } from "./connectWebsocketControlBus.js";
import { registerConnectWhisperTranscriptionBus } from "./connectWhisperTranscriptionBus.js";
import { registerConnectWifiPresenceBus } from "./connectWifiPresenceBus.js";
import { registerConnectXsensMvnMocap } from "./connectXsensMvnMocap.js";
import { registerConnectYoutubeLiveChatBus } from "./connectYoutubeLiveChatBus.js";
import { registerCreateAiTexture } from "./createAiTexture.js";
import { registerCreateAiVideo } from "./createAiVideo.js";
import { registerCreateArtnetDiscoveryPanel } from "./createArtnetDiscoveryPanel.js";
import { registerCreateAudioGlslUniforms } from "./createAudioGlslUniforms.js";
// Campaign Wave 3 — artist controls (backlog 2026-05-29):
import { registerCreateAutoMontage } from "./createAutoMontage.js";
import { registerCreateAzureKinectBodyBus } from "./createAzureKinectBodyBus.js";
import { registerCreateBandRouter } from "./createBandRouter.js";
import { registerCreateBeatGridSequencer } from "./createBeatGridSequencer.js";
import { registerCreateBlacktraxTrackingBus } from "./createBlacktraxTrackingBus.js";
import { registerCreateBlenderSceneBridge } from "./createBlenderSceneBridge.js";
import { registerCreateCaptureLoop } from "./createCaptureLoop.js";
import { registerCreateClipLauncher } from "./createClipLauncher.js";
import { registerCreateCompanionSurface } from "./createCompanionSurface.js";
import { registerCreateContainer } from "./createContainer.js";
import { registerCreateControlPanel } from "./createControlPanel.js";
import { registerCreateControlSurface } from "./createControlSurface.js";
import { registerCreateCueSequencer } from "./createCueSequencer.js";
import { registerCreateDataReactive } from "./createDataReactive.js";
import { registerCreateDataSource } from "./createDataSource.js";
import { registerCreateDataSourceHttpWs } from "./createDataSourceHttpWs.js";
import { registerCreateDecklinkIoRouter } from "./createDecklinkIoRouter.js";
import { registerCreateDecks } from "./createDecks.js";
import { registerCreateDepthaiOakPipeline } from "./createDepthaiOakPipeline.js";
import { registerCreateDirectDisplayOutput } from "./createDirectDisplayOutput.js";
import { registerCreateEnvelopeFollower } from "./createEnvelopeFollower.js";
import { registerCreateEuclideanSequencer } from "./createEuclideanSequencer.js";
import { registerCreateExternalIo } from "./createExternalIo.js";
import { registerCreateFlowAbstraction } from "./createFlowAbstraction.js";
import { registerCreateGlslMaterial } from "./createGlslMaterial.js";
import { registerCreateGlslShader } from "./createGlslShader.js";
import { registerCreateHandAbletonMapper } from "./createHandAbletonMapper.js";
import { registerCreateHandGestureBus } from "./createHandGestureBus.js";
import { registerCreateHokuyoLidarBus } from "./createHokuyoLidarBus.js";
import { registerCreateLeapMotionHandBus } from "./createLeapMotionHandBus.js";
import { registerCreateLedMapper } from "./createLedMapper.js";
import { registerCreateLivoxLidarBus } from "./createLivoxLidarBus.js";
import { registerCreateLlmChain } from "./createLlmChain.js";
import { registerCreateLookBank } from "./createLookBank.js";
import { registerCreateLtcTimecodeBridge } from "./createLtcTimecodeBridge.js";
import { registerCreateMacro } from "./createMacro.js";
import { registerCreateMidiMap } from "./createMidiMap.js";
import { registerCreateMocapStreamBridge } from "./createMocapStreamBridge.js";
import { registerCreateModulators } from "./createModulators.js";
import { registerCreateMonitorLayoutPanel } from "./createMonitorLayoutPanel.js";
import { registerCreateMpcdiProjectionMapper } from "./createMpcdiProjectionMapper.js";
import { registerCreateMultitouchPanelBus } from "./createMultitouchPanelBus.js";
import { registerCreateNcamCameraTrackingBus } from "./createNcamCameraTrackingBus.js";
import { registerCreateNdiRouterMatrix } from "./createNdiRouterMatrix.js";
import { registerCreateNodeChain } from "./createNodeChain.js";
import { registerCreateNprFilter } from "./createNprFilter.js";
import { registerCreateOpenxrControllerBridge } from "./createOpenxrControllerBridge.js";
import { registerCreateOptitrackTrackingBus } from "./createOptitrackTrackingBus.js";
import { registerCreateOusterLidarBus } from "./createOusterLidarBus.js";
import { registerCreatePalette } from "./createPalette.js";
import { registerCreatePanic } from "./createPanic.js";
import { registerCreatePhoneRemote } from "./createPhoneRemote.js";
import { registerCreatePresetMorph } from "./createPresetMorph.js";
import { registerCreatePythonScript } from "./createPythonScript.js";
import { registerCreateRealsenseDepthBus } from "./createRealsenseDepthBus.js";
import { registerCreateReplicator } from "./createReplicator.js";
import { registerCreateScalableDisplayBus } from "./createScalableDisplayBus.js";
import { registerCreateSceneTimeline } from "./createSceneTimeline.js";
import { registerCreateScheduler } from "./createScheduler.js";
import { registerCreateSharedMemoryBridge } from "./createSharedMemoryBridge.js";
import { registerCreateSidechainPump } from "./createSidechainPump.js";
import { registerCreateStageDashboard } from "./createStageDashboard.js";
import { registerCreateSynesthesiaUnrealOsc } from "./createSynesthesiaUnrealOsc.js";
import { registerCreateTimeEcho } from "./createTimeEcho.js";
import { registerCreateTouchoscLayout } from "./createTouchoscLayout.js";
import { registerCreateUnrealLivelinkBridge } from "./createUnrealLivelinkBridge.js";
import { registerCreateVcvRackBridge } from "./createVcvRackBridge.js";
import { registerCreateViosoWarpPanel } from "./createViosoWarpPanel.js";
import { registerCreateVoicePromptPipeline } from "./createVoicePromptPipeline.js";
import { registerCreateWindowOutputMatrix } from "./createWindowOutputMatrix.js";
import { registerCreateXyPad } from "./createXyPad.js";
import { registerCreateZedDepthBus } from "./createZedDepthBus.js";
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
import { registerNotchTouchengineBridge } from "./notchTouchengineBridge.js";
import { registerObsStreamControl } from "./obsStreamControl.js";
import { registerOscRouterMatrix } from "./oscRouterMatrix.js";
import { registerPostPasses3d } from "./postPasses3d.js";
import { registerQlabOscBridge } from "./qlabOscBridge.js";
import { registerRandomizeControls } from "./randomizeControls.js";
import { registerRebuildNetwork } from "./rebuildNetwork.js";
import { registerResolumeVdmxOutputChain } from "./resolumeVdmxOutputChain.js";
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
  registerAutoUiFromParams,
  registerCreateCompanionSurface,
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
  // External-integration Wave 1 (2026-07-09): show-control and capture bridges.
  registerConnectCompanionSurface,
  registerConnectObsRecorder,
  // External-integration Wave 2 (2026-07-09): OSC, voice prompt, and engine bridges.
  registerCreateTouchoscLayout,
  registerCreateVoicePromptPipeline,
  registerConnectTouchengineNotch,
  // External-integration Wave 3 (2026-07-09): VJ, mapping, mocap, engine, and CV bridges.
  registerConnectResolumeArena,
  registerConnectMadmapperSurface,
  registerCreateMocapStreamBridge,
  registerCreateBlenderSceneBridge,
  registerCreateUnrealLivelinkBridge,
  registerCreateVcvRackBridge,
  // External-integration Wave 4 (2026-07-09): show-control and broadcast/playout bridges.
  registerConnectQlabCueStack,
  registerConnectLightingConsoleOsc,
  registerConnectMaxMspBridge,
  registerCreateOpenxrControllerBridge,
  registerConnectVmixProduction,
  registerConnectCasparcgServer,
  // External-integration Wave 5 (2026-07-09): creative-app, DAW, NDI, and browser bridges.
  registerConnectMilluminShow,
  registerConnectIsadoraPatch,
  registerConnectUnityOscBridge,
  registerConnectReaperTransport,
  registerCreateNdiRouterMatrix,
  registerConnectWebrtcBrowserInput,
  // External-integration Wave 6 (2026-07-09): texture sharing, switchers, IoT, sensors.
  registerConnectSpoutSyphonRouter,
  registerConnectBlackmagicAtem,
  registerConnectOscqueryNamespace,
  registerConnectMqttIotBus,
  registerCreateDepthaiOakPipeline,
  registerConnectArkitFaceCapture,
  // External-integration Wave 7 (2026-07-09): performance hardware/protocols.
  registerConnectPangolinBeyond,
  registerCreateHokuyoLidarBus,
  registerConnectSupercolliderSynth,
  registerConnectAbletonLinkSession,
  registerCreateDecklinkIoRouter,
  registerConnectMidiMpeController,
  // External-integration Wave 8 (2026-07-09): live coding, VJ/media servers, tracking.
  registerConnectTidalcyclesLivecoding,
  registerConnectVdmxWorkspace,
  registerConnectDisguiseStage,
  registerCreateAzureKinectBodyBus,
  registerCreateZedDepthBus,
  registerCreateLeapMotionHandBus,
  // External-integration Wave 9 (2026-07-09): tracking, touch surfaces, timecode.
  registerCreateBlacktraxTrackingBus,
  registerCreateNcamCameraTrackingBus,
  registerCreateOusterLidarBus,
  registerConnectTuioTouchSurface,
  registerCreateMultitouchPanelBus,
  registerCreateLtcTimecodeBridge,
  // External-integration Wave 10 (2026-07-09): network/protocol ingest.
  registerCreateOptitrackTrackingBus,
  registerConnectVideoStreamReceiver,
  registerConnectWebsocketControlBus,
  registerConnectSerialDeviceBus,
  registerConnectUdpTelemetryBridge,
  registerCreateArtnetDiscoveryPanel,
  // External-integration Wave 11 (2026-07-09): projection/display infrastructure.
  registerCreateMpcdiProjectionMapper,
  registerCreateViosoWarpPanel,
  registerCreateDirectDisplayOutput,
  registerCreateScalableDisplayBus,
  registerCreateWindowOutputMatrix,
  registerCreateMonitorLayoutPanel,
  // External-integration Wave 12 (2026-07-09): spatial/industrial data bridges.
  registerCreateRealsenseDepthBus,
  registerCreateLivoxLidarBus,
  registerConnectXsensMvnMocap,
  registerConnectHoudiniEngineBridge,
  registerConnectOmniverseUsdBridge,
  registerConnectOpcuaIndustrialBus,
  // External-integration Wave 13 (2026-07-09): creative AI inference bridges.
  registerConnectReplicatePredictionBridge,
  registerConnectA1111WebuiBridge,
  registerConnectHuggingfaceInferenceBridge,
  registerConnectWhisperTranscriptionBus,
  registerConnectRvcVoiceConversionBus,
  registerConnectRunwayVideoBridge,
  // External-integration Wave 14 (2026-07-09): observability/data ops bridges.
  registerConnectKafkaEventBus,
  registerConnectRedisPubsubBus,
  registerConnectInfluxdbTimeseriesBridge,
  registerConnectPrometheusMetricsPanel,
  registerConnectGrafanaAnnotationBridge,
  registerConnectHomeassistantStateBus,
  // External-integration Wave 15 (2026-07-09): content ops and collaboration bridges.
  registerConnectGoogleSheetsCueTable,
  registerConnectAirtableContentBus,
  registerConnectNotionShowRundown,
  registerConnectFigmaDesignTokens,
  registerConnectSlackOpsBridge,
  registerConnectS3MediaBucket,
  // External-integration Wave 16 (2026-07-09): venue/public ops bridges.
  registerConnectCalendarScheduleBus,
  registerConnectTicketingCheckinBus,
  registerConnectPosSalesTelemetry,
  registerConnectWeatherForecastBus,
  registerConnectGtfsTransitFeed,
  registerConnectParkingOccupancyBus,
  // External-integration Wave 17 (2026-07-09): geospatial and mobility feeds.
  registerConnectMapTileOverlay,
  registerConnectGeojsonFeatureBus,
  registerConnectGpsFleetTracker,
  registerConnectAdsbAircraftBus,
  registerConnectAisVesselBus,
  registerConnectPublicAlertsBus,
  // External-integration Wave 18 (2026-07-09): audience and social feeds.
  registerConnectTwitchEventsubBus,
  registerConnectYoutubeLiveChatBus,
  registerConnectDiscordInteractionBus,
  registerConnectTiktokLiveEventsBus,
  registerConnectMatrixRoomBus,
  registerConnectRssFeedBus,
  // External-integration Wave 19 (2026-07-09): onsite proximity inputs.
  registerConnectRfidBadgeBus,
  registerConnectNfcTapBus,
  registerConnectBleBeaconBus,
  registerConnectUwbAnchorBus,
  registerConnectQrScanBus,
  registerConnectWifiPresenceBus,
  // External-integration Wave 20 (2026-07-09): venue safety/facilities feeds.
  registerConnectPeopleCountingBus,
  registerConnectQueueLengthBus,
  registerConnectDoorAccessBus,
  registerConnectEnvironmentalSensorBus,
  registerConnectPowerMeterBus,
  registerConnectNoiseLevelBus,
  registerDuplicateNetwork,
  registerArrangeNetwork,
  // Wave 4 — live-performance ergonomics:
  registerCreatePanic,
  registerCreateClipLauncher,
  registerClipAudioTransport,
  registerOscRouterMatrix,
  registerQlabOscBridge,
  registerAtemSwitcherControl,
  registerResolumeVdmxOutputChain,
  registerObsStreamControl,
  registerNotchTouchengineBridge,
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
  // AI video generation (2026-07-10) — prompt → fal/comfyui clip → Movie File In TOP:
  registerCreateAiVideo,
];
