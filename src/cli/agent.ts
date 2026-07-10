import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type AiPartyGatewayResult,
  AiPartyGatewaySchema,
  formatAiPartyTelegramReply,
  runAiPartyGateway,
} from "../automation/aiPartyGateway.js";
import { AiPartyPocRunSchema, runAiPartyPoc } from "../automation/aiPartyPoc.js";
import {
  DEMO_MIXER_SCENE_MANIFEST,
  loadMixerSceneManifest,
  MixerSceneManifestSchema,
} from "../automation/mixerSceneCatalog.js";
import {
  approveShowIntent,
  cancelShowIntent,
  createShowDirectorState,
  ShowDirectorStateSchema,
  submitShowIntent,
} from "../automation/showDirectorRuntime.js";
import {
  EffectPolicySchema,
  type PolicyDecision,
  parseShowIntent,
  ShowIntentSchema,
} from "../automation/showDirectorSchema.js";
import { inspectAiPartyOllamaSetup, runShowIntentOllama } from "../automation/showIntentOllama.js";
import {
  pollTelegramShowOnce,
  TelegramShowPollOnceSchema,
} from "../automation/telegramShowGateway.js";
import { capturePreview } from "../feedback/previewCapture.js";
import { buildToolContext } from "../server/context.js";
import { type TdEventHandler, TdEventStream } from "../td-client/eventStream.js";
import { friendlyTdError } from "../td-client/types.js";
import {
  loadSessionProfileImpl,
  loadSessionProfileSchema,
} from "../tools/ai/loadSessionProfile.js";
import { narrateSetImpl, narrateSetSchema } from "../tools/ai/narrateSet.js";
import { oneSourceFiveWaysImpl, oneSourceFiveWaysSchema } from "../tools/ai/oneSourceFiveWays.js";
// Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
import { macroRecorderImpl, macroRecorderSchema } from "../tools/cli/macroRecorder.js";
// Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
import { runMacroScriptImpl, runMacroScriptSchema } from "../tools/cli/runMacroScript.js";
import {
  applyGlslTopMappingImpl,
  applyGlslTopMappingSchema,
} from "../tools/foundation/glslTopMapping.js";
import {
  applyCreativeCardImpl,
  applyCreativeCardSchema,
} from "../tools/layer1/applyCreativeCard.js";
import {
  applyPostProcessingImpl,
  applyPostProcessingSchema,
} from "../tools/layer1/applyPostProcessing.js";
import { applyRecipeImpl, applyRecipeSchema } from "../tools/layer1/applyRecipe.js";
import {
  audioFingerprintToVisualImpl,
  audioFingerprintToVisualSchema,
} from "../tools/layer1/audioFingerprintToVisual.js";
import {
  blenderSceneImportImpl,
  blenderSceneImportSchema,
} from "../tools/layer1/blenderSceneImport.js";
import { composeCueListImpl, composeCueListSchema } from "../tools/layer1/composeCueList.js";
import {
  controlledDisorderGridImpl,
  controlledDisorderGridSchema,
} from "../tools/layer1/controlledDisorderGrid.js";
import {
  create3dAudioReactiveImpl,
  create3dAudioReactiveSchema,
} from "../tools/layer1/create3dAudioReactive.js";
import { create3dSceneImpl, create3dSceneSchema } from "../tools/layer1/create3dScene.js";
import { createAiMirrorImpl, createAiMirrorSchema } from "../tools/layer1/createAiMirror.js";
import {
  createAsciiRenderImpl,
  createAsciiRenderSchema,
} from "../tools/layer1/createAsciiRender.js";
import {
  createAsemicWritingImpl,
  createAsemicWritingSchema,
} from "../tools/layer1/createAsemicWriting.js";
import {
  createAudioReactiveImpl,
  createAudioReactiveSchema,
} from "../tools/layer1/createAudioReactive.js";
import {
  createAutomationLaneImpl,
  createAutomationLaneSchema,
} from "../tools/layer1/createAutomationLane.js";
import { createAutopilotImpl, createAutopilotSchema } from "../tools/layer1/createAutopilot.js";
import {
  createBlobReactiveImpl,
  createBlobReactiveSchema,
} from "../tools/layer1/createBlobReactive.js";
import { createBlobTraceImpl, createBlobTraceSchema } from "../tools/layer1/createBlobTrace.js";
import {
  createBodyBubblesImpl,
  createBodyBubblesSchema,
} from "../tools/layer1/createBodyBubbles.js";
import {
  createBodyReactiveImpl,
  createBodyReactiveSchema,
} from "../tools/layer1/createBodyReactive.js";
import {
  createChopRecorderImpl,
  createChopRecorderSchema,
} from "../tools/layer1/createChopRecorder.js";
import {
  createChromaReactiveImpl,
  createChromaReactiveSchema,
} from "../tools/layer1/createChromaReactive.js";
import {
  createChromeBlobsImpl,
  createChromeBlobsSchema,
} from "../tools/layer1/createChromeBlobs.js";
import { createColorGradeImpl, createColorGradeSchema } from "../tools/layer1/createColorGrade.js";
import {
  createColorWheelsImpl,
  createColorWheelsSchema,
} from "../tools/layer1/createColorWheels.js";
import {
  createCubemapDomeImpl,
  createCubemapDomeSchema,
} from "../tools/layer1/createCubemapDome.js";
import { createDatamoshImpl, createDatamoshSchema } from "../tools/layer1/createDatamosh.js";
import {
  createDataVisualizationImpl,
  createDataVisualizationSchema,
} from "../tools/layer1/createDataVisualization.js";
import {
  createDepthDisplacementImpl,
  createDepthDisplacementSchema,
} from "../tools/layer1/createDepthDisplacement.js";
import {
  createDepthFromTwoDImpl,
  createDepthFromTwoDSchema,
} from "../tools/layer1/createDepthFromTwoD.js";
import {
  createDepthPopFieldImpl,
  createDepthPopFieldSchema,
} from "../tools/layer1/createDepthPopField.js";
import {
  createDepthSilhouetteImpl,
  createDepthSilhouetteSchema,
} from "../tools/layer1/createDepthSilhouette.js";
import {
  createDetectionReactiveImpl,
  createDetectionReactiveSchema,
} from "../tools/layer1/createDetectionReactive.js";
import {
  createDisplacementWarpImpl,
  createDisplacementWarpSchema,
} from "../tools/layer1/createDisplacementWarp.js";
import { createDitherImpl, createDitherSchema } from "../tools/layer1/createDither.js";
import {
  createDmxFixturePipelineImpl,
  createDmxFixturePipelineSchema,
} from "../tools/layer1/createDmxFixturePipeline.js";
import { createDomeOutputImpl, createDomeOutputSchema } from "../tools/layer1/createDomeOutput.js";
import {
  createEnergyStructureImpl,
  createEnergyStructureSchema,
} from "../tools/layer1/createEnergyStructure.js";
import { createEngineCompImpl, createEngineCompSchema } from "../tools/layer1/createEngineComp.js";
import {
  createFacadeMappingImpl,
  createFacadeMappingSchema,
} from "../tools/layer1/createFacadeMapping.js";
import {
  createFeedbackNetworkImpl,
  createFeedbackNetworkSchema,
} from "../tools/layer1/createFeedbackNetwork.js";
import {
  createFeedbackTunnelImpl,
  createFeedbackTunnelSchema,
} from "../tools/layer1/createFeedbackTunnel.js";
import {
  createFixtureControlImpl,
  createFixtureControlSchema,
} from "../tools/layer1/createFixtureControl.js";
import { createFluidSimImpl, createFluidSimSchema } from "../tools/layer1/createFluidSim.js";
import {
  createGaussianSplatSceneImpl,
  createGaussianSplatSceneSchema,
} from "../tools/layer1/createGaussianSplatScene.js";
import {
  createGenerativeArtImpl,
  createGenerativeArtSchema,
} from "../tools/layer1/createGenerativeArt.js";
import {
  createGenerativeAudioImpl,
  createGenerativeAudioSchema,
} from "../tools/layer1/createGenerativeAudio.js";
import {
  createGeoVisualizationImpl,
  createGeoVisualizationSchema,
} from "../tools/layer1/createGeoVisualization.js";
import { createGlitchImpl, createGlitchSchema } from "../tools/layer1/createGlitch.js";
import {
  createGpuParticleFieldImpl,
  createGpuParticleFieldSchema,
} from "../tools/layer1/createGpuParticleField.js";
import {
  createGrowthSystemImpl,
  createGrowthSystemSchema,
} from "../tools/layer1/createGrowthSystem.js";
import { createHalftoneImpl, createHalftoneSchema } from "../tools/layer1/createHalftone.js";
import {
  createHandHologramImpl,
  createHandHologramSchema,
} from "../tools/layer1/createHandHologram.js";
import {
  createHistogramScopeImpl,
  createHistogramScopeSchema,
} from "../tools/layer1/createHistogramScope.js";
import {
  createImageToParticlesImpl,
  createImageToParticlesSchema,
} from "../tools/layer1/createImageToParticles.js";
import {
  createInteractionZonesImpl,
  createInteractionZonesSchema,
} from "../tools/layer1/createInteractionZones.js";
import {
  createInteractiveProjectionMappingImpl,
  createInteractiveProjectionMappingSchema,
} from "../tools/layer1/createInteractiveProjectionMapping.js";
import { createJfaVoronoiImpl, createJfaVoronoiSchema } from "../tools/layer1/createJfaVoronoi.js";
import {
  createKaleidoscopeImpl,
  createKaleidoscopeSchema,
} from "../tools/layer1/createKaleidoscope.js";
import { createKeyerImpl, createKeyerSchema } from "../tools/layer1/createKeyer.js";
import {
  createKeyframeAnimationImpl,
  createKeyframeAnimationSchema,
} from "../tools/layer1/createKeyframeAnimation.js";
import {
  createKinectWallHarpImpl,
  createKinectWallHarpSchema,
} from "../tools/layer1/createKinectWallHarp.js";
import {
  createKineticTextImpl,
  createKineticTextSchema,
} from "../tools/layer1/createKineticText.js";
import { createLayerMixerImpl, createLayerMixerSchema } from "../tools/layer1/createLayerMixer.js";
import { createLayerStackImpl, createLayerStackSchema } from "../tools/layer1/createLayerStack.js";
import { createLiveSourceImpl, createLiveSourceSchema } from "../tools/layer1/createLiveSource.js";
import { createMediaBinImpl, createMediaBinSchema } from "../tools/layer1/createMediaBin.js";
import { createMeshWarpImpl, createMeshWarpSchema } from "../tools/layer1/createMeshWarp.js";
import {
  createMidiNoteReactiveImpl,
  createMidiNoteReactiveSchema,
} from "../tools/layer1/createMidiNoteReactive.js";
import {
  createMotionReactiveImpl,
  createMotionReactiveSchema,
} from "../tools/layer1/createMotionReactive.js";
import {
  createMultiOutputImpl,
  createMultiOutputSchema,
} from "../tools/layer1/createMultiOutput.js";
import {
  multipass3dDepthImpl,
  multipass3dDepthSchema,
} from "../tools/layer1/createMultipass3dDepth.js";
import {
  createOpticalFlowImpl,
  createOpticalFlowSchema,
} from "../tools/layer1/createOpticalFlow.js";
import {
  createParticleFlockImpl,
  createParticleFlockSchema,
} from "../tools/layer1/createParticleFlock.js";
import {
  createParticleSystemImpl,
  createParticleSystemSchema,
} from "../tools/layer1/createParticleSystem.js";
import { createPbrSceneImpl, createPbrSceneSchema } from "../tools/layer1/createPbrScene.js";
import {
  createPhoneGestureImpl,
  createPhoneGestureSchema,
} from "../tools/layer1/createPhoneGesture.js";
import {
  createPhraseLockedCueEngineImpl,
  createPhraseLockedCueEngineSchema,
} from "../tools/layer1/createPhraseLockedCueEngine.js";
import { createPixelSortImpl, createPixelSortSchema } from "../tools/layer1/createPixelSort.js";
import { createPointCloudImpl, createPointCloudSchema } from "../tools/layer1/createPointCloud.js";
import {
  createPointerReactiveImpl,
  createPointerReactiveSchema,
} from "../tools/layer1/createPointerReactive.js";
import { createPopFieldImpl, createPopFieldSchema } from "../tools/layer1/createPopField.js";
import {
  createPopGeometryImpl,
  createPopGeometrySchema,
} from "../tools/layer1/createPopGeometry.js";
import { createPopGrowthImpl, createPopGrowthSchema } from "../tools/layer1/createPopGrowth.js";
import {
  createPopLinesPointcloudImpl,
  createPopLinesPointcloudSchema,
} from "../tools/layer1/createPopLinesPointcloud.js";
import {
  createPopParticleSystemImpl,
  createPopParticleSystemSchema,
} from "../tools/layer1/createPopParticleSystem.js";
import {
  createPoseControlnetDriverImpl,
  createPoseControlnetDriverSchema,
} from "../tools/layer1/createPoseControlnetDriver.js";
import {
  createPoseReactiveImpl,
  createPoseReactiveSchema,
} from "../tools/layer1/createPoseReactive.js";
import {
  createPoseSkeletonImpl,
  createPoseSkeletonSchema,
} from "../tools/layer1/createPoseSkeleton.js";
import {
  createPoseTrackingImpl,
  createPoseTrackingSchema,
} from "../tools/layer1/createPoseTracking.js";
import {
  createProbSequencerImpl,
  createProbSequencerSchema,
} from "../tools/layer1/createProbSequencer.js";
import {
  createProjectionMappingImpl,
  createProjectionMappingSchema,
} from "../tools/layer1/createProjectionMapping.js";
import {
  createRaymarchSceneImpl,
  createRaymarchSceneSchema,
} from "../tools/layer1/createRaymarchScene.js";
import { createRaytkSceneImpl, createRaytkSceneSchema } from "../tools/layer1/createRaytkScene.js";
import {
  createReactionDiffusionImpl,
  createReactionDiffusionSchema,
} from "../tools/layer1/createReactionDiffusion.js";
import {
  createSafetyBlackoutChainImpl,
  createSafetyBlackoutChainSchema,
} from "../tools/layer1/createSafetyBlackoutChain.js";
import { createSdfFieldImpl, createSdfFieldSchema } from "../tools/layer1/createSdfField.js";
import { createSdfTextImpl, createSdfTextSchema } from "../tools/layer1/createSdfText.js";
import {
  createSetlistRunnerImpl,
  createSetlistRunnerSchema,
} from "../tools/layer1/createSetlistRunner.js";
import {
  createSetNavigatorImpl,
  createSetNavigatorSchema,
} from "../tools/layer1/createSetNavigator.js";
import { createShaderLibImpl, createShaderLibSchema } from "../tools/layer1/createShaderLib.js";
import { createShaderParkImpl, createShaderParkSchema } from "../tools/layer1/createShaderPark.js";
import {
  createShowFailoverImpl,
  createShowFailoverSchema,
} from "../tools/layer1/createShowFailover.js";
import { createSimulationImpl, createSimulationSchema } from "../tools/layer1/createSimulation.js";
import { createSlitScanImpl, createSlitScanSchema } from "../tools/layer1/createSlitScan.js";
import { createSpectrumImpl, createSpectrumSchema } from "../tools/layer1/createSpectrum.js";
import { createStepRepeatImpl, createStepRepeatSchema } from "../tools/layer1/createStepRepeat.js";
import {
  createStipplePointcloudImpl,
  createStipplePointcloudSchema,
} from "../tools/layer1/createStipplePointcloud.js";
import {
  createStrangeAttractorImpl,
  createStrangeAttractorSchema,
} from "../tools/layer1/createStrangeAttractor.js";
import { createStrobeImpl, createStrobeSchema } from "../tools/layer1/createStrobe.js";
import {
  createSyncExternalClockImpl,
  createSyncExternalClockSchema,
} from "../tools/layer1/createSyncExternalClock.js";
import { createTempoSyncImpl, createTempoSyncSchema } from "../tools/layer1/createTempoSync.js";
import { createTerrainImpl, createTerrainSchema } from "../tools/layer1/createTerrain.js";
import {
  createTestPatternImpl,
  createTestPatternSchema,
} from "../tools/layer1/createTestPattern.js";
import { createText3dImpl, createText3dSchema } from "../tools/layer1/createText3d.js";
import { createTextCrawlImpl, createTextCrawlSchema } from "../tools/layer1/createTextCrawl.js";
import {
  createTextOverlayImpl,
  createTextOverlaySchema,
} from "../tools/layer1/createTextOverlay.js";
import {
  createTransientReactiveImpl,
  createTransientReactiveSchema,
} from "../tools/layer1/createTransientReactive.js";
import { createTransitionImpl, createTransitionSchema } from "../tools/layer1/createTransition.js";
import {
  createTwoWaySurfaceImpl,
  createTwoWaySurfaceSchema,
} from "../tools/layer1/createTwoWaySurface.js";
import {
  createVectorLinesImpl,
  createVectorLinesSchema,
} from "../tools/layer1/createVectorLines.js";
import {
  createVertexDisplacementMatImpl,
  createVertexDisplacementMatSchema,
} from "../tools/layer1/createVertexDisplacementMat.js";
import {
  createVideoPlayerImpl,
  createVideoPlayerSchema,
} from "../tools/layer1/createVideoPlayer.js";
import {
  createVideoScopesImpl,
  createVideoScopesSchema,
} from "../tools/layer1/createVideoScopes.js";
import { createVideoSynthImpl, createVideoSynthSchema } from "../tools/layer1/createVideoSynth.js";
import {
  createVintageLensImpl,
  createVintageLensSchema,
} from "../tools/layer1/createVintageLens.js";
import {
  createVisualSystemImpl,
  createVisualSystemSchema,
} from "../tools/layer1/createVisualSystem.js";
import {
  createVolumetricFieldImpl,
  createVolumetricFieldSchema,
} from "../tools/layer1/createVolumetricField.js";
import { createVoxelStackImpl, createVoxelStackSchema } from "../tools/layer1/createVoxelStack.js";
import { createWaveformImpl, createWaveformSchema } from "../tools/layer1/createWaveform.js";
import { describeProjectImpl, describeProjectSchema } from "../tools/layer1/describeProject.js";
import { detectOnsetsImpl, detectOnsetsSchema } from "../tools/layer1/detectOnsets.js";
import { detectPitchImpl, detectPitchSchema } from "../tools/layer1/detectPitch.js";
import { detectTempoImpl, detectTempoSchema } from "../tools/layer1/detectTempo.js";
import {
  driveStreamdiffusionImpl,
  driveStreamdiffusionSchema,
} from "../tools/layer1/driveStreamdiffusion.js";
import { enhanceBuildImpl, enhanceBuildSchema } from "../tools/layer1/enhanceBuild.js";
import {
  extractAudioFeaturesImpl,
  extractAudioFeaturesSchema,
} from "../tools/layer1/extractAudioFeatures.js";
import { getPreviewImpl, getPreviewSchema } from "../tools/layer1/getPreview.js";
import { importIsfShaderImpl, importIsfShaderSchema } from "../tools/layer1/importIsfShader.js";
import { importModelImpl, importModelSchema } from "../tools/layer1/importModel.js";
import { importShadertoyImpl, importShadertoySchema } from "../tools/layer1/importShadertoy.js";
import {
  lidarFloorTrackerImpl,
  lidarFloorTrackerSchema,
} from "../tools/layer1/lidarFloorTracker.js";
import { listRecipesImpl, listRecipesSchema } from "../tools/layer1/listRecipes.js";
import {
  moodboardToSystemImpl,
  moodboardToSystemSchema,
} from "../tools/layer1/moodboardToSystem.js";
import {
  projectorCalibrationWizardImpl,
  projectorCalibrationWizardSchema,
} from "../tools/layer1/projectorCalibrationWizard.js";
import {
  raytkExprGraphBuilderImpl,
  raytkExprGraphBuilderSchema,
} from "../tools/layer1/raytkExprGraphBuilder.js";
import { scaffoldGenreImpl, scaffoldGenreSchema } from "../tools/layer1/scaffoldGenre.js";
import { scaffoldShowImpl, scaffoldShowSchema } from "../tools/layer1/scaffoldShow.js";
import {
  setupBodyTrackingImpl,
  setupBodyTrackingSchema,
} from "../tools/layer1/setupBodyTracking.js";
import {
  setupMediapipePluginImpl,
  setupMediapipePluginSchema,
} from "../tools/layer1/setupMediapipePlugin.js";
import { setupOutputImpl, setupOutputSchema } from "../tools/layer1/setupOutput.js";
import { setupTdabletonImpl, setupTdabletonSchema } from "../tools/layer1/setupTdableton.js";
import {
  addCustomParametersImpl,
  addCustomParametersSchema,
} from "../tools/layer2/addCustomParameters.js";
import {
  addTimecodeOverlayImpl,
  addTimecodeOverlaySchema,
} from "../tools/layer2/addTimecodeOverlay.js";
import { animateParameterImpl, animateParameterSchema } from "../tools/layer2/animateParameter.js";
import { applyLutImpl, applyLutSchema } from "../tools/layer2/applyLut.js";
import { arrangeNetworkImpl, arrangeNetworkSchema } from "../tools/layer2/arrangeNetwork.js";
import {
  atemSwitcherControlImpl,
  atemSwitcherControlSchema,
} from "../tools/layer2/atemSwitcherControl.js";
import {
  authorScriptOperatorImpl,
  authorScriptOperatorSchema,
} from "../tools/layer2/authorScriptOperator.js";
import { autoRepairLoopImpl, autoRepairLoopSchema } from "../tools/layer2/autoRepairLoop.js";
import { autoUiFromParamsImpl, autoUiFromParamsSchema } from "../tools/layer2/autoUiFromParams.js";
import { batchOperationsImpl, batchOperationsSchema } from "../tools/layer2/batchOperations.js";
import {
  bindAudioReactiveImpl,
  bindAudioReactiveSchema,
} from "../tools/layer2/bindAudioReactive.js";
import { bindToChannelImpl, bindToChannelSchema } from "../tools/layer2/bindToChannel.js";
import { buildChopChainImpl, buildChopChainSchema } from "../tools/layer2/buildChopChain.js";
import { buildPopChainImpl, buildPopChainSchema } from "../tools/layer2/buildPopChain.js";
import { buildSopGeometryImpl, buildSopGeometrySchema } from "../tools/layer2/buildSopGeometry.js";
import {
  clipAudioTransportImpl,
  clipAudioTransportSchema,
} from "../tools/layer2/clipAudioTransport.js";
import { connectComfyuiImpl, connectComfyuiSchema } from "../tools/layer2/connectComfyui.js";
import {
  connectDaydreamCloudImpl,
  connectDaydreamCloudSchema,
} from "../tools/layer2/connectDaydreamCloud.js";
import { connectNodesImpl, connectNodesSchema } from "../tools/layer2/connectNodes.js";
import {
  createAudioGlslUniformsImpl,
  createAudioGlslUniformsSchema,
} from "../tools/layer2/createAudioGlslUniforms.js";
import {
  createAutoMontageImpl,
  createAutoMontageSchema,
} from "../tools/layer2/createAutoMontage.js";
// Campaign Wave 3 — artist controls (backlog 2026-05-29):
import { createBandRouterImpl, createBandRouterSchema } from "../tools/layer2/createBandRouter.js";
import {
  createBeatGridSequencerImpl,
  createBeatGridSequencerSchema,
} from "../tools/layer2/createBeatGridSequencer.js";
import {
  createCaptureLoopImpl,
  createCaptureLoopSchema,
} from "../tools/layer2/createCaptureLoop.js";
import {
  createClipLauncherImpl,
  createClipLauncherSchema,
} from "../tools/layer2/createClipLauncher.js";
import {
  createCompanionSurfaceImpl,
  createCompanionSurfaceSchema,
} from "../tools/layer2/createCompanionSurface.js";
import { createContainerImpl, createContainerSchema } from "../tools/layer2/createContainer.js";
import {
  createControlPanelImpl,
  createControlPanelSchema,
} from "../tools/layer2/createControlPanel.js";
import {
  createControlSurfaceImpl,
  createControlSurfaceSchema,
} from "../tools/layer2/createControlSurface.js";
import {
  createCueSequencerImpl,
  createCueSequencerSchema,
} from "../tools/layer2/createCueSequencer.js";
import {
  createDataReactiveImpl,
  createDataReactiveSchema,
} from "../tools/layer2/createDataReactive.js";
import { createDataSourceImpl, createDataSourceSchema } from "../tools/layer2/createDataSource.js";
import {
  createDataSourceHttpWsImpl,
  createDataSourceHttpWsSchema,
} from "../tools/layer2/createDataSourceHttpWs.js";
import { createDecksImpl, createDecksSchema } from "../tools/layer2/createDecks.js";
import {
  createEnvelopeFollowerImpl,
  createEnvelopeFollowerSchema,
} from "../tools/layer2/createEnvelopeFollower.js";
import {
  createEuclideanSequencerImpl,
  createEuclideanSequencerSchema,
} from "../tools/layer2/createEuclideanSequencer.js";
import { createExternalIoImpl, createExternalIoSchema } from "../tools/layer2/createExternalIo.js";
import {
  createFlowAbstractionImpl,
  createFlowAbstractionSchema,
} from "../tools/layer2/createFlowAbstraction.js";
import {
  createGlslMaterialImpl,
  createGlslMaterialSchema,
} from "../tools/layer2/createGlslMaterial.js";
import { createGlslShaderImpl, createGlslShaderSchema } from "../tools/layer2/createGlslShader.js";
import {
  createHandAbletonMapperImpl,
  createHandAbletonMapperSchema,
} from "../tools/layer2/createHandAbletonMapper.js";
import {
  createHandGestureBusImpl,
  createHandGestureBusSchema,
} from "../tools/layer2/createHandGestureBus.js";
import { createLedMapperImpl, createLedMapperSchema } from "../tools/layer2/createLedMapper.js";
import { createLlmChainImpl, createLlmChainSchema } from "../tools/layer2/createLlmChain.js";
import { createLookBankImpl, createLookBankSchema } from "../tools/layer2/createLookBank.js";
import { createMacroImpl, createMacroSchema } from "../tools/layer2/createMacro.js";
import { createMidiMapImpl, createMidiMapSchema } from "../tools/layer2/createMidiMap.js";
import { createModulatorsImpl, createModulatorsSchema } from "../tools/layer2/createModulators.js";
import { createNodeChainImpl, createNodeChainSchema } from "../tools/layer2/createNodeChain.js";
import { createNprFilterImpl, createNprFilterSchema } from "../tools/layer2/createNprFilter.js";
import { createPaletteImpl, createPaletteSchema } from "../tools/layer2/createPalette.js";
import { createPanicImpl, createPanicSchema } from "../tools/layer2/createPanic.js";
import {
  createPhoneRemoteImpl,
  createPhoneRemoteSchema,
} from "../tools/layer2/createPhoneRemote.js";
import {
  createPresetMorphImpl,
  createPresetMorphSchema,
} from "../tools/layer2/createPresetMorph.js";
import {
  createPythonScriptImpl,
  createPythonScriptSchema,
} from "../tools/layer2/createPythonScript.js";
import { createReplicatorImpl, createReplicatorSchema } from "../tools/layer2/createReplicator.js";
import {
  createSceneTimelineImpl,
  createSceneTimelineSchema,
} from "../tools/layer2/createSceneTimeline.js";
import { createSchedulerImpl, createSchedulerSchema } from "../tools/layer2/createScheduler.js";
import {
  createSharedMemoryBridgeImpl,
  createSharedMemoryBridgeSchema,
} from "../tools/layer2/createSharedMemoryBridge.js";
import {
  createSidechainPumpImpl,
  createSidechainPumpSchema,
} from "../tools/layer2/createSidechainPump.js";
import {
  createStageDashboardImpl,
  createStageDashboardSchema,
} from "../tools/layer2/createStageDashboard.js";
import {
  createSynesthesiaUnrealOscImpl,
  createSynesthesiaUnrealOscSchema,
} from "../tools/layer2/createSynesthesiaUnrealOsc.js";
import { createTimeEchoImpl, createTimeEchoSchema } from "../tools/layer2/createTimeEcho.js";
import { createXyPadImpl, createXyPadSchema } from "../tools/layer2/createXyPad.js";
import {
  diagnoseTdabletonMapperImpl,
  diagnoseTdabletonMapperSchema,
} from "../tools/layer2/diagnoseTdabletonMapper.js";
import { duplicateNetworkImpl, duplicateNetworkSchema } from "../tools/layer2/duplicateNetwork.js";
import {
  extendDataSourceFabricImpl,
  extendDataSourceFabricSchema,
} from "../tools/layer2/extendDataSourceFabric.js";
import {
  focusNetworkEditorImpl,
  focusNetworkEditorSchema,
} from "../tools/layer2/focusNetworkEditor.js";
import { learnControlImpl, learnControlSchema } from "../tools/layer2/learnControl.js";
import { manageAnnotationImpl, manageAnnotationSchema } from "../tools/layer2/manageAnnotation.js";
import { manageCheckpointImpl, manageCheckpointSchema } from "../tools/layer2/manageCheckpoint.js";
import { manageComponentImpl, manageComponentSchema } from "../tools/layer2/manageComponent.js";
import { manageCueImpl, manageCueSchema } from "../tools/layer2/manageCue.js";
import { managePresetsImpl, managePresetsSchema } from "../tools/layer2/managePresets.js";
import {
  notchTouchengineBridgeImpl,
  notchTouchengineBridgeSchema,
} from "../tools/layer2/notchTouchengineBridge.js";
import { obsStreamControlImpl, obsStreamControlSchema } from "../tools/layer2/obsStreamControl.js";
import { oscRouterMatrixImpl, oscRouterMatrixSchema } from "../tools/layer2/oscRouterMatrix.js";
import { postPasses3dImpl, postPasses3dSchema } from "../tools/layer2/postPasses3d.js";
import { qlabOscBridgeImpl, qlabOscBridgeSchema } from "../tools/layer2/qlabOscBridge.js";
import {
  randomizeControlsImpl,
  randomizeControlsSchema,
} from "../tools/layer2/randomizeControls.js";
import { rebuildNetworkImpl, rebuildNetworkSchema } from "../tools/layer2/rebuildNetwork.js";
import {
  resolumeVdmxOutputChainImpl,
  resolumeVdmxOutputChainSchema,
} from "../tools/layer2/resolumeVdmxOutputChain.js";
import {
  scaffoldExtensionImpl,
  scaffoldExtensionSchema,
} from "../tools/layer2/scaffoldExtension.js";
import {
  scaffoldToolGeneratorImpl,
  scaffoldToolGeneratorSchema,
} from "../tools/layer2/scaffoldToolGenerator.js";
import { scaffoldVjDeckImpl, scaffoldVjDeckSchema } from "../tools/layer2/scaffoldVjDeck.js";
import {
  setParametersBatchImpl,
  setParametersBatchSchema,
} from "../tools/layer2/setParametersBatch.js";
import { setPerformModeImpl, setPerformModeSchema } from "../tools/layer2/setPerformMode.js";
import {
  setupFaceTrackingImpl,
  setupFaceTrackingSchema,
} from "../tools/layer2/setupFaceTracking.js";
import {
  setupHandTrackingImpl,
  setupHandTrackingSchema,
} from "../tools/layer2/setupHandTracking.js";
import {
  setupSegmentationImpl,
  setupSegmentationSchema,
} from "../tools/layer2/setupSegmentation.js";
import { syncTimecodeImpl, syncTimecodeSchema } from "../tools/layer2/syncTimecode.js";
import { analyzeProjectImpl, analyzeProjectSchema } from "../tools/layer3/analyzeProject.js";
import {
  bundleDependenciesImpl,
  bundleDependenciesSchema,
} from "../tools/layer3/bundleDependencies.js";
import { captionTopImpl, captionTopSchema } from "../tools/layer3/captionTop.js";
import {
  checkOperatorAvailabilityImpl,
  checkOperatorAvailabilitySchema,
} from "../tools/layer3/checkOperatorAvailability.js";
import {
  collectProjectAssetsImpl,
  collectProjectAssetsSchema,
} from "../tools/layer3/collectProjectAssets.js";
import {
  compactGraphDigestImpl,
  compactGraphDigestSchema,
} from "../tools/layer3/compactGraphDigest.js";
import {
  compareOperatorDocsImpl,
  compareOperatorDocsSchema,
} from "../tools/layer3/compareOperatorDocs.js";
import { compareTdNodesImpl, compareTdNodesSchema } from "../tools/layer3/compareTdNodes.js";
import {
  controlTimelineTransportImpl,
  controlTimelineTransportSchema,
} from "../tools/layer3/controlTimelineTransport.js";
import { copilotVisionImpl, copilotVisionSchema } from "../tools/layer3/copilotVision.js";
import { createRaytkOpImpl, createRaytkOpSchema } from "../tools/layer3/createRaytkOp.js";
import { createTdNodeImpl, createTdNodeSchema } from "../tools/layer3/createTdNode.js";
import { deleteTdNodeImpl, deleteTdNodeSchema } from "../tools/layer3/deleteTdNode.js";
import {
  diagnoseHardwareEnvironmentImpl,
  diagnoseHardwareEnvironmentSchema,
} from "../tools/layer3/diagnoseHardwareEnvironment.js";
import { diffSnapshotsImpl, diffSnapshotsSchema } from "../tools/layer3/diffSnapshots.js";
import { disconnectNodesImpl, disconnectNodesSchema } from "../tools/layer3/disconnectNodes.js";
import { documentNetworkImpl, documentNetworkSchema } from "../tools/layer3/documentNetwork.js";
import {
  draftRecipeFromOperatorChainImpl,
  draftRecipeFromOperatorChainSchema,
} from "../tools/layer3/draftRecipeFromOperatorChain.js";
import {
  draftRecipeFromTechniqueImpl,
  draftRecipeFromTechniqueSchema,
} from "../tools/layer3/draftRecipeFromTechnique.js";
import {
  draftRecipeFromTutorialImpl,
  draftRecipeFromTutorialSchema,
} from "../tools/layer3/draftRecipeFromTutorial.js";
import { editDatContentImpl, editDatContentSchema } from "../tools/layer3/editDatContent.js";
import {
  editShaderLiveLoopImpl,
  editShaderLiveLoopSchema,
} from "../tools/layer3/editShaderLiveLoop.js";
import {
  elicitMissingArgsImpl,
  elicitMissingArgsSchema,
} from "../tools/layer3/elicitMissingArgs.js";
import { execNodeMethodImpl, execNodeMethodSchema } from "../tools/layer3/execNodeMethod.js";
import {
  executePythonScriptImpl,
  executePythonScriptSchema,
} from "../tools/layer3/executePythonScript.js";
import {
  exportRenderPresetImpl,
  exportRenderPresetSchema,
} from "../tools/layer3/exportRenderPreset.js";
import { exportSopToSvgImpl, exportSopToSvgSchema } from "../tools/layer3/exportSopToSvg.js";
import { extractPaletteImpl, extractPaletteSchema } from "../tools/layer3/extractPalette.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { generateReadmeImpl, generateReadmeSchema } from "../tools/layer3/generateReadme.js";
import { getBridgeLogsImpl, getBridgeLogsSchema } from "../tools/layer3/getBridgeLogs.js";
import { getDatContentImpl, getDatContentSchema } from "../tools/layer3/getDatContent.js";
import { getInlinePreviewImpl, getInlinePreviewSchema } from "../tools/layer3/getInlinePreview.js";
import { getModuleHelpImpl, getModuleHelpSchema } from "../tools/layer3/getModuleHelp.js";
import {
  getNodeStateRuntimeImpl,
  getNodeStateRuntimeSchema,
} from "../tools/layer3/getNodeStateRuntime.js";
import {
  getOperatorWorkflowGuideImpl,
  getOperatorWorkflowGuideSchema,
} from "../tools/layer3/getOperatorWorkflowGuide.js";
import { getParameterMenuImpl, getParameterMenuSchema } from "../tools/layer3/getParameterMenu.js";
import {
  getTdClassDetailsImpl,
  getTdClassDetailsSchema,
} from "../tools/layer3/getTdClassDetails.js";
import { getTdClassesImpl, getTdClassesSchema } from "../tools/layer3/getTdClasses.js";
import { getTdInfoImpl } from "../tools/layer3/getTdInfo.js";
import { getTdNodeErrorsImpl, getTdNodeErrorsSchema } from "../tools/layer3/getTdNodeErrors.js";
import { getTdNodeFlagsImpl, getTdNodeFlagsSchema } from "../tools/layer3/getTdNodeFlags.js";
import {
  getTdNodeParametersImpl,
  getTdNodeParametersSchema,
} from "../tools/layer3/getTdNodeParameters.js";
import { getTdNodesImpl, getTdNodesSchema } from "../tools/layer3/getTdNodes.js";
import { getTdPerformanceImpl, getTdPerformanceSchema } from "../tools/layer3/getTdPerformance.js";
import { getTdTopologyImpl, getTdTopologySchema } from "../tools/layer3/getTdTopology.js";
import {
  getTechniqueDetailImpl,
  getTechniqueDetailSchema,
} from "../tools/layer3/getTechniqueDetail.js";
import { getTutorialImpl, getTutorialSchema } from "../tools/layer3/getTutorial.js";
import { inspectComponentImpl, inspectComponentSchema } from "../tools/layer3/inspectComponent.js";
import {
  inspectGpuAndDisplaysImpl,
  inspectGpuAndDisplaysSchema,
} from "../tools/layer3/inspectGpuAndDisplays.js";
import {
  lintRecipeLibraryImpl,
  lintRecipeLibrarySchema,
} from "../tools/layer3/lintRecipeLibrary.js";
import {
  manageComponentStorageImpl,
  manageComponentStorageSchema,
} from "../tools/layer3/manageComponentStorage.js";
import { managePackagesImpl, managePackagesSchema } from "../tools/layer3/managePackages.js";
import {
  optimizePerformanceImpl,
  optimizePerformanceSchema,
} from "../tools/layer3/optimizePerformance.js";
import {
  planTdVersionMigrationImpl,
  planTdVersionMigrationSchema,
} from "../tools/layer3/planTdVersionMigration.js";
import { profileCookCostImpl, profileCookCostSchema } from "../tools/layer3/profileCookCost.js";
import {
  projectDocumentationSiteImpl,
  projectDocumentationSiteSchema,
} from "../tools/layer3/projectDocumentationSite.js";
import {
  readParameterModesImpl,
  readParameterModesSchema,
} from "../tools/layer3/readParameterModes.js";
import { recordMovieImpl, recordMovieSchema } from "../tools/layer3/recordMovie.js";
import { reloadBridgeImpl, reloadBridgeSchema } from "../tools/layer3/reloadBridge.js";
import { renderOutputImpl, renderOutputSchema } from "../tools/layer3/renderOutput.js";
import { repairNetworkImpl, repairNetworkSchema } from "../tools/layer3/repairNetwork.js";
import { scoreBuildImpl, scoreBuildSchema } from "../tools/layer3/scoreBuild.js";
import { searchOperatorsImpl, searchOperatorsSchema } from "../tools/layer3/searchOperators.js";
import { searchPythonApiImpl, searchPythonApiSchema } from "../tools/layer3/searchPythonApi.js";
import {
  searchTouchDesignerKnowledgeImpl,
  searchTouchDesignerKnowledgeSchema,
} from "../tools/layer3/searchTouchDesignerKnowledge.js";
import { serializeNetworkImpl, serializeNetworkSchema } from "../tools/layer3/serializeNetwork.js";
import { setDatContentImpl, setDatContentSchema } from "../tools/layer3/setDatContent.js";
import {
  setParameterExpressionImpl,
  setParameterExpressionSchema,
} from "../tools/layer3/setParameterExpression.js";
import {
  showPreflightReportImpl,
  showPreflightReportSchema,
} from "../tools/layer3/showPreflightReport.js";
import { snapshotTdGraphImpl, snapshotTdGraphSchema } from "../tools/layer3/snapshotTdGraph.js";
import {
  suggestOperatorChainImpl,
  suggestOperatorChainSchema,
} from "../tools/layer3/suggestOperatorChain.js";
import {
  summarizeTdErrorsImpl,
  summarizeTdErrorsSchema,
} from "../tools/layer3/summarizeTdErrors.js";
import { swapOperatorImpl, swapOperatorSchema } from "../tools/layer3/swapOperator.js";
import {
  updateTdNodeParametersImpl,
  updateTdNodeParametersSchema,
} from "../tools/layer3/updateTdNodeParameters.js";
import {
  validateOperatorChainImpl,
  validateOperatorChainSchema,
} from "../tools/layer3/validateOperatorChain.js";
import { watchNodeImpl, watchNodeSchema } from "../tools/layer3/watchNode.js";
import {
  watchParameterChangesImpl,
  watchParameterChangesSchema,
} from "../tools/layer3/watchParameterChanges.js";
import { writeAgentGuideImpl, writeAgentGuideSchema } from "../tools/layer3/writeAgentGuide.js";
import {
  checksumAndVerifyPackImpl,
  checksumAndVerifyPackSchema,
} from "../tools/library/checksumAndVerifyPack.js";
import {
  componentChangelogTrailImpl,
  componentChangelogTrailSchema,
} from "../tools/library/componentChangelogTrail.js";
import {
  curatedCollectionPackImpl,
  curatedCollectionPackSchema,
} from "../tools/library/curatedCollectionPack.js";
import {
  diffLibraryAssetsImpl,
  diffLibraryAssetsSchema,
} from "../tools/library/diffLibraryAssets.js";
import {
  exportExternalizedTreeImpl,
  exportExternalizedTreeSchema,
} from "../tools/library/exportExternalizedTree.js";
import {
  exportPaletteComponentImpl,
  exportPaletteComponentSchema,
} from "../tools/library/exportPaletteComponent.js";
import {
  generativeClassicsPackImpl,
  generativeClassicsPackSchema,
} from "../tools/library/generativeClassicsPack.js";
import {
  importRecipeFromUrlImpl,
  importRecipeFromUrlSchema,
} from "../tools/library/importRecipeFromUrl.js";
import {
  attachDocsAsAssetsImpl,
  attachDocsAsAssetsSchema,
  browseLibraryImpl,
  browseLibrarySchema,
  componentLinkHealthImpl,
  componentLinkHealthSchema,
  exportRecipeBundleImpl,
  exportRecipeBundleSchema,
  importRecipeBundleImpl,
  importRecipeBundleSchema,
  inspectComponentManifestImpl,
  inspectComponentManifestSchema,
  installLibraryPackageImpl,
  installLibraryPackageSchema,
  localMarketplaceIndexImpl,
  localMarketplaceIndexSchema,
  makePortableToxImpl,
  makePortableToxSchema,
  publishRecipeBundleImpl,
  publishRecipeBundleSchema,
  refreshAssetPreviewsImpl,
  refreshAssetPreviewsSchema,
  scaffoldRecipeTemplateImpl,
  scaffoldRecipeTemplateSchema,
  validateLibraryAssetImpl,
  validateLibraryAssetSchema,
} from "../tools/library/index.js";
import {
  marketplaceIndexSeedImpl,
  marketplaceIndexSeedSchema,
} from "../tools/library/marketplaceIndexSeed.js";
import { provenanceStampImpl, provenanceStampSchema } from "../tools/library/provenanceStamp.js";
import type { ToolContext } from "../tools/types.js";
import {
  applyShaderFromVaultImpl,
  applyShaderFromVaultSchema,
} from "../tools/vault/applyShaderFromVault.js";
import {
  autoTagLibraryAssetImpl,
  autoTagLibraryAssetSchema,
} from "../tools/vault/autoTagLibraryAsset.js";
import { bindVaultTextImpl, bindVaultTextSchema } from "../tools/vault/bindVaultText.js";
import {
  browseVaultLibraryImpl,
  browseVaultLibrarySchema,
} from "../tools/vault/browseVaultLibrary.js";
import { captureToVaultImpl, captureToVaultSchema } from "../tools/vault/captureToVault.js";
import { exportLookToxImpl, exportLookToxSchema } from "../tools/vault/exportLookTox.js";
import {
  exportNetworkToVaultImpl,
  exportNetworkToVaultSchema,
} from "../tools/vault/exportNetworkToVault.js";
import {
  exportSetlistToVaultImpl,
  exportSetlistToVaultSchema,
} from "../tools/vault/exportSetlistToVault.js";
import {
  generateFromMoodboardImpl,
  generateFromMoodboardSchema,
} from "../tools/vault/generateFromMoodboard.js";
import {
  generateLibraryIndexImpl,
  generateLibraryIndexSchema,
} from "../tools/vault/generateLibraryIndex.js";
import { importSetlistImpl, importSetlistSchema } from "../tools/vault/importSetlist.js";
import { learnConventionsImpl, learnConventionsSchema } from "../tools/vault/learnConventions.js";
import {
  learnFromMyCorpusImpl,
  learnFromMyCorpusSchema,
} from "../tools/vault/learnFromMyCorpus.js";
import {
  libraryLineageGraphImpl,
  libraryLineageGraphSchema,
} from "../tools/vault/libraryLineageGraph.js";
import { logPerformanceImpl, logPerformanceSchema } from "../tools/vault/logPerformance.js";
import { mergeVaultsImpl, mergeVaultsSchema } from "../tools/vault/mergeVaults.js";
import { morphPackImpl, morphPackSchema } from "../tools/vault/morphPack.js";
import {
  recallSimilarWorkImpl,
  recallSimilarWorkSchema,
} from "../tools/vault/recallSimilarWork.js";
import {
  saveComponentToVaultImpl,
  saveComponentToVaultSchema,
} from "../tools/vault/saveComponentToVault.js";
import {
  saveRecipeToVaultImpl,
  saveRecipeToVaultSchema,
} from "../tools/vault/saveRecipeToVault.js";
import {
  scaffoldRecipeFromNetworkImpl,
  scaffoldRecipeFromNetworkSchema,
} from "../tools/vault/scaffoldRecipeFromNetwork.js";
import { scaffoldVaultImpl, scaffoldVaultSchema } from "../tools/vault/scaffoldVault.js";
import { styleMemoryImpl, styleMemorySchema } from "../tools/vault/styleMemory.js";
import { syncPresetsVaultImpl, syncPresetsVaultSchema } from "../tools/vault/syncPresetsVault.js";
import {
  tagAndSearchLibraryImpl,
  tagAndSearchLibrarySchema,
} from "../tools/vault/tagAndSearchLibrary.js";
import {
  tutorialCompanionPackImpl,
  tutorialCompanionPackSchema,
} from "../tools/vault/tutorialCompanionPack.js";
import { variantPackImpl, variantPackSchema } from "../tools/vault/variantPack.js";
import { vaultRepoSyncImpl, vaultRepoSyncSchema } from "../tools/vault/vaultRepoSync.js";
import {
  versionLibraryAssetImpl,
  versionLibraryAssetSchema,
} from "../tools/vault/versionLibraryAsset.js";
import {
  describeConfig,
  type LoadConfigOptions,
  listConfigProfiles,
  loadConfig,
  type TdmcpConfig,
  tdBaseUrl,
} from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { runBridgeWatchBuild } from "./bridgeWatchBuild.js";
import { runConfigInit } from "./configInit.js";
import { controllerBridgeCliSchema, runControllerBridge } from "./controllerToCliBridge.js";
import { runDoctor } from "./doctor.js";
import { classifyTdErrorExit } from "./exitCodes.js";
import { runFixtureRecorder } from "./fixtureRecorder.js";
import { runLogTailFiltered } from "./logTailFiltered.js";
import { type PanicSubVerb, runPanic } from "./panicBlackout.js";
import { runPreviewInline } from "./previewInline.js";
import { runRemoteFanout } from "./remoteAndFanout.js";
import {
  loadScheduleFile,
  realClock,
  runScheduler,
  schedulerCliSchema,
  tzInfo,
} from "./scheduler.js";
import {
  type CueCaller,
  loadCanonicalSetlist,
  parseSetlistInput,
  runSetlist,
  setlistRunnerCliSchema,
} from "./setlistRunner.js";
import { runSoundcheckMonitor, soundcheckMonitorSchema } from "./soundcheckMonitor.js";
import { runVoiceCopilotChat } from "./voiceCopilotChat.js";

// biome-ignore lint/suspicious/noExplicitAny: args are validated by each command's zod schema before use.
type Runner = (ctx: ToolContext, args: any) => CallToolResult | Promise<CallToolResult>;

interface Command {
  schema: z.ZodTypeAny;
  run: Runner;
  summary: string;
  mutates: boolean;
  unsafe: boolean;
}

const showDirectorCliSchema = z.object({
  intent: ShowIntentSchema.optional().describe(
    "Structured AI Show Director intent to validate and policy-check.",
  ),
  state: ShowDirectorStateSchema.optional().describe("Prior show-director queue/log state."),
  policy: EffectPolicySchema.optional().describe(
    "Optional effect policy override for dry-run tests.",
  ),
  mixer_scene_catalog: MixerSceneManifestSchema.optional().describe(
    "Trusted venue Soundcraft Ui24R scene catalog/manifest. Defaults to the built-in demo manifest when omitted; required for arm_mixer_scene approvals.",
  ),
  operator: z.string().trim().min(1).optional().describe("Human operator resolving approval."),
});

const aiPartyPocCliSchema = AiPartyPocRunSchema.describe(
  "Offline producer POC rehearsal runner. Uses built-in demo events when `events` is omitted.",
);

export interface AgentCommandCatalogEntry {
  command: string;
  summary: string;
  mutates: boolean;
  unsafe: boolean;
  source: "tool" | "cli";
}

const r = (
  schema: z.ZodTypeAny,
  run: Runner,
  summary: string,
  opts: { mutates?: boolean; unsafe?: boolean } = {},
): Command => ({ schema, run, summary, mutates: !!opts.mutates, unsafe: !!opts.unsafe });

/** Static command tree — each entry maps 1:1 onto an existing MCP tool handler. */
const COMMANDS: Record<string, Command> = {
  info: r(z.object({}), (ctx) => getTdInfoImpl(ctx), "Health check + TD/bridge info."),
  reload: r(
    reloadBridgeSchema,
    reloadBridgeImpl,
    "Hot-reload the bridge's Python after editing td/.",
  ),
  "nodes list": r(
    getTdNodesSchema,
    getTdNodesImpl,
    "List a COMP's child nodes (summary by default).",
  ),
  "nodes find": r(findTdNodesSchema, findTdNodesImpl, "Search nodes by name pattern and/or type."),
  "nodes get": r(getTdNodeParametersSchema, getTdNodeParametersImpl, "Read a node's parameters."),
  "nodes errors": r(getTdNodeErrorsSchema, getTdNodeErrorsImpl, "Check a node/network for errors."),
  "nodes flags": r(
    getTdNodeFlagsSchema,
    getTdNodeFlagsImpl,
    "Inspect node flags + wiring (why-is-it-black).",
  ),
  "nodes compare": r(compareTdNodesSchema, compareTdNodesImpl, "Diff two nodes' parameters."),
  "nodes snapshot": r(snapshotTdGraphSchema, snapshotTdGraphImpl, "Capture a network snapshot."),
  digest: r(
    compactGraphDigestSchema,
    compactGraphDigestImpl,
    "Tiny token-bounded structural digest of a network.",
  ),
  "nodes topology": r(getTdTopologySchema, getTdTopologyImpl, "Map nodes + connections."),
  "nodes performance": r(getTdPerformanceSchema, getTdPerformanceImpl, "Report cook times."),
  "nodes update": r(
    updateTdNodeParametersSchema,
    updateTdNodeParametersImpl,
    "Set node parameters.",
    { mutates: true },
  ),
  "nodes create": r(createTdNodeSchema, createTdNodeImpl, "Create an operator.", { mutates: true }),
  "nodes delete": r(deleteTdNodeSchema, deleteTdNodeImpl, "Delete a node.", { mutates: true }),
  "errors summarize": r(
    summarizeTdErrorsSchema,
    summarizeTdErrorsImpl,
    "Cluster network errors by cause.",
  ),
  "show-preflight": r(
    showPreflightReportSchema,
    showPreflightReportImpl,
    "Run a read-only PASS/UNVERIFIED/WARN/FAIL pre-show check.",
  ),
  "classes list": r(getTdClassesSchema, getTdClassesImpl, "List TD Python API classes (offline)."),
  "classes get": r(
    getTdClassDetailsSchema,
    getTdClassDetailsImpl,
    "Get one Python class (offline).",
  ),
  "module help": r(
    getModuleHelpSchema,
    getModuleHelpImpl,
    "Human-readable help for a class (offline).",
  ),
  operators: r(
    searchOperatorsSchema,
    searchOperatorsImpl,
    "Search the operator knowledge base by keyword (offline).",
  ),
  "operators compare-docs": r(
    compareOperatorDocsSchema,
    compareOperatorDocsImpl,
    "Compare two operator docs from offline knowledge.",
  ),
  "operators guide": r(
    getOperatorWorkflowGuideSchema,
    getOperatorWorkflowGuideImpl,
    "Get operator connections, examples, and next-operator suggestions (offline).",
  ),
  "operators suggest-chain": r(
    suggestOperatorChainSchema,
    suggestOperatorChainImpl,
    "Suggest a read-only operator chain for a creative or technical goal (offline).",
  ),
  "operators validate-chain": r(
    validateOperatorChainSchema,
    validateOperatorChainImpl,
    "Validate an ordered operator chain before creating nodes (offline).",
  ),
  "techniques get": r(
    getTechniqueDetailSchema,
    getTechniqueDetailImpl,
    "Inspect TouchDesigner technique packs and individual techniques (offline).",
  ),
  "techniques draft-recipe": r(
    draftRecipeFromTechniqueSchema,
    draftRecipeFromTechniqueImpl,
    "Draft a RecipeSchema JSON from a TouchDesigner technique (offline).",
  ),
  "tutorials get": r(
    getTutorialSchema,
    getTutorialImpl,
    "List, search, or retrieve TouchDesigner tutorials (offline).",
  ),
  "tutorials draft-recipe": r(
    draftRecipeFromTutorialSchema,
    draftRecipeFromTutorialImpl,
    "Draft a RecipeSchema JSON from a TouchDesigner tutorial (offline).",
  ),
  "knowledge search": r(
    searchTouchDesignerKnowledgeSchema,
    searchTouchDesignerKnowledgeImpl,
    "Search embedded TD operators, versions, compatibility notes, techniques, and classes.",
  ),
  "versions migration-plan": r(
    planTdVersionMigrationSchema,
    planTdVersionMigrationImpl,
    "Plan a TD version migration from release and compatibility notes (offline).",
  ),
  "classes search": r(
    searchPythonApiSchema,
    searchPythonApiImpl,
    "Search TD Python API classes, methods, and members (offline).",
  ),
  document: r(
    documentNetworkSchema,
    documentNetworkImpl,
    "Document a network (summary + mermaid).",
  ),
  diff: r(diffSnapshotsSchema, diffSnapshotsImpl, "Diff two network snapshots (offline)."),
  optimize: r(
    optimizePerformanceSchema,
    optimizePerformanceImpl,
    "Find (and optionally fix) cook-time bottlenecks.",
    { mutates: true },
  ),
  render: r(renderOutputSchema, renderOutputImpl, "Save a TOP to a file at full resolution."),
  "check-optypes": r(
    checkOperatorAvailabilitySchema,
    checkOperatorAvailabilityImpl,
    "Reconcile the operator knowledge base against the live TD's creatable optypes.",
  ),
  movie: r(recordMovieSchema, recordMovieImpl, "Record a TOP to a movie/sequence (start/stop).", {
    mutates: true,
  }),
  "export-render-preset": r(
    exportRenderPresetSchema,
    exportRenderPresetImpl,
    "Record a TOP with a named VJ/editorial export preset.",
    { mutates: true },
  ),
  recipes: r(listRecipesSchema, listRecipesImpl, "List the built-in recipe library (offline)."),
  "recipes draft-chain": r(
    draftRecipeFromOperatorChainSchema,
    draftRecipeFromOperatorChainImpl,
    "Draft a RecipeSchema JSON from an operator chain without applying it.",
  ),
  recipe: r(applyRecipeSchema, applyRecipeImpl, "Build a recipe by id.", { mutates: true }),
  init: r(
    scaffoldShowSchema,
    scaffoldShowImpl,
    "Scaffold a show skeleton (master output + beat clock).",
    {
      mutates: true,
    },
  ),
  "exec python": r(
    executePythonScriptSchema,
    executePythonScriptImpl,
    "Escape hatch: run arbitrary Python in TD.",
    { mutates: true, unsafe: true },
  ),
  "exec node-method": r(
    execNodeMethodSchema,
    execNodeMethodImpl,
    "Escape hatch: call a Python method on a node.",
    { mutates: true, unsafe: true },
  ),
  // Layer 1 — high-level generators (each builds a whole network, verifies, previews).
  visual: r(
    createVisualSystemSchema,
    createVisualSystemImpl,
    "Build a visual system from a description.",
    { mutates: true },
  ),
  feedback: r(createFeedbackNetworkSchema, createFeedbackNetworkImpl, "Build a feedback network.", {
    mutates: true,
  }),
  generative: r(
    createGenerativeArtSchema,
    createGenerativeArtImpl,
    "Build a generative-art system.",
    { mutates: true },
  ),
  particles: r(createParticleSystemSchema, createParticleSystemImpl, "Build a particle system.", {
    mutates: true,
  }),
  "audio-reactive": r(
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    "Build an audio-reactive visual.",
    { mutates: true },
  ),
  "audio-features": r(
    extractAudioFeaturesSchema,
    extractAudioFeaturesImpl,
    "Extract reactive channels (level/bass/mid/treble) to bind to params.",
    { mutates: true },
  ),
  "motion-reactive": r(
    createMotionReactiveSchema,
    createMotionReactiveImpl,
    "Extract camera reactive channels (brightness/motion) to bind to params.",
    { mutates: true },
  ),
  "interactive-projection": r(
    createInteractiveProjectionMappingSchema,
    createInteractiveProjectionMappingImpl,
    "Build a synthetic-safe camera/projector interactive projection mapping rig.",
    { mutates: true },
  ),
  "kinect-wall-harp": r(
    createKinectWallHarpSchema,
    createKinectWallHarpImpl,
    "Build a Kinect v2/FreenectTD projected wall harp with two-hand zone triggers and internal pluck synth.",
    { mutates: true },
  ),
  "tempo-sync": r(
    createTempoSyncSchema,
    createTempoSyncImpl,
    "Create a beat clock (ramp/pulse/beat/bar/bpm) + optional beat events.",
    { mutates: true },
  ),
  "clock-sync": r(
    createSyncExternalClockSchema,
    createSyncExternalClockImpl,
    "Drive the global tempo from a Bpm knob + tap-tempo (beat-match the DJ).",
    { mutates: true },
  ),
  dataviz: r(
    createDataVisualizationSchema,
    createDataVisualizationImpl,
    "Build a data visualization.",
    { mutates: true },
  ),
  mixer: r(
    createLayerMixerSchema,
    createLayerMixerImpl,
    "Build a VJ layer mixer (crossfade/blend).",
    {
      mutates: true,
    },
  ),
  video: r(
    createVideoPlayerSchema,
    createVideoPlayerImpl,
    "Build a movie/clip player (+playlist).",
    {
      mutates: true,
    },
  ),
  scene3d: r(create3dSceneSchema, create3dSceneImpl, "Build a renderable 3D scene.", {
    mutates: true,
  }),
  // Phase 12 — dimensional (3D, depth & spatial mapping):
  audio3d: r(
    create3dAudioReactiveSchema,
    create3dAudioReactiveImpl,
    "Build a 3D scene that reacts to sound (instanced FFT bars / bass pulse).",
    { mutates: true },
  ),
  dome: r(
    createDomeOutputSchema,
    createDomeOutputImpl,
    "Remap a source to fisheye/equirectangular for dome / 360 output.",
    { mutates: true },
  ),
  "mesh-warp": r(
    createMeshWarpSchema,
    createMeshWarpImpl,
    "Map a source onto a deformable curved grid (dome/column/sculpture).",
    { mutates: true },
  ),
  "depth-displace": r(
    createDepthDisplacementSchema,
    createDepthDisplacementImpl,
    "Displace a plane into 3D by a depth/luminance map (2.5D relief).",
    { mutates: true },
  ),
  "gpu-particles": r(
    createGpuParticleFieldSchema,
    createGpuParticleFieldImpl,
    "GPU particle field via feedback TOPs + instancing (experimental).",
    { mutates: true },
  ),
  text: r(
    createTextOverlaySchema,
    createTextOverlayImpl,
    "Composite styled text over a visual (lyrics/titles/credits).",
    { mutates: true },
  ),
  mapping: r(
    createProjectionMappingSchema,
    createProjectionMappingImpl,
    "Wrap a source in a corner-pin for projection mapping.",
    { mutates: true },
  ),
  "projector-calibration": r(
    projectorCalibrationWizardSchema,
    projectorCalibrationWizardImpl,
    "Build a multi-projector calibration scaffold with corner-pin lanes.",
    { mutates: true },
  ),
  keyframe: r(
    createKeyframeAnimationSchema,
    createKeyframeAnimationImpl,
    "Animate parameters along a keyframed curve (synced/looping).",
    { mutates: true },
  ),
  simulation: r(
    createSimulationSchema,
    createSimulationImpl,
    "Build a GPU simulation (RD/slime/fluid).",
    {
      mutates: true,
    },
  ),
  "post-fx": r(
    applyPostProcessingSchema,
    applyPostProcessingImpl,
    "Apply post-processing (bloom/blur/…).",
    { mutates: true },
  ),
  output: r(setupOutputSchema, setupOutputImpl, "Set up a window / NDI / Syphon-Spout output.", {
    mutates: true,
  }),
  "multi-output": r(
    createMultiOutputSchema,
    createMultiOutputImpl,
    "Fan a master TOP across N projectors (cropped tiles + optional windows).",
    { mutates: true },
  ),
  plan: r(
    describeProjectSchema,
    describeProjectImpl,
    "Plan which tool/recipe builds a described visual (creates nothing).",
  ),
  // Layer 2 — building blocks.
  animate: r(animateParameterSchema, animateParameterImpl, "Drive parameters with an LFO.", {
    mutates: true,
  }),
  bind: r(
    bindToChannelSchema,
    bindToChannelImpl,
    "Bind parameters to a CHOP channel (audio feature / beat) by expression.",
    { mutates: true },
  ),
  arrange: r(arrangeNetworkSchema, arrangeNetworkImpl, "Auto-arrange a network left→right.", {
    mutates: true,
  }),
  connect: r(connectNodesSchema, connectNodesImpl, "Wire two nodes together.", { mutates: true }),
  container: r(createContainerSchema, createContainerImpl, "Create a COMP container.", {
    mutates: true,
  }),
  "control-panel": r(
    createControlPanelSchema,
    createControlPanelImpl,
    "Add bound custom-parameter controls to a COMP.",
    { mutates: true },
  ),
  "auto-ui-from-params": r(
    autoUiFromParamsSchema,
    autoUiFromParamsImpl,
    "Generate a playable control panel from a node's parameters.",
    { mutates: true },
  ),
  "companion-surface": r(
    createCompanionSurfaceSchema,
    createCompanionSurfaceImpl,
    "Create a companion auto UI, fader surface, and preflight report.",
    { mutates: true },
  ),
  surface: r(
    createControlSurfaceSchema,
    createControlSurfaceImpl,
    "Build a playable panel: faders + cue buttons.",
    { mutates: true },
  ),
  "clip-transport": r(
    clipAudioTransportSchema,
    clipAudioTransportImpl,
    "Build a movie/audio clip transport with Play, Loop, and Speed controls.",
    { mutates: true },
  ),
  "osc-router": r(
    oscRouterMatrixSchema,
    oscRouterMatrixImpl,
    "Build an OSC control matrix for one or more external targets.",
    { mutates: true },
  ),
  "qlab-osc": r(
    qlabOscBridgeSchema,
    qlabOscBridgeImpl,
    "Build a QLab OSC bridge with transport and cue-start routes.",
    { mutates: true },
  ),
  "atem-switcher-control": r(
    atemSwitcherControlSchema,
    atemSwitcherControlImpl,
    "Build an atemOSC/Companion switcher-control preset.",
    { mutates: true },
  ),
  "resolume-vdmx-output": r(
    resolumeVdmxOutputChainSchema,
    resolumeVdmxOutputChainImpl,
    "Build Resolume/VDMX OSC output-control lanes.",
    { mutates: true },
  ),
  "obs-stream-control": r(
    obsStreamControlSchema,
    obsStreamControlImpl,
    "Build an OBS WebSocket stream/record/scene control rig.",
    { mutates: true },
  ),
  remote: r(
    createPhoneRemoteSchema,
    createPhoneRemoteImpl,
    "Serve a phone web panel for a COMP's controls.",
    { mutates: true },
  ),
  io: r(
    createExternalIoSchema,
    createExternalIoImpl,
    "Bridge OSC/MIDI in, DMX out, NDI/Syphon in.",
    {
      mutates: true,
    },
  ),
  glsl: r(createGlslShaderSchema, createGlslShaderImpl, "Create a GLSL TOP shader.", {
    mutates: true,
  }),
  "create-audio-glsl-uniforms": r(
    createAudioGlslUniformsSchema,
    createAudioGlslUniformsImpl,
    "Bind audio CHOP channels to GLSL TOP uniform slots.",
    { mutates: true },
  ),
  chain: r(createNodeChainSchema, createNodeChainImpl, "Create a chain of connected nodes.", {
    mutates: true,
  }),
  script: r(
    createPythonScriptSchema,
    createPythonScriptImpl,
    "Create a DAT preloaded with Python.",
    {
      mutates: true,
    },
  ),
  duplicate: r(duplicateNetworkSchema, duplicateNetworkImpl, "Duplicate a network.", {
    mutates: true,
  }),
  component: r(manageComponentSchema, manageComponentImpl, "Save/load a COMP as a .tox.", {
    mutates: true,
  }),
  "add-params": r(
    addCustomParametersSchema,
    addCustomParametersImpl,
    "Append a custom-parameter page (knobs/menus/toggles/pulses) to a COMP.",
    { mutates: true },
  ),
  "scaffold-ext": r(
    scaffoldExtensionSchema,
    scaffoldExtensionImpl,
    "Give a COMP a Python extension class (behavior/methods).",
    { mutates: true },
  ),
  checkpoint: r(
    manageCheckpointSchema,
    manageCheckpointImpl,
    "Store/restore a full sub-network snapshot (undo point).",
    { mutates: true },
  ),
  preset: r(managePresetsSchema, managePresetsImpl, "Store/recall/list/delete COMP presets.", {
    mutates: true,
  }),
  cue: r(
    manageCueSchema,
    manageCueImpl,
    "Scene system: store/recall/morph/list/delete cues (timed crossfade).",
    { mutates: true },
  ),
  macro: r(createMacroSchema, createMacroImpl, "Add one knob that drives many parameters.", {
    mutates: true,
  }),
  modulators: r(
    createModulatorsSchema,
    createModulatorsImpl,
    "Build a bank of BPM-synced LFOs on one Null (the 'everything breathes' lever).",
    { mutates: true },
  ),
  "look-bank": r(
    createLookBankSchema,
    createLookBankImpl,
    "Snapshot/morph look bank: store, recall, A↔B blend named looks on a control COMP.",
    { mutates: true },
  ),
  randomize: r(
    randomizeControlsSchema,
    randomizeControlsImpl,
    "Randomize a COMP's numeric controls within range.",
    { mutates: true },
  ),
  autopilot: r(
    createAutopilotSchema,
    createAutopilotImpl,
    "Beat-driven auto-VJ: every N beats randomize controls or cycle cues.",
    { mutates: true },
  ),
  params: r(
    setParametersBatchSchema,
    setParametersBatchImpl,
    "Set many parameters across nodes at once.",
    { mutates: true },
  ),
  // Signature effects, deeper reactivity, creation, live control (waves 1–5).
  strobe: r(createStrobeSchema, createStrobeImpl, "Build a beat-syncable strobe/flash layer.", {
    mutates: true,
  }),
  kaleidoscope: r(
    createKaleidoscopeSchema,
    createKaleidoscopeImpl,
    "Wrap a source in an N-fold kaleidoscope (radial mirror).",
    { mutates: true },
  ),
  glitch: r(
    createGlitchSchema,
    createGlitchImpl,
    "Apply a glitch look (RGB-shift + noise displacement).",
    { mutates: true },
  ),
  spectrum: r(
    createSpectrumSchema,
    createSpectrumImpl,
    "Extract an N-band FFT spectrum to bind per-band.",
    { mutates: true },
  ),
  onsets: r(
    detectOnsetsSchema,
    detectOnsetsImpl,
    "Detect kick/snare/hat onsets (per-band pulse + optional events).",
    { mutates: true },
  ),
  waveform: r(
    createWaveformSchema,
    createWaveformImpl,
    "Render a time-domain audio oscilloscope/waveform.",
    { mutates: true },
  ),
  colorgrade: r(
    createColorGradeSchema,
    createColorGradeImpl,
    "Color-grade a source (lift/gamma/gain + saturation/hue + LUT).",
    { mutates: true },
  ),
  colorwheels: r(
    createColorWheelsSchema,
    createColorWheelsImpl,
    "Colour wheels: lift/gamma/gain RGB tints + offset + saturation chain.",
    { mutates: true },
  ),
  model: r(importModelSchema, importModelImpl, "Import a 3D model file and render it.", {
    mutates: true,
  }),
  "blender-scene-import": r(
    blenderSceneImportSchema,
    blenderSceneImportImpl,
    "Import a Blender scene or exported asset into a PBR render scaffold.",
    { mutates: true },
  ),
  shaderlib: r(
    createShaderLibSchema,
    createShaderLibImpl,
    "Instantiate a curated GLSL shader (tunnel/raymarch/fractal/…).",
    { mutates: true },
  ),
  shaderpark: r(
    createShaderParkSchema,
    createShaderParkImpl,
    "Compile Shader Park sculpture code into a GLSL MAT render network.",
    { mutates: true },
  ),
  videosynth: r(
    createVideoSynthSchema,
    createVideoSynthImpl,
    "Analog video-synth patterns (lissajous/interference/scanlines).",
    { mutates: true },
  ),
  silhouette: r(
    createDepthSilhouetteSchema,
    createDepthSilhouetteImpl,
    "Extract a silhouette/body mask from a depth or video source.",
    { mutates: true },
  ),
  kinetictext: r(
    createKineticTextSchema,
    createKineticTextImpl,
    "Animated/beat-flashed kinetic typography (lyric flashes).",
    { mutates: true },
  ),
  panic: r(
    createPanicSchema,
    createPanicImpl,
    "Live safety: instant Blackout + Freeze over an output.",
    { mutates: true },
  ),
  launcher: r(
    createClipLauncherSchema,
    createClipLauncherImpl,
    "Build an Ableton-style grid of cue-trigger buttons.",
    { mutates: true },
  ),
  decks: r(
    createDecksSchema,
    createDecksImpl,
    "Build DJ-style A/B decks with a master crossfader.",
    { mutates: true },
  ),
  pitch: r(
    detectPitchSchema,
    detectPitchImpl,
    "Detect monophonic pitch (Hz/note) from the FFT (experimental).",
    { mutates: true },
  ),
  learn: r(
    learnControlSchema,
    learnControlImpl,
    "MIDI/OSC learn: snapshot an input CHOP, then bind the moved control (experimental).",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 1:
  "cue-sequencer": r(
    createCueSequencerSchema,
    createCueSequencerImpl,
    "Bar-quantized cue timeline: fire stored cues at musical positions on a loop.",
    { mutates: true },
  ),
  dashboard: r(
    createStageDashboardSchema,
    createStageDashboardImpl,
    "Unified web performance surface: cue buttons + faders + panic + live readout.",
    { mutates: true },
  ),
  raymarch: r(
    createRaymarchSceneSchema,
    createRaymarchSceneImpl,
    "Volumetric GLSL raymarcher: SDF scenes (sphere-field/menger/tunnel).",
    { mutates: true },
  ),
  "raytk-scene": r(
    createRaytkSceneSchema,
    createRaytkSceneImpl,
    "RayTK node-graph raymarch scene (sphereSdf → raymarchRender3D → Null); needs RayTK loaded.",
    { mutates: true },
  ),
  "raytk-expr-graph": r(
    raytkExprGraphBuilderSchema,
    raytkExprGraphBuilderImpl,
    "Build a preset/custom RayTK ROP expression graph with deterministic layout; needs RayTK loaded.",
    { mutates: true },
  ),
  "raytk-op": r(
    createRaytkOpSchema,
    createRaytkOpImpl,
    "Instance one RayTK ROP master by op-name and optionally wire a typed input; needs RayTK loaded.",
    { mutates: true },
  ),
  "detect-tempo": r(
    detectTempoSchema,
    detectTempoImpl,
    "Auto-BPM from audio onsets; optionally drive the global tempo (experimental).",
    { mutates: true },
  ),
  palette: r(
    createPaletteSchema,
    createPaletteImpl,
    "Generate a color palette/gradient (harmony rules or sampled from a source).",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 2:
  "pbr-scene": r(
    createPbrSceneSchema,
    createPbrSceneImpl,
    "3D scene with a PBR material + environment light rig.",
    { mutates: true },
  ),
  "pop-geometry": r(
    createPopGeometrySchema,
    createPopGeometryImpl,
    "Procedural Op Pattern geometry: SOP chain (primitive→transform→subdiv→noise→mat) rendered to a TOP.",
    { mutates: true },
  ),
  flock: r(
    createParticleFlockSchema,
    createParticleFlockImpl,
    "Boids-style GPU particle flocking (separation/alignment/cohesion).",
    { mutates: true },
  ),
  "point-cloud": r(
    createPointCloudSchema,
    createPointCloudImpl,
    "Render a point cloud from a depth/luminance map or synthetic source.",
    { mutates: true },
  ),
  "data-source": r(
    createDataSourceSchema,
    createDataSourceImpl,
    "Ingest live external data (json/csv/osc/serial) onto a bindable CHOP.",
    { mutates: true },
  ),
  "gen-audio": r(
    createGenerativeAudioSchema,
    createGenerativeAudioImpl,
    "Synthesize audio (oscillator/fm/noise); optional device output.",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 3:
  "cubemap-dome": r(
    createCubemapDomeSchema,
    createCubemapDomeImpl,
    "True cube-map dome render → fisheye/equirectangular for planetarium/360.",
    { mutates: true },
  ),
  "led-mapper": r(
    createLedMapperSchema,
    createLedMapperImpl,
    "Pixel-map a source TOP to an LED fixture layout → DMX/Art-Net out.",
    { mutates: true },
  ),
  genre: r(
    scaffoldGenreSchema,
    scaffoldGenreImpl,
    "Scaffold a genre-flavored show (techno/ambient/installation).",
    { mutates: true },
  ),
  // Phase 13 — project intelligence & agent-DX.
  analyze: r(
    analyzeProjectSchema,
    analyzeProjectImpl,
    "Find dead ops, broken file deps, orphan COMPs + a dependency map.",
  ),
  readme: r(
    generateReadmeSchema,
    generateReadmeImpl,
    "Generate a Markdown project doc (params, I/O, deps, preview).",
  ),
  "dat-get": r(
    getDatContentSchema,
    getDatContentImpl,
    "Read a DAT's text/table content with paging (offset/limit, header, preview).",
  ),
  "dat-edit": r(
    editDatContentSchema,
    editDatContentImpl,
    "Surgically replace text in a DAT (unique-match or replace_all).",
    { mutates: true },
  ),
  "dat-set": r(
    setDatContentSchema,
    setDatContentImpl,
    "Overwrite a DAT's whole text (refuses silent wipes unless confirm_wipe).",
    { mutates: true },
  ),
  "shader-live-loop": r(
    editShaderLiveLoopSchema,
    editShaderLiveLoopImpl,
    "Edit a shader DAT, then inspect errors and optionally capture a preview.",
    { mutates: true },
  ),
  batch: r(
    batchOperationsSchema,
    batchOperationsImpl,
    "Run many create/connect/setParam ops in one fail-forward call.",
    { mutates: true },
  ),
  annotate: r(
    manageAnnotationSchema,
    manageAnnotationImpl,
    "Create/list annotation boxes + comments; list ops enclosed by a box.",
    { mutates: true },
  ),
  "perform-mode": r(
    setPerformModeSchema,
    setPerformModeImpl,
    "Toggle perform mode: store advisory flag; built-in guard skips preview captures.",
    { mutates: true },
  ),
  "agent-guide": r(
    writeAgentGuideSchema,
    writeAgentGuideImpl,
    "Emit a project-local CLAUDE.md/AGENTS.md with tdmcp conventions.",
    { mutates: true },
  ),
  // Phase 13 — body / pose tracking (MediaPipe-driven, camera-reactive).
  "body-tracking": r(
    setupBodyTrackingSchema,
    setupBodyTrackingImpl,
    "One-shot webcam body tracking: load the MediaPipe engine + adapter + live skeleton.",
    { mutates: true },
  ),
  "pose-track": r(
    createPoseTrackingSchema,
    createPoseTrackingImpl,
    "Build a pose-tracking source (MediaPipe/OSC/synthetic) → a 33-landmark pose CHOP.",
    { mutates: true },
  ),
  "create-pose-controlnet-driver": r(
    createPoseControlnetDriverSchema,
    createPoseControlnetDriverImpl,
    "Render a pose CHOP into a ControlNet-ready skeleton TOP for AI image bridges.",
    { mutates: true },
  ),
  skeleton: r(
    createPoseSkeletonSchema,
    createPoseSkeletonImpl,
    "Draw a live stick-figure skeleton from a pose CHOP.",
    { mutates: true },
  ),
  "body-bubbles": r(
    createBodyBubblesSchema,
    createBodyBubblesImpl,
    "Create open-palm bubble physics with body/hand collision.",
    { mutates: true },
  ),
  "body-reactive": r(
    createBodyReactiveSchema,
    createBodyReactiveImpl,
    "Drive a visual from tracked body motion (camera-reactive performance).",
    { mutates: true },
  ),
  "hand-hologram": r(
    createHandHologramSchema,
    createHandHologramImpl,
    "Build a palm-anchored hologram visual; open palm shows it, opposite-hand pinch scales/glows it.",
    { mutates: true },
  ),
  // Phase 14 — live mixing, content & parameter fidelity (v0.5.0):
  transition: r(
    createTransitionSchema,
    createTransitionImpl,
    "Build an A→B transition (dissolve/luma_wipe/slide/zoom/glitch_cut) over a Progress knob.",
    { mutates: true },
  ),
  "live-source": r(
    createLiveSourceSchema,
    createLiveSourceImpl,
    "Build a live input layer (screen-grab/ndi/syphon-spout/camera/stream) → a previewed Null.",
    { mutates: true },
  ),
  "layer-stack": r(
    createLayerStackSchema,
    createLayerStackImpl,
    "Build an N-layer VJ compositor (per-layer blend + opacity + mute/solo + control strip).",
    { mutates: true },
  ),
  "media-bin": r(
    createMediaBinSchema,
    createMediaBinImpl,
    "Build a folder-fed clip bin (Movie File In + Switch) with Index/Next/Prev/Crossfade.",
    { mutates: true },
  ),
  keyer: r(
    createKeyerSchema,
    createKeyerImpl,
    "Key a source (chroma/luma/rgb) and composite it over a background.",
    { mutates: true },
  ),
  "react-audio": r(
    bindAudioReactiveSchema,
    bindAudioReactiveImpl,
    "One-shot: auto-map a COMP's knobs to audio bands and bind them to a feature CHOP.",
    { mutates: true },
  ),
  "params-modes": r(
    readParameterModesSchema,
    readParameterModesImpl,
    "Read each parameter's mode (constant/expression/export/bind) + raw expr/bind/export.",
  ),
  "params-menu": r(
    getParameterMenuSchema,
    getParameterMenuImpl,
    "Read a parameter's live menu names/labels + current value (menu-style params).",
  ),
  "set-expr": r(
    setParameterExpressionSchema,
    setParameterExpressionImpl,
    "Set a parameter to an expression/bind/constant without raw Python.",
    { mutates: true },
  ),
  disconnect: r(
    disconnectNodesSchema,
    disconnectNodesImpl,
    "Remove input wire(s) from a node (the inverse of connect).",
    { mutates: true },
  ),
  // Phase 14 — signature effects, multipass 3D, data-driven cloning, runtime reads:
  datamosh: r(
    createDatamoshSchema,
    createDatamoshImpl,
    "Build a datamosh / time-echo / frame-blend smear (feedback ghost trails).",
    { mutates: true },
  ),
  warp: r(
    createDisplacementWarpSchema,
    createDisplacementWarpImpl,
    "Warp a source by noise / a second TOP / audio (displacement).",
    { mutates: true },
  ),
  halftone: r(
    createHalftoneSchema,
    createHalftoneImpl,
    "Stylise a source as halftone dots / CMYK / dither / posterize (GLSL).",
    { mutates: true },
  ),
  "create-ascii-render": r(
    createAsciiRenderSchema,
    createAsciiRenderImpl,
    "Render a source as ASCII art (glyph atlas + GLSL sampler).",
    { mutates: true },
  ),
  "vector-lines": r(
    createVectorLinesSchema,
    createVectorLinesImpl,
    "Pulse-capture a source image into editable Trace SOP vector lines composited over the source.",
    { mutates: true },
  ),
  "feedback-tunnel": r(
    createFeedbackTunnelSchema,
    createFeedbackTunnelImpl,
    "Build an infinite zoom/rotate/hue feedback tunnel generator.",
    { mutates: true },
  ),
  "multipass-3d": r(
    multipass3dDepthSchema,
    multipass3dDepthImpl,
    "Build a multipass 3D scene (Render + SSAO + a synthetic Depth output).",
    { mutates: true },
  ),
  replicator: r(
    createReplicatorSchema,
    createReplicatorImpl,
    "Clone a template COMP per row of a Table DAT (Replicator COMP).",
    { mutates: true },
  ),
  "node-state": r(
    getNodeStateRuntimeSchema,
    getNodeStateRuntimeImpl,
    "Read an operator's runtime telemetry (cook time/count, res, channels, GPU mem).",
  ),
  logs: r(
    getBridgeLogsSchema,
    getBridgeLogsImpl,
    "Collect recent cook errors/warnings (+ best-effort textport) for debugging.",
  ),
  // Phase 15 — set navigation, sequencing, data reactivity, round-trip, introspection:
  "set-nav": r(
    createSetNavigatorSchema,
    createSetNavigatorImpl,
    "Build a stage cue-list navigator (Index/Next/Prev/Go, QLab model).",
    { mutates: true },
  ),
  "pop-field": r(
    createPopFieldSchema,
    createPopFieldImpl,
    "Build a GPU POP point field (experimental — live-validation pending).",
    { mutates: true },
  ),
  // Hype-scout Round 4 Wave 3 (2026-06-09) — POP combos:
  "create-pop-particle-system": r(
    createPopParticleSystemSchema,
    createPopParticleSystemImpl,
    "Build a POP particle system (emitter + forces + audio reactivity) into a previewed render.",
    { mutates: true },
  ),
  "create-pop-growth": r(
    createPopGrowthSchema,
    createPopGrowthImpl,
    "Grow a POP field over time (additive emission + lifetime + accumulation).",
    { mutates: true },
  ),
  "create-pop-lines-pointcloud": r(
    createPopLinesPointcloudSchema,
    createPopLinesPointcloudImpl,
    "Render POP points as connected lines / pointcloud (Line MAT or Point MAT pipeline).",
    { mutates: true },
  ),
  "create-depth-pop-field": r(
    createDepthPopFieldSchema,
    createDepthPopFieldImpl,
    "Drive a POP field from a depth source (sensor TOP → POP positions).",
    { mutates: true },
  ),
  "create-stipple-pointcloud": r(
    createStipplePointcloudSchema,
    createStipplePointcloudImpl,
    "Stipple a source TOP into a sampled POP pointcloud (intensity-weighted dots).",
    { mutates: true },
  ),
  // Hype-scout Round 4 Wave 4 (2026-06-09) — AI bridges:
  "drive-streamdiffusion": r(
    driveStreamdiffusionSchema,
    driveStreamdiffusionImpl,
    "Drive StreamDiffusion realtime img2img bridge (TouchDiffusion / StreamDiffusion TD).",
    { mutates: true },
  ),
  "setup-mediapipe-plugin": r(
    setupMediapipePluginSchema,
    setupMediapipePluginImpl,
    "Install/configure the MediaPipe TD plugin (camera-driven body/hand/face inputs).",
    { mutates: true },
  ),
  "create-depth-from-2d": r(
    createDepthFromTwoDSchema,
    createDepthFromTwoDImpl,
    "Estimate per-pixel depth from a 2D image/video source via an AI depth model.",
    { mutates: true },
  ),
  "create-gaussian-splat-scene": r(
    createGaussianSplatSceneSchema,
    createGaussianSplatSceneImpl,
    "Render a 3D Gaussian Splat scene (point/splat dataset) into the network.",
    { mutates: true },
  ),
  "create-ai-mirror": r(
    createAiMirrorSchema,
    createAiMirrorImpl,
    "Live AI-mirror combo: camera → StreamDiffusion (+ optional pose/depth controls) → preview.",
    { mutates: true },
  ),
  "connect-comfyui": r(
    connectComfyuiSchema,
    connectComfyuiImpl,
    "Bridge to a ComfyUI workflow endpoint (submit prompts, fetch generated frames).",
    { mutates: true },
  ),
  "connect-daydream-cloud": r(
    connectDaydreamCloudSchema,
    connectDaydreamCloudImpl,
    "Bridge to a Daydream cloud realtime-diffusion endpoint.",
    { mutates: true },
  ),
  "create-llm-chain": r(
    createLlmChainSchema,
    createLlmChainImpl,
    "Compose an LLM prompt chain DAT graph driving TD parameters/text.",
    { mutates: true },
  ),
  // Hype-scout Round 4 Wave 5 (2026-06-09) — VFX aesthetic tail:
  "create-slit-scan": r(
    createSlitScanSchema,
    createSlitScanImpl,
    "Build a slit-scan time-displacement effect over an input TOP.",
    { mutates: true },
  ),
  "create-chrome-blobs": r(
    createChromeBlobsSchema,
    createChromeBlobsImpl,
    "Build a chrome/metaball blob network with reflective shading.",
    { mutates: true },
  ),
  "create-vintage-lens": r(
    createVintageLensSchema,
    createVintageLensImpl,
    "Apply a vintage-lens stack (chromatic aberration, vignette, grain, distortion) to a TOP.",
    { mutates: true },
  ),
  "create-reaction-diffusion": r(
    createReactionDiffusionSchema,
    createReactionDiffusionImpl,
    "Build a Gray-Scott reaction-diffusion feedback network.",
    { mutates: true },
  ),
  "create-pixel-sort": r(
    createPixelSortSchema,
    createPixelSortImpl,
    "Build a pixel-sort glitch effect over an input TOP.",
    { mutates: true },
  ),
  "create-volumetric-field": r(
    createVolumetricFieldSchema,
    createVolumetricFieldImpl,
    "Build a volumetric/3D scalar-field render (raymarched volume).",
    { mutates: true },
  ),
  "create-voxel-stack": r(
    createVoxelStackSchema,
    createVoxelStackImpl,
    "Build a stacked-voxel render of a source TOP or geometry.",
    { mutates: true },
  ),
  "create-facade-mapping": r(
    createFacadeMappingSchema,
    createFacadeMappingImpl,
    "Build a building-facade projection-mapping network (per-window tiling + warp).",
    { mutates: true },
  ),
  "lidar-floor-tracker": r(
    lidarFloorTrackerSchema,
    lidarFloorTrackerImpl,
    "Build a synthetic/Ouster/Leuze/UDP LiDAR floor-tracker scaffold.",
    { mutates: true },
  ),
  "beat-grid": r(
    createBeatGridSequencerSchema,
    createBeatGridSequencerImpl,
    "Build a beat/bar step-grid sequencer (param or cue per active step).",
    { mutates: true },
  ),
  "react-data": r(
    createDataReactiveSchema,
    createDataReactiveImpl,
    "Map live data-source channels onto a COMP's knobs with per-mapping range remap.",
    { mutates: true },
  ),
  serialize: r(
    serializeNetworkSchema,
    serializeNetworkImpl,
    "Serialize a COMP's children to a diffable JSON spec (params + modes + wires).",
  ),
  rebuild: r(
    rebuildNetworkSchema,
    rebuildNetworkImpl,
    "Rebuild a network from a serialize_network spec (create + params + wires).",
    { mutates: true },
  ),
  "inspect-comp": r(
    inspectComponentSchema,
    inspectComponentImpl,
    "Read a COMP's storage, promoted extension members, and custom-parameter definitions.",
  ),
  // Campaign Wave 3 — artist controls (backlog 2026-05-29):
  "test-pattern": r(
    createTestPatternSchema,
    createTestPatternImpl,
    "Build a projector calibration/test pattern (grid/crosshair/color-bars/ramp/circle-grid).",
    { mutates: true },
  ),
  "text-crawl": r(
    createTextCrawlSchema,
    createTextCrawlImpl,
    "Build a multi-line crawl/ticker/typewriter text source.",
    { mutates: true },
  ),
  "blob-reactive": r(
    createBlobReactiveSchema,
    createBlobReactiveImpl,
    "Track blob/hand positions from a camera or TOP and bind params to them.",
    { mutates: true },
  ),
  // Campaign Wave 2 — composition/scheduling/reactivity/interaction (v0.8.0):
  "compose-cue-list": r(
    composeCueListSchema,
    composeCueListImpl,
    "Author a cue list from rows: scaffolds cues + step sequencer wired to a navigator.",
    { mutates: true },
  ),
  "create-phrase-locked-cue-engine": r(
    createPhraseLockedCueEngineSchema,
    createPhraseLockedCueEngineImpl,
    "Lock cue advances to bar/phrase boundaries from a tempo CHOP.",
    { mutates: true },
  ),
  "prob-sequencer": r(
    createProbSequencerSchema,
    createProbSequencerImpl,
    "Probabilistic Markov-style state sequencer driving params/cues per state.",
    { mutates: true },
  ),
  "two-way-surface": r(
    createTwoWaySurfaceSchema,
    createTwoWaySurfaceImpl,
    "Bidirectional control surface: parameter <-> external channel sync with guards.",
    { mutates: true },
  ),
  "automation-lane": r(
    createAutomationLaneSchema,
    createAutomationLaneImpl,
    "Timeline automation lane: animate target parameters from a CHOP curve.",
    { mutates: true },
  ),
  "chroma-reactive": r(
    createChromaReactiveSchema,
    createChromaReactiveImpl,
    "Harmonic/chroma audio analysis -> chroma_* channels driving target params.",
    { mutates: true },
  ),
  "transient-reactive": r(
    createTransientReactiveSchema,
    createTransientReactiveImpl,
    "Transient vs sustain detection: emits transient/sustain channels for routing.",
    { mutates: true },
  ),
  "energy-structure": r(
    createEnergyStructureSchema,
    createEnergyStructureImpl,
    "Multi-band energy state machine with edge-triggered state changes.",
    { mutates: true },
  ),
  "phone-gesture": r(
    createPhoneGestureSchema,
    createPhoneGestureImpl,
    "Phone IMU/gesture WebSocket receiver (orientation + gestures) as control channels.",
    { mutates: true },
  ),
  sidechain: r(
    createSidechainPumpSchema,
    createSidechainPumpImpl,
    "Pump many target params on a trigger channel (one-call sidechain duck).",
    { mutates: true },
  ),
  "band-router": r(
    createBandRouterSchema,
    createBandRouterImpl,
    "Split audio into EQ bands and route each band level to its own target(s).",
    { mutates: true },
  ),
  "xy-pad": r(
    createXyPadSchema,
    createXyPadImpl,
    "Build a draggable 2D XY gesture pad that drives target parameters.",
    { mutates: true },
  ),
  "time-echo": r(
    createTimeEchoSchema,
    createTimeEchoImpl,
    "Per-pixel time effect (echo trails / slit-scan / time-displace) on a source TOP.",
    { mutates: true },
  ),
  "capture-loop": r(
    createCaptureLoopSchema,
    createCaptureLoopImpl,
    "Bidirectional Spout/Syphon/NDI bridge (receive + publish in one container).",
    { mutates: true },
  ),
  "library-diff": r(
    diffLibraryAssetsSchema,
    diffLibraryAssetsImpl,
    "Offline deep-diff two saved library assets (recipe/manifest/spec JSON).",
  ),
  "recipe-from-url": r(
    importRecipeFromUrlSchema,
    importRecipeFromUrlImpl,
    "Fetch + validate + import a recipe/bundle JSON from an HTTPS URL.",
    { mutates: true },
  ),
  "palette-export": r(
    exportPaletteComponentSchema,
    exportPaletteComponentImpl,
    "Save a COMP as a .tox into the TouchDesigner Palette folder for drag-and-drop reuse.",
    { mutates: true },
  ),
  "collect-assets": r(
    collectProjectAssetsSchema,
    collectProjectAssetsImpl,
    "Scan a COMP subtree for external file dependencies into an inventory + optional manifest.",
    { mutates: true },
  ),
  "bundle-deps": r(
    bundleDependenciesSchema,
    bundleDependenciesImpl,
    "Make a COMP self-contained: copy external assets beside a saved .tox and rewrite refs to relative paths.",
    { mutates: true },
  ),
  "export-external-tree": r(
    exportExternalizedTreeSchema,
    exportExternalizedTreeImpl,
    "Save a COMP as a git-diffable externalized .tox tree (each COMP becomes its own file).",
    { mutates: true },
  ),
  "narrate-set": r(
    narrateSetSchema,
    narrateSetImpl,
    "Persist/recall a live-set narration log (append timestamped decision lines; recall them later).",
    { mutates: true },
  ),
  "doc-site": r(
    projectDocumentationSiteSchema,
    projectDocumentationSiteImpl,
    "Compose a multi-file documentation package (README + topology + optional gallery) for a network.",
    { mutates: true },
  ),
  "caption-top": r(
    captionTopSchema,
    captionTopImpl,
    "Caption a TOP: plain-text description of colors/brightness/motion (vision LLM or histogram).",
  ),
  "repair-network": r(
    repairNetworkSchema,
    repairNetworkImpl,
    "Bounded autonomous network repair: read errors, plan/apply safe fixes (dry-run by default), re-check.",
    { mutates: true },
  ),
  // Phase 15 — 3D text, sidechain envelope, MIDI (hardware path held pending gear):
  "text-3d": r(
    createText3dSchema,
    createText3dImpl,
    "Build extruded 3D text with spin/depth/material.",
    { mutates: true },
  ),
  envelope: r(
    createEnvelopeFollowerSchema,
    createEnvelopeFollowerImpl,
    "Shape a reactive signal: attack/release + gate/duck (sidechain). Experimental.",
    { mutates: true },
  ),
  "midi-map": r(
    createMidiMapSchema,
    createMidiMapImpl,
    "Build a MIDI controller preset map (APC/Launchpad/MIDI Mix/nanoKONTROL). Hardware-UNVERIFIED.",
    { mutates: true },
  ),
  "midi-notes": r(
    createMidiNoteReactiveSchema,
    createMidiNoteReactiveImpl,
    "Build a MIDI-note reactive chain (synthetic source previews without gear).",
    { mutates: true },
  ),
  // Library / packaging — local-first .tox packages, recipe bundles and package indexes.
  library: r(
    browseLibrarySchema,
    browseLibraryImpl,
    "Browse recipes and local component packages.",
  ),
  manifest: r(
    inspectComponentManifestSchema,
    inspectComponentManifestImpl,
    "Inspect a component package manifest.",
  ),
  "portable-tox": r(
    makePortableToxSchema,
    makePortableToxImpl,
    "Save a COMP as a portable .tox package with a manifest.",
    { mutates: true },
  ),
  "recipe-bundle-export": r(
    exportRecipeBundleSchema,
    exportRecipeBundleImpl,
    "Export recipes to a portable bundle file.",
    { mutates: true },
  ),
  "recipe-bundle-import": r(
    importRecipeBundleSchema,
    importRecipeBundleImpl,
    "Import recipes from a portable bundle file.",
    { mutates: true },
  ),
  "asset-validate": r(
    validateLibraryAssetSchema,
    validateLibraryAssetImpl,
    "Validate a local library asset and manifest reference.",
  ),
  "recipe-template": r(
    scaffoldRecipeTemplateSchema,
    scaffoldRecipeTemplateImpl,
    "Write a minimal valid recipe JSON template.",
    { mutates: true },
  ),
  "docs-assets": r(
    attachDocsAsAssetsSchema,
    attachDocsAsAssetsImpl,
    "Copy docs into a package and update its manifest.",
    { mutates: true },
  ),
  "marketplace-index": r(
    localMarketplaceIndexSchema,
    localMarketplaceIndexImpl,
    "Write an index.json for a local package directory.",
    { mutates: true },
  ),
  "marketplace-index-seed": r(
    marketplaceIndexSeedSchema,
    marketplaceIndexSeedImpl,
    "Write a guarded starter marketplace seed JSON.",
    { mutates: true },
  ),
  "component-health": r(
    componentLinkHealthSchema,
    componentLinkHealthImpl,
    "Check externaltox links for missing local component files.",
  ),
  "preview-assets": r(
    refreshAssetPreviewsSchema,
    refreshAssetPreviewsImpl,
    "Capture TOP previews into package asset files.",
    { mutates: true },
  ),
  "install-library": r(
    installLibraryPackageSchema,
    installLibraryPackageImpl,
    "Install a local package folder, zip, tox, or manifest into a package directory.",
    { mutates: true },
  ),
  "library-index": r(
    generateLibraryIndexSchema,
    generateLibraryIndexImpl,
    "Write a Markdown contact-sheet of the whole vault library (thumbnails + load snippets).",
    { mutates: true },
  ),
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  "provenance-stamp": r(
    provenanceStampSchema,
    provenanceStampImpl,
    "Write a .provenance.json sidecar (sha256 + source + toolchain + git) next to a saved artifact.",
    { mutates: true },
  ),
  "checksum-verify-pack": r(
    checksumAndVerifyPackSchema,
    checksumAndVerifyPackImpl,
    "Compute or verify SHA-256 checksums for tdmcp artifacts (tox/recipes/bundles).",
    { mutates: true },
  ),
  "library-lineage-graph": r(
    libraryLineageGraphSchema,
    libraryLineageGraphImpl,
    "Scan the vault library and emit a lineage graph (JSON / Mermaid / Graphviz DOT).",
  ),
  "morph-pack": r(
    morphPackSchema,
    morphPackImpl,
    "Pack/unpack a create_preset_morph slot set as a portable, sha256-verified vault JSON.",
    { mutates: true },
  ),
  "learn-conventions": r(
    learnConventionsSchema,
    learnConventionsImpl,
    "Read a live TD subtree and write the artist's house conventions into the vault Memory notes.",
    { mutates: true },
  ),
  "moodboard-to-system": r(
    moodboardToSystemSchema,
    moodboardToSystemImpl,
    "Ingest moodboard images and build a matching generative system in TouchDesigner.",
    { mutates: true },
  ),
  "audio-fingerprint-to-visual": r(
    audioFingerprintToVisualSchema,
    audioFingerprintToVisualImpl,
    "Sample audio, fingerprint it, and dispatch a matching Layer 1 generator tuned to it.",
    { mutates: true },
  ),
  "score-build": r(
    scoreBuildSchema,
    scoreBuildImpl,
    "Score a built network 0–100 (palette/motion/complexity/errors/perf) with improvement suggestions.",
  ),
  // Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
  "engine-comp": r(
    createEngineCompSchema,
    createEngineCompImpl,
    "Build a load-balanced Engine COMP cluster for offloading sub-networks to worker processes.",
    { mutates: true },
  ),
  "dmx-fixture-pipeline": r(
    createDmxFixturePipelineSchema,
    createDmxFixturePipelineImpl,
    "Build a DMX/Art-Net fixture pipeline (channels → patch → Art-Net Out).",
    { mutates: true },
  ),
  "fixture-control": r(
    createFixtureControlSchema,
    createFixtureControlImpl,
    "Build a moving-head fixture rig with DMX out + a 3D pan/tilt/beam previz.",
    { mutates: true },
  ),
  "detection-reactive": r(
    createDetectionReactiveSchema,
    createDetectionReactiveImpl,
    "Turn object/person detection (WebSocket or ONNX CPU) into presence/count/bbox channels.",
    { mutates: true },
  ),
  "geo-visualization": r(
    createGeoVisualizationSchema,
    createGeoVisualizationImpl,
    "Project GeoJSON/OSM lat-long into a 3D city visualization (ODbL attribution).",
    { mutates: true },
  ),
  "scaffold-vj-deck": r(
    scaffoldVjDeckSchema,
    scaffoldVjDeckImpl,
    "Scaffold a MIDI-mappable VJ deck (decks + fader surface + MIDI map).",
    { mutates: true },
  ),
  "synesthesia-unreal-osc": r(
    createSynesthesiaUnrealOscSchema,
    createSynesthesiaUnrealOscImpl,
    "Build a named OSC-out preset map for Synesthesia / Unreal Engine.",
    { mutates: true },
  ),
  "scaffold-tool-generator": r(
    scaffoldToolGeneratorSchema,
    scaffoldToolGeneratorImpl,
    "Scaffold a new tdmcp tool file + msw unit test from an inline spec.",
    { mutates: true },
  ),
  "extend-data-source-fabric": r(
    extendDataSourceFabricSchema,
    extendDataSourceFabricImpl,
    "Extend create_data_source with new feed adapters (websocket/sse/mqtt/file-tail/process).",
    { mutates: true },
  ),
  "build-chop-chain": r(
    buildChopChainSchema,
    buildChopChainImpl,
    "Assemble a typed CHOP-processing chain from a recipe of stages.",
    { mutates: true },
  ),
  "author-script-operator": r(
    authorScriptOperatorSchema,
    authorScriptOperatorImpl,
    "Author a Script CHOP/TOP/SOP/DAT with validated callbacks + parameters.",
    { mutates: true },
  ),
  "nodes profile": r(
    profileCookCostSchema,
    profileCookCostImpl,
    "Profile per-node cook cost (n samples) and rank hot spots.",
  ),
  timeline: r(
    controlTimelineTransportSchema,
    controlTimelineTransportImpl,
    "Control TD timeline transport (play/pause/seek/rate/range).",
    { mutates: true },
  ),
  "gpu-displays": r(
    inspectGpuAndDisplaysSchema,
    inspectGpuAndDisplaysImpl,
    "Inspect host GPU + connected displays (offline-friendly).",
  ),
  "hardware-diagnose": r(
    diagnoseHardwareEnvironmentSchema,
    diagnoseHardwareEnvironmentImpl,
    "Preflight bridge, displays/projectors and generated sensor/helper status DATs.",
  ),
  "notch-touchengine-bridge": r(
    notchTouchengineBridgeSchema,
    notchTouchengineBridgeImpl,
    "Build a guarded Notch TOP or TouchEngine bridge scaffold.",
    { mutates: true },
  ),
  "macro-record": r(
    macroRecorderSchema,
    macroRecorderImpl,
    "Record / stop / list / load tool-call macros (replay ships in wave 5).",
    { mutates: true },
  ),
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  "curated-collection-pack": r(
    curatedCollectionPackSchema,
    curatedCollectionPackImpl,
    "Bundle a curated collection of library assets into a verifiable pack.",
    { mutates: true },
  ),
  "component-changelog-trail": r(
    componentChangelogTrailSchema,
    componentChangelogTrailImpl,
    "Track a component's changelog trail across versions.",
    { mutates: true },
  ),
  "merge-vaults": r(mergeVaultsSchema, mergeVaultsImpl, "Merge two Obsidian vaults safely.", {
    mutates: true,
  }),
  "vault-repo-sync": r(
    vaultRepoSyncSchema,
    vaultRepoSyncImpl,
    "Sync a vault with a git remote (clone/pull/push).",
    { mutates: true },
  ),
  "variant-pack": r(
    variantPackSchema,
    variantPackImpl,
    "Generate a variant pack from a base vault asset.",
    { mutates: true },
  ),
  "learn-from-my-corpus": r(
    learnFromMyCorpusSchema,
    learnFromMyCorpusImpl,
    "Mine the vault corpus to surface style/usage conventions.",
  ),
  "shared-memory-bridge": r(
    createSharedMemoryBridgeSchema,
    createSharedMemoryBridgeImpl,
    "Wire a Shared-Mem (in/out) bridge between processes.",
    { mutates: true },
  ),
  "build-sop-geometry": r(
    buildSopGeometrySchema,
    buildSopGeometryImpl,
    "Assemble a typed SOP geometry chain from a recipe of stages.",
    { mutates: true },
  ),
  // Hype-scout Round 4 Wave 1 (2026-06-09) — typed POP chain builder:
  "build-pop-chain": r(
    buildPopChainSchema,
    buildPopChainImpl,
    "Assemble a typed POP (Point OPerator) chain from a recipe of stages.",
    { mutates: true },
  ),
  "sync-timecode": r(
    syncTimecodeSchema,
    syncTimecodeImpl,
    "Lock the show clock to external timecode (LTC/MTC/MIDI).",
    { mutates: true },
  ),
  "manage-component-storage": r(
    manageComponentStorageSchema,
    manageComponentStorageImpl,
    "Read/write COMP `storage` slots safely.",
    { mutates: true },
  ),
  "enhance-build": r(
    enhanceBuildSchema,
    enhanceBuildImpl,
    "Apply targeted improvements to an existing build and rescore.",
    { mutates: true },
  ),
  "elicit-missing-args": r(
    elicitMissingArgsSchema,
    elicitMissingArgsImpl,
    "Elicit missing required tool args from partial input + context.",
  ),
  "growth-system": r(
    createGrowthSystemSchema,
    createGrowthSystemImpl,
    "Build an organic growth/branching system (L-system flavour).",
    { mutates: true },
  ),
  "run-macro-script": r(
    runMacroScriptSchema,
    runMacroScriptImpl,
    "Replay a recorded macro script of tool calls.",
    { mutates: true },
  ),
  // Ingest-extend Wave 1 (2026-05-31) — shader ingest foundation + consumers + new looks:
  "apply-glsl-mapping": r(
    applyGlslTopMappingSchema,
    applyGlslTopMappingImpl,
    "Build a GLSL TOP from a pre-translated mapping (fragment + uniforms + channels + controls).",
    { mutates: true },
  ),
  "import-shadertoy": r(
    importShadertoySchema,
    importShadertoyImpl,
    "Import a Shadertoy shader (URL/ID/source) into a native GLSL TOP network.",
    { mutates: true },
  ),
  "import-isf": r(
    importIsfShaderSchema,
    importIsfShaderImpl,
    "Import an ISF shader into a native GLSL TOP network.",
    { mutates: true },
  ),
  "fluid-sim": r(
    createFluidSimSchema,
    createFluidSimImpl,
    "Build a real-time fluid simulation (advect/diffuse/project feedback chain).",
    { mutates: true },
  ),
  "image-to-particles": r(
    createImageToParticlesSchema,
    createImageToParticlesImpl,
    "Convert an image into a particle field whose colours/positions sample the source.",
    { mutates: true },
  ),
  dither: r(
    createDitherSchema,
    createDitherImpl,
    "Apply 1-bit / Bayer / error-diffusion dither with palette modes (mono/duotone/rgb).",
    { mutates: true },
  ),
  "jfa-voronoi": r(
    createJfaVoronoiSchema,
    createJfaVoronoiImpl,
    "Build a Jump Flood Algorithm Voronoi / distance-field network from seed points.",
    { mutates: true },
  ),
  // Ingest-extend Wave 2 (2026-05-31) — live integrations, scopes, recording, LUTs, NPR, post-3d:
  "setup-tdableton": r(
    setupTdabletonSchema,
    setupTdabletonImpl,
    "Bridge Ableton Live <-> TouchDesigner via TDAbleton (CHOPs for tempo, transport, params).",
    { mutates: true },
  ),
  "hand-ableton-mapper": r(
    createHandAbletonMapperSchema,
    createHandAbletonMapperImpl,
    "Build MediaPipe hand controls for TDAbleton TDA_Mapper (map1 left pinch, map2 right pinch, map3/map4 wrist roll).",
    { mutates: true },
  ),
  "hand-gesture-bus": r(
    createHandGestureBusSchema,
    createHandGestureBusImpl,
    "Create a stable hand gesture CHOP bus for palm, float anchor, pinch, scale, light, and audio controls.",
    { mutates: true },
  ),
  "diagnose-tdableton-mapper": r(
    diagnoseTdabletonMapperSchema,
    diagnoseTdabletonMapperImpl,
    "Inspect or repair TDAbleton TDA_Mapper routing for a hand Ableton mapper.",
    { mutates: true },
  ),
  "chop-recorder": r(
    createChopRecorderSchema,
    createChopRecorderImpl,
    "Record an incoming CHOP stream to disk and play it back as an animation/curve.",
    { mutates: true },
  ),
  "video-scopes": r(
    createVideoScopesSchema,
    createVideoScopesImpl,
    "Build broadcast video scopes (waveform / RGB parade / vectorscope) for a source TOP.",
    { mutates: true },
  ),
  "apply-lut": r(
    applyLutSchema,
    applyLutImpl,
    "Apply a .cube/.3dl LUT to a TOP via lookupTOP, with optional strength + before/after preview.",
    { mutates: true },
  ),
  "data-source-http-ws": r(
    createDataSourceHttpWsSchema,
    createDataSourceHttpWsImpl,
    "Create an HTTP poller or WebSocket data source feeding a CHOP/DAT channel.",
    { mutates: true },
  ),
  "flow-abstraction": r(
    createFlowAbstractionSchema,
    createFlowAbstractionImpl,
    "Painterly flow-abstraction effect (edge-tangent-flow → flow-based DoG, Kyprianidis style) over a source TOP.",
    { mutates: true },
  ),
  "npr-filter": r(
    createNprFilterSchema,
    createNprFilterImpl,
    "Non-photorealistic painterly filter (Kuwahara → oil / pencil / watercolor).",
    { mutates: true },
  ),
  "post-passes-3d": r(
    postPasses3dSchema,
    postPasses3dImpl,
    "Composited 3D post-passes (SSAO / SSR / DOF / motion blur) using depth/normal/velocity AOVs.",
    { mutates: true },
  ),
  // New wave: SDF / strange-attractor / optical-flow / histogram-scope / face+hand tracking:
  "sdf-field": r(
    createSdfFieldSchema,
    createSdfFieldImpl,
    "Build a signed-distance-field raymarched scene (volumetric SDF primitives + lighting).",
    { mutates: true },
  ),
  "strange-attractor": r(
    createStrangeAttractorSchema,
    createStrangeAttractorImpl,
    "Render a strange attractor (Lorenz / Aizawa / Halvorsen) as point/line geometry.",
    { mutates: true },
  ),
  "optical-flow": r(
    createOpticalFlowSchema,
    createOpticalFlowImpl,
    "Compute optical flow from a video/camera source and expose flow vectors for reactive use.",
    { mutates: true },
  ),
  "histogram-scope": r(
    createHistogramScopeSchema,
    createHistogramScopeImpl,
    "Build a video histogram scope (luma/RGB) for monitoring tone and color distribution.",
    { mutates: true },
  ),
  "face-tracking": r(
    setupFaceTrackingSchema,
    setupFaceTrackingImpl,
    "Set up MediaPipe face tracking: 468-sample face-landmark CHOP (tx/ty/tz/confidence, centred on nose tip) from camera. No blendshapes yet.",
    { mutates: true },
  ),
  "hand-tracking": r(
    setupHandTrackingSchema,
    setupHandTrackingImpl,
    "Set up MediaPipe hand tracking: per-finger landmark CHOP (max_hands×21 with tx/ty/tz/confidence/handedness) from camera. No gesture classification — wire detectors downstream.",
    { mutates: true },
  ),
  segmentation: r(
    setupSegmentationSchema,
    setupSegmentationImpl,
    "Set up MediaPipe selfie segmentation: publishes a clean alpha-mask Null TOP (and optionally a pre-keyed RGBA) from the camera.",
    { mutates: true },
  ),
  "get-inline-preview": r(
    getInlinePreviewSchema,
    getInlinePreviewImpl,
    "Inline inspection snapshot for one operator: small base64 thumbnail + errors (self + parents) + top-N changed-from-default parameters + 1-line cook stats. Single-round-trip 'is this op alive/healthy?' read.",
    { mutates: false },
  ),
  // Roadmap-to-1.0 Wave 3 (2026-07-06) — stock-TD artist/interaction tools:
  "step-repeat": r(
    createStepRepeatSchema,
    createStepRepeatImpl,
    "Tile a source TOP into a rows×cols brick/grid with per-cell gap, position/rotation jitter, and optional brick offset.",
    { mutates: true },
  ),
  "timecode-overlay": r(
    addTimecodeOverlaySchema,
    addTimecodeOverlayImpl,
    "Overlay a live HH:MM:SS:FF timecode (clock / count-up / count-down) onto a source TOP as visual pixels.",
    { mutates: true },
  ),
  "pointer-reactive": r(
    createPointerReactiveSchema,
    createPointerReactiveImpl,
    "Turn mouse/pointer position + click into a bindable u/v/velocity/button Null CHOP, with an optional pushed feedback demo.",
    { mutates: true },
  ),
  "interaction-zones": r(
    createInteractionZonesSchema,
    createInteractionZonesImpl,
    "Define N rectangular motion zones over a camera input; emits per-zone state + dwell channels ready to fire cues.",
    { mutates: true },
  ),
  // Roadmap-to-1.0 Wave 4 (2026-07-06) — stock-TD generators:
  terrain: r(
    createTerrainSchema,
    createTerrainImpl,
    "Build a procedural heightmap terrain: Noise height field → GLSL vertex-displacement MAT on a subdivided grid, with optional water plane and distance fog.",
    { mutates: true },
  ),
  "asemic-writing": r(
    createAsemicWritingSchema,
    createAsemicWritingImpl,
    "Generate a page of procedural asemic writing — random-but-writing-like glyph strokes (Script SOP pen → Tube SOP → ortho render).",
    { mutates: true },
  ),
  "sdf-text": r(
    createSdfTextSchema,
    createSdfTextImpl,
    "Raymarch a text string as an extruded SDF slab: a Text TOP glyph mask fed to a GLSL raymarcher for solid, lit, spinnable 3D letters.",
    { mutates: true },
  ),
  "vertex-displacement-mat": r(
    createVertexDisplacementMatSchema,
    createVertexDisplacementMatImpl,
    "Build a true vertex-shader displacement GLSL MAT (noise- or texture-driven) that deforms real mesh vertices; assign to a Geometry COMP or preview on a demo sphere.",
    { mutates: true },
  ),
  "disorder-grid": r(
    controlledDisorderGridSchema,
    controlledDisorderGridImpl,
    "Generate a grid of quads/lines with a single order↔chaos Disorder knob (0=perfect grid → 1=full chaos) driving per-cell position/rotation/scale jitter.",
    { mutates: true },
  ),
  "blob-trace": r(
    createBlobTraceSchema,
    createBlobTraceImpl,
    "Trace a blob/silhouette into a vector contour outline: monochrome → blur → threshold mask → Trace SOP → wireframe render.",
    { mutates: true },
  ),
  // v0.6.0 — Creative RAG inspiration → execution loop:
  "apply-creative-card": r(
    applyCreativeCardSchema,
    applyCreativeCardImpl,
    "Read a Creative RAG card and route to one of its whitelisted Layer 1 tdmcpAffordances with optional overrides (use `dry_run: true` to preview).",
    { mutates: true },
  ),
  // CLI parity wave — expose every registered MCP tool as a same-named subcommand:
  get_preview: r(
    getPreviewSchema,
    getPreviewImpl,
    "Capture a TOP's current output as an inline PNG image (read-only).",
  ),
  create_pose_reactive: r(
    createPoseReactiveSchema,
    createPoseReactiveImpl,
    "Build a pose-reactive visual system driven by body tracking.",
    { mutates: true },
  ),
  create_safety_blackout_chain: r(
    createSafetyBlackoutChainSchema,
    createSafetyBlackoutChainImpl,
    "Build a safety blackout/failsafe chain in front of the output.",
    { mutates: true },
  ),
  create_setlist_runner: r(
    createSetlistRunnerSchema,
    createSetlistRunnerImpl,
    "Build an in-TD setlist runner network for scene-by-scene shows.",
    { mutates: true },
  ),
  create_show_failover: r(
    createShowFailoverSchema,
    createShowFailoverImpl,
    "Build a show failover switcher (main/backup source watchdog).",
    { mutates: true },
  ),
  auto_repair_loop: r(
    autoRepairLoopSchema,
    autoRepairLoopImpl,
    "Iteratively check a network for errors and apply automatic repairs.",
    { mutates: true },
  ),
  create_auto_montage: r(
    createAutoMontageSchema,
    createAutoMontageImpl,
    "Build an auto-montage switcher that cycles between sources.",
    { mutates: true },
  ),
  create_euclidean_sequencer: r(
    createEuclideanSequencerSchema,
    createEuclideanSequencerImpl,
    "Build a Euclidean rhythm sequencer CHOP network.",
    { mutates: true },
  ),
  create_glsl_material: r(
    createGlslMaterialSchema,
    createGlslMaterialImpl,
    "Create a GLSL MAT material with custom shader code.",
    { mutates: true },
  ),
  create_preset_morph: r(
    createPresetMorphSchema,
    createPresetMorphImpl,
    "Build a preset-morphing rig that interpolates between parameter snapshots.",
    { mutates: true },
  ),
  create_scene_timeline: r(
    createSceneTimelineSchema,
    createSceneTimelineImpl,
    "Build a scene timeline that sequences looks over time.",
    { mutates: true },
  ),
  create_scheduler: r(
    createSchedulerSchema,
    createSchedulerImpl,
    "Build a time-based scheduler that triggers actions on a clock.",
    { mutates: true },
  ),
  focus_network_editor: r(
    focusNetworkEditorSchema,
    focusNetworkEditorImpl,
    "Pan/zoom TouchDesigner's Network Editor to frame given operators (UI-only).",
    { mutates: true },
  ),
  copilot_vision: r(
    copilotVisionSchema,
    copilotVisionImpl,
    "Capture a TOP and ask the configured multimodal LLM a question about it.",
  ),
  export_sop_to_svg: r(
    exportSopToSvgSchema,
    exportSopToSvgImpl,
    "Export a SOP's geometry as an SVG file on disk.",
    { mutates: true },
  ),
  extract_palette: r(
    extractPaletteSchema,
    extractPaletteImpl,
    "Extract a K-color palette from a TOP via deterministic k-means (read-only).",
  ),
  lint_recipe_library: r(
    lintRecipeLibrarySchema,
    lintRecipeLibraryImpl,
    "Offline semantic linter for recipes/*.json (schema, wiring, operators).",
  ),
  manage_packages: r(
    managePackagesSchema,
    managePackagesImpl,
    "List/install/manage Python packages available to the TD bridge.",
    { mutates: true },
  ),
  swap_operator: r(
    swapOperatorSchema,
    swapOperatorImpl,
    "Swap one operator for another type while preserving wiring and parameters.",
    { mutates: true },
  ),
  watch_node: r(
    watchNodeSchema,
    watchNodeImpl,
    "Sample one operator over a short interval: runtime state, params, CHOP channels (read-only).",
  ),
  watch_parameter_changes: r(
    watchParameterChangesSchema,
    watchParameterChangesImpl,
    "Subscribe to (or list/unsubscribe) param.changed events for an operator's parameters.",
    { mutates: true },
  ),
  generative_classics_pack: r(
    generativeClassicsPackSchema,
    generativeClassicsPackImpl,
    "Build a pack of classic generative-art networks in one shot.",
    { mutates: true },
  ),
  load_session_profile: r(
    loadSessionProfileSchema,
    loadSessionProfileImpl,
    "Load (or initialise) the persistent ~/.tdmcp session profile snapshot.",
    { mutates: true },
  ),
  "one-source-five-ways": r(
    oneSourceFiveWaysSchema,
    oneSourceFiveWaysImpl,
    "Generate five deterministic remix briefs from one source.",
  ),
  apply_shader_from_vault: r(
    applyShaderFromVaultSchema,
    applyShaderFromVaultImpl,
    "Apply a GLSL shader stored in the vault to a TD network.",
    { mutates: true },
  ),
  auto_tag_library_asset: r(
    autoTagLibraryAssetSchema,
    autoTagLibraryAssetImpl,
    "Auto-tag a vault library asset's frontmatter from its network contents.",
    { mutates: true },
  ),
  bind_vault_text: r(
    bindVaultTextSchema,
    bindVaultTextImpl,
    "Create a Text DAT bound to a vault note so its text drives TD.",
    { mutates: true },
  ),
  browse_vault_library: r(
    browseVaultLibrarySchema,
    browseVaultLibraryImpl,
    "Browse the vault library (recipes/components) with category counts (read-only).",
  ),
  capture_to_vault: r(
    captureToVaultSchema,
    captureToVaultImpl,
    "Capture a TOP preview and write it into the vault as an attachment note.",
    { mutates: true },
  ),
  export_look_tox: r(
    exportLookToxSchema,
    exportLookToxImpl,
    "Export a look as a .tox component into the vault.",
    { mutates: true },
  ),
  export_network_to_vault: r(
    exportNetworkToVaultSchema,
    exportNetworkToVaultImpl,
    "Export a network snapshot/documentation into the vault.",
    { mutates: true },
  ),
  export_setlist_to_vault: r(
    exportSetlistToVaultSchema,
    exportSetlistToVaultImpl,
    "Write a setlist note (scenes/tracks) into the vault.",
    { mutates: true },
  ),
  generate_from_moodboard: r(
    generateFromMoodboardSchema,
    generateFromMoodboardImpl,
    "Build a visual system from a vault moodboard note.",
    { mutates: true },
  ),
  import_setlist: r(
    importSetlistSchema,
    importSetlistImpl,
    "Read a vault setlist note and build each scene's recipe in TD.",
    { mutates: true },
  ),
  log_performance: r(
    logPerformanceSchema,
    logPerformanceImpl,
    "Write a dated performance journal entry (snapshot + preview) to the vault.",
    { mutates: true },
  ),
  recall_similar_work: r(
    recallSimilarWorkSchema,
    recallSimilarWorkImpl,
    "Rank past vault memory notes by similarity to a new visual goal (read-only).",
  ),
  save_component_to_vault: r(
    saveComponentToVaultSchema,
    saveComponentToVaultImpl,
    "Save a component (.tox + note) into the vault library.",
    { mutates: true },
  ),
  save_recipe_to_vault: r(
    saveRecipeToVaultSchema,
    saveRecipeToVaultImpl,
    "Save a recipe JSON + note into the vault library.",
    { mutates: true },
  ),
  scaffold_recipe_from_network: r(
    scaffoldRecipeFromNetworkSchema,
    scaffoldRecipeFromNetworkImpl,
    "Scaffold a RecipeSchema JSON from a live TD network into the vault.",
    { mutates: true },
  ),
  scaffold_vault: r(
    scaffoldVaultSchema,
    scaffoldVaultImpl,
    "Scaffold the vault folder structure (Recipes/, Components/, Memory/, …).",
    { mutates: true },
  ),
  style_memory: r(
    styleMemorySchema,
    styleMemoryImpl,
    "Read or update the artist's standing style memory note in the vault.",
    { mutates: true },
  ),
  sync_presets_vault: r(
    syncPresetsVaultSchema,
    syncPresetsVaultImpl,
    "Sync presets between TD and the vault.",
    { mutates: true },
  ),
  tag_and_search_library: r(
    tagAndSearchLibrarySchema,
    tagAndSearchLibraryImpl,
    "Faceted browse + tag editing over the vault library.",
    { mutates: true },
  ),
  tutorial_companion_pack: r(
    tutorialCompanionPackSchema,
    tutorialCompanionPackImpl,
    "Write a tutorial companion pack (notes + previews) into the vault.",
    { mutates: true },
  ),
  version_library_asset: r(
    versionLibraryAssetSchema,
    versionLibraryAssetImpl,
    "Version a vault library asset (semver bump + changelog trail).",
    { mutates: true },
  ),
  publish_recipe_bundle: r(
    publishRecipeBundleSchema,
    publishRecipeBundleImpl,
    "Publish a signed/versioned recipe bundle artifact to disk.",
    { mutates: true },
  ),
};

const SPECIAL_COMMANDS: AgentCommandCatalogEntry[] = [
  {
    command: "commands",
    summary: "Print the machine-readable tdmcp-agent command catalog.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "help <command>",
    summary: "Print focused help for one command without contacting TouchDesigner.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "schema <command>",
    summary: "Print a command's JSON Schema and metadata.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "config",
    summary: "Print the effective config, list profiles, or initialize a starter config.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "run <file|->",
    summary: "Run a JSON command file or stdin command stream.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "completion <shell>",
    summary: "Print a completion snippet for bash, zsh, or fish.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "preview <nodePath>",
    summary: "Capture a TOP to a PNG file.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "watch",
    summary: "Stream TouchDesigner events as newline-delimited JSON.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "repl",
    summary: "Interactive tdmcp-agent command loop.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "doctor",
    summary: "Diagnose TD bridge, LLM, vault, config and tool setup.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "panic <sub>",
    summary: "Live blackout/freeze hotkey verbs.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "setlist run <file>",
    summary: "Drive a setlist scene-by-scene.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "show-director",
    summary: "Dry-run AI Show Director intent policy decisions.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "ai-party-poc",
    summary: "Run the AI-Controlled Party producer POC in dry-run/simulated mode.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "ai-party",
    summary: "Dry-run one Hermes/Telegram AI party message through policy.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "ai-party llm-setup",
    summary: "Check/start local Ollama and print AI Party ShowIntent model setup commands.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "ai-party telegram-once",
    summary: "Process one Telegram long-poll batch through the AI party gateway.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "schedule <file>",
    summary: "Run scene scheduler triggers.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "version",
    summary: "Print the installed package version.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "watch-build",
    summary: "Watch bridge/source files, rebuild, and reload TD bridge changes.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "soundcheck-monitor",
    summary: "Monitor soundcheck health and emit operator-friendly status.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "log-tail",
    summary: "Tail and filter TouchDesigner bridge logs.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "record-fixtures",
    summary: "Record bridge fixtures for offline tests.",
    mutates: false,
    unsafe: false,
    source: "cli",
  },
  {
    command: "fanout",
    summary: "Fan out commands to multiple bridge targets.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "controller-bridge",
    summary: "Bridge controller events into tdmcp commands.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "voice",
    summary: "Run the voice copilot command interface.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
  {
    command: "llm-voice",
    summary: "Run the LLM-backed voice copilot.",
    mutates: true,
    unsafe: false,
    source: "cli",
  },
];

export function listAgentCommands(): AgentCommandCatalogEntry[] {
  const commandEntries: AgentCommandCatalogEntry[] = Object.entries(COMMANDS).map(
    ([command, cmd]) => ({
      command,
      summary: cmd.summary,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      source: "tool",
    }),
  );
  return [...commandEntries, ...SPECIAL_COMMANDS].sort((a, b) =>
    a.command.localeCompare(b.command),
  );
}

function commandTags(entry: Pick<AgentCommandCatalogEntry, "mutates" | "unsafe">): string {
  return [entry.mutates ? "mutates" : "", entry.unsafe ? "unsafe" : ""].filter(Boolean).join(",");
}

function commandGroup(entry: AgentCommandCatalogEntry): string {
  if (entry.unsafe) return "Unsafe escape hatches";
  if (entry.source === "cli") return "CLI workflow";
  if (
    /^(info|reload|nodes|errors|document|diff|digest|optimize|analyze|params-modes|node-state|logs|serialize|inspect-comp|score-build|gpu-displays|hardware-diagnose)/.test(
      entry.command,
    )
  ) {
    return "Inspection & diagnostics";
  }
  if (
    /^(classes|module|operators|recipes|plan|library|manifest|asset-validate)/.test(entry.command)
  ) {
    return "Knowledge & resources";
  }
  if (
    /(library|recipe|bundle|pack|package|tox|vault|asset|marketplace|provenance|checksum|changelog|component)/.test(
      entry.command,
    )
  ) {
    return "Library, packaging & vaults";
  }
  if (entry.mutates) return "Creative builders & operations";
  return "Knowledge & resources";
}

function groupedCommandCatalog(): Array<{ title: string; entries: AgentCommandCatalogEntry[] }> {
  const order = [
    "Inspection & diagnostics",
    "Creative builders & operations",
    "Library, packaging & vaults",
    "Knowledge & resources",
    "CLI workflow",
    "Unsafe escape hatches",
  ];
  const grouped = new Map<string, AgentCommandCatalogEntry[]>();
  for (const entry of listAgentCommands()) {
    const title = commandGroup(entry);
    grouped.set(title, [...(grouped.get(title) ?? []), entry]);
  }
  return order
    .map((title) => ({ title, entries: grouped.get(title) ?? [] }))
    .filter((group) => group.entries.length > 0);
}

function findSpecialCommand(target: string): AgentCommandCatalogEntry | undefined {
  const normalized = target.trim();
  return SPECIAL_COMMANDS.find((entry) => {
    const base = entry.command.replace(/\s+<[^>]+>/g, "");
    return entry.command === normalized || base === normalized;
  });
}

function formatCommandHelp(target: string): string | undefined {
  const cmd = COMMANDS[target];
  const entry: AgentCommandCatalogEntry | undefined = cmd
    ? {
        command: target,
        summary: cmd.summary,
        mutates: cmd.mutates,
        unsafe: cmd.unsafe,
        source: "tool",
      }
    : findSpecialCommand(target);
  if (!entry) return undefined;

  const lines = [`tdmcp-agent ${target}`, "", entry.summary, ""];
  lines.push(`source: ${entry.source}`);
  lines.push(`mutates: ${entry.mutates}`);
  lines.push(`unsafe: ${entry.unsafe}`);
  if (cmd) {
    lines.push("", "Input schema:", JSON.stringify(z.toJSONSchema(cmd.schema), null, 2));
  } else if (target === "show-director") {
    lines.push("", "Input schema:", JSON.stringify(z.toJSONSchema(showDirectorCliSchema), null, 2));
  } else if (target === "ai-party-poc") {
    lines.push("", "Input schema:", JSON.stringify(z.toJSONSchema(aiPartyPocCliSchema), null, 2));
  } else if (target === "ai-party") {
    lines.push("", "Input schema:", JSON.stringify(z.toJSONSchema(AiPartyGatewaySchema), null, 2));
  } else if (target === "ai-party telegram-once") {
    lines.push(
      "",
      "Input schema:",
      JSON.stringify(z.toJSONSchema(TelegramShowPollOnceSchema), null, 2),
    );
  }
  return lines.join("\n");
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Prefer the structured channel; fall back to a JSON code-fence, then to the raw text. */
function extractData(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  const fence = text.match(/```json\n([\s\S]*?)\n```/);
  if (fence) {
    try {
      return JSON.parse(fence[1] as string);
    } catch {
      // fall through
    }
  }
  return { message: text };
}

function firstArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
  }
  return null;
}

function rowValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function tableRows(data: unknown): Record<string, unknown>[] {
  const list = firstArray(data) ?? [data];
  return list.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return item as Record<string, unknown>;
    }
    return { value: item };
  });
}

function tableHeaders(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return headers.length ? headers : ["value"];
}

function formatTable(data: unknown): string {
  const rows = tableRows(data);
  if (!rows.length) return "";
  const headers = tableHeaders(rows);
  const body = rows.map((row) => headers.map((header) => rowValue(row[header])));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  const divider = widths.map((width) => "-".repeat(Math.max(width, 1))).join("  ");
  return [line(headers), divider, ...body.map(line)].join("\n");
}

function csvCell(value: unknown): string {
  const text = rowValue(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatCsv(data: unknown): string {
  const rows = tableRows(data);
  if (!rows.length) return "";
  const headers = tableHeaders(rows);
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  return lines.join("\n");
}

function resolveCommand(positionals: string[]): { key: string; cmd: Command } | undefined {
  const key2 = positionals.slice(0, 2).join(" ");
  if (COMMANDS[key2]) return { key: key2, cmd: COMMANDS[key2] };
  const key1 = positionals[0] ?? "";
  if (COMMANDS[key1]) return { key: key1, cmd: COMMANDS[key1] };
  return undefined;
}

function usage(): string {
  const lines = ["tdmcp-agent — drive TouchDesigner from a shell (machine-readable output).", ""];
  lines.push("Usage: tdmcp-agent <command> [--params '<json>'] [--json '<json>'] [flags]", "");
  lines.push("Flags:");
  lines.push(
    "  --params <json>   Arguments object (validated against the command's input schema).",
  );
  lines.push("  --json <json>     Merged into --params (e.g. for request bodies).");
  lines.push("  --output <fmt>    json (default) | ndjson | text | table | csv.");
  lines.push("  --dry-run         Validate and print the intended call without executing.");
  lines.push("  --allow-unsafe    Required for `exec` escape-hatch commands.");
  lines.push("  -o, --out <file>  (preview) Output PNG path. Defaults to ./preview.png.");
  lines.push("  --include-high-frequency  (watch) Also stream timeline.frame / node.cook events.");
  lines.push("  --profile <name>  Use a named profile from your config file (tdmcp.json).");
  lines.push("  --config <path>   Use a specific config file instead of the search order.");
  lines.push(
    "  --td-host <h> / --td-port <p> / --timeout <ms>  Override the bridge for this call.",
  );
  lines.push(
    "  --params-file <f> / --params -   Read --params JSON from a file or stdin (Unix pipe).",
  );
  lines.push("  --continue-on-error  With `run`, execute remaining steps after a failure.");
  lines.push("  --filter / --exclude <csv>  (watch) Only/never stream these event types.");
  lines.push("  --on <csv> --exec <cmd>  (watch) Run a shell command for matching events.");
  lines.push("  --debounce-ms <ms>  (watch) Minimum gap between --exec runs per event type.");
  lines.push("  --heartbeat-ms <ms>  (watch) Periodically print an event-count heartbeat.");
  lines.push("  --pretty         (watch) Render compact event labels instead of raw ndjson.");
  lines.push(
    "  --no-color       Disable terminal color output (accepted for script compatibility).",
  );
  lines.push("  -q, --quiet       Suppress the stderr summary (stdout=data, for pipelines/CI).");
  lines.push("  -V, --version     Print the version and exit.");
  lines.push("  -h, --help        Show this help.", "");
  lines.push("Commands:");
  for (const group of groupedCommandCatalog()) {
    lines.push(`  ${group.title}:`);
    for (const entry of group.entries) {
      const tags = commandTags(entry);
      lines.push(`    ${entry.command.padEnd(24)} ${entry.summary}${tags ? `  [${tags}]` : ""}`);
    }
  }
  return lines.join("\n");
}

export interface RunCliOptions {
  /** Inject a context (used by tests); production builds one from env config. */
  makeCtx?: () => ToolContext;
  /** Inject stdin for tests; production reads fd 0. */
  stdin?: string;
}

/** Build {@link LoadConfigOptions} from the global CLI flags (profile / config / host / port / timeout). */
function cliLoadOptions(values: Record<string, unknown>): LoadConfigOptions {
  const overrides: Record<string, unknown> = {};
  if (typeof values["td-host"] === "string") overrides.tdHost = values["td-host"];
  if (typeof values["td-port"] === "string") overrides.tdPort = values["td-port"];
  if (typeof values.timeout === "string") overrides.requestTimeoutMs = values.timeout;
  return {
    useFiles: true,
    profile: typeof values.profile === "string" ? values.profile : undefined,
    configPath: typeof values.config === "string" ? values.config : undefined,
    overrides,
  };
}

function buildCtx(
  opts: RunCliOptions,
  loadOpts: LoadConfigOptions = { useFiles: true },
): ToolContext {
  return opts.makeCtx
    ? opts.makeCtx()
    : buildToolContext(loadConfig(process.env, loadOpts), { logger: silentLogger });
}

/** Config key → TDMCP_* env var name, for the `config --write-env` exporter. */
const ENV_NAMES: Record<keyof TdmcpConfig, string> = {
  tdHost: "TDMCP_TD_HOST",
  tdPort: "TDMCP_TD_PORT",
  transport: "TDMCP_TRANSPORT",
  logLevel: "TDMCP_LOG_LEVEL",
  requestTimeoutMs: "TDMCP_REQUEST_TIMEOUT_MS",
  httpPort: "TDMCP_HTTP_PORT",
  events: "TDMCP_EVENTS",
  rawPython: "TDMCP_RAW_PYTHON",
  yolo: "TDMCP_YOLO",
  toolProfile: "TDMCP_TOOL_PROFILE",
  bridgeToken: "TDMCP_BRIDGE_TOKEN",
  httpAuthToken: "TDMCP_HTTP_AUTH_TOKEN",
  llmBaseUrl: "TDMCP_LLM_BASE_URL",
  llmModel: "TDMCP_LLM_MODEL",
  llmApiKey: "TDMCP_LLM_API_KEY",
  llmTier: "TDMCP_LLM_TIER",
  llmMaxSteps: "TDMCP_LLM_MAX_STEPS",
  llmTemperature: "TDMCP_LLM_TEMPERATURE",
  chatPort: "TDMCP_CHAT_PORT",
  telegramBotToken: "TDMCP_TELEGRAM_BOT_TOKEN",
  telegramAllowedChats: "TDMCP_TELEGRAM_ALLOWED_CHATS",
  telegramAllowedUsers: "TDMCP_TELEGRAM_ALLOWED_USERS",
  telegramDefaultTier: "TDMCP_TELEGRAM_DEFAULT_TIER",
  telegramPollTimeoutSec: "TDMCP_TELEGRAM_POLL_TIMEOUT_SEC",
  telegramConfirmTimeoutMs: "TDMCP_TELEGRAM_CONFIRM_TIMEOUT_MS",
  vaultPath: "TDMCP_VAULT_PATH",
  ragEnabled: "TDMCP_RAG_ENABLED",
  ragDataDir: "TDMCP_RAG_DATA_DIR",
  ragOllamaUrl: "TDMCP_RAG_OLLAMA_URL",
  ragEmbedModel: "TDMCP_RAG_EMBED_MODEL",
  ragLicenseAllowlist: "TDMCP_RAG_LICENSE_ALLOWLIST",
  ragEmbedBatch: "TDMCP_RAG_EMBED_BATCH",
  ragBackend: "TDMCP_RAG_BACKEND",
  ragSmithsonianKey: "TDMCP_RAG_SMITHSONIAN_KEY",
  ragEuropeanaKey: "TDMCP_RAG_EUROPEANA_KEY",
  ragApplyCard: "TDMCP_RAG_APPLY_CARD",
  ragInjectAsk: "TDMCP_RAG_INJECT_ASK",
  ragInjectK: "TDMCP_RAG_INJECT_K",
  ragInjectTimeoutMs: "TDMCP_RAG_INJECT_TIMEOUT_MS",
  ragProbeTimeoutMs: "TDMCP_RAG_PROBE_TIMEOUT_MS",
  ragFusion: "TDMCP_RAG_FUSION",
  ragFusionK: "TDMCP_RAG_FUSION_K",
  projectRagEnabled: "TDMCP_PROJECT_RAG_ENABLED",
  projectRagBridgeAnalysis: "TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS",
  projectRagBridgePort: "TDMCP_PROJECT_RAG_BRIDGE_PORT",
  projectRagGhToken: "TDMCP_PROJECT_RAG_GH_TOKEN",
  projectRagGithubRepos: "TDMCP_PROJECT_RAG_GITHUB_REPOS",
  projectRagGithubTopics: "TDMCP_PROJECT_RAG_GITHUB_TOPICS",
  projectRagTopicCap: "TDMCP_PROJECT_RAG_TOPIC_CAP",
  projectRagDerivativeRoot: "TDMCP_PROJECT_RAG_DERIVATIVE_ROOT",
  projectRagIihq: "TDMCP_PROJECT_RAG_IIHQ",
  projectRagIihqRef: "TDMCP_PROJECT_RAG_IIHQ_REF",
  projectRagAnalyzeTimeoutMs: "TDMCP_PROJECT_RAG_ANALYZE_TIMEOUT_MS",
  projectRagLicenseAllowlist: "TDMCP_PROJECT_RAG_LICENSE_ALLOWLIST",
  projectRagScoreWeights: "TDMCP_PROJECT_RAG_SCORE_WEIGHTS",
};
const SECRET_ENV: ReadonlySet<keyof TdmcpConfig> = new Set([
  "bridgeToken",
  "httpAuthToken",
  "llmApiKey",
  "telegramBotToken",
  "telegramAllowedChats",
  "telegramAllowedUsers",
  "ragSmithsonianKey",
  "ragEuropeanaKey",
  "projectRagGhToken",
]);

/** A paste-ready `export TDMCP_*=...` block; secrets are emitted commented-out (set manually). */
function envExportLines(config: TdmcpConfig): string[] {
  const lines: string[] = ["# tdmcp effective config (secrets redacted — set them manually)"];
  for (const [key, name] of Object.entries(ENV_NAMES) as [keyof TdmcpConfig, string][]) {
    const value = config[key];
    if (value === undefined) continue;
    if (SECRET_ENV.has(key)) lines.push(`# export ${name}=<set manually>`);
    else if (key === "projectRagScoreWeights" && value && typeof value === "object") {
      const weights = value as {
        technical: number;
        license: number;
        freshness: number;
        reliability: number;
      };
      lines.push(
        `export ${name}=${JSON.stringify(`${weights.technical}:${weights.license}:${weights.freshness}:${weights.reliability}`)}`,
      );
    } else lines.push(`export ${name}=${JSON.stringify(String(value))}`);
  }
  return lines;
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: normalizeCatalogJsonFlag(argv),
    allowPositionals: true,
    options: {
      params: { type: "string" },
      json: { type: "string" },
      output: { type: "string", default: "json" },
      "dry-run": { type: "boolean", default: false },
      "allow-unsafe": { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      "include-high-frequency": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      // Global config selection / overrides (apply to any command).
      profile: { type: "string" },
      config: { type: "string" },
      "td-host": { type: "string" },
      "td-port": { type: "string" },
      timeout: { type: "string" },
      "write-env": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      "no-color": { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      version: { type: "boolean", short: "V", default: false },
      "params-file": { type: "string" },
      "continue-on-error": { type: "boolean", default: false },
      filter: { type: "string" },
      exclude: { type: "string" },
      pretty: { type: "boolean", default: false },
      on: { type: "string" },
      exec: { type: "string" },
      "debounce-ms": { type: "string" },
      "heartbeat-ms": { type: "string" },
      // `panic` top-level verb:
      target: { type: "string" },
      "auto-build": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      // `setlist` subcommand:
      setlist: { type: "string" },
      mode: { type: "string" },
      start: { type: "string" },
      loop: { type: "boolean", default: false },
      "comp-path": { type: "string" },
      "beats-per-bar": { type: "string" },
      quantize: { type: "string" },
      // `schedule` subcommand:
      once: { type: "boolean", default: false },
      "tz-info": { type: "boolean", default: false },
      // `ai-party` local ShowIntent model integration:
      llm: { type: "boolean", default: false },
      "llm-model": { type: "string" },
      "llm-base-url": { type: "string" },
      "no-ollama": { type: "boolean", default: false },
      // `preview --inline [--watch]`:
      inline: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      interval: { type: "string" },
    },
  });
}

function normalizeCatalogJsonFlag(argv: string[]): string[] {
  if (firstPositionalArg(argv) === "doctor") return normalizeDoctorJsonFlag(argv);
  if (firstPositionalArg(argv) !== "commands") return argv;
  let seenCommand = false;
  return argv.filter((arg, index) => {
    if (!seenCommand && arg === "commands") seenCommand = true;
    if (!seenCommand) return true;
    if (arg !== "--json") return true;
    const next = argv[index + 1];
    return typeof next === "string" && next !== "" && !next.startsWith("-");
  });
}

// `doctor --json` alias: `--json` is a global string option (inline JSON args), so a bare
// `--json` after `doctor` would fail with "argument missing"; rewrite it to `--output json`.
function normalizeDoctorJsonFlag(argv: string[]): string[] {
  return argv.flatMap((arg, index) => {
    if (arg !== "--json") return [arg];
    const next = argv[index + 1];
    // Option-like (`-q`, `--fix`) means no value; JSON can start with "-" (e.g. `-1`).
    const hasValue = typeof next === "string" && next !== "" && !/^-[-a-zA-Z]/.test(next);
    return hasValue ? [arg] : ["--output", "json"];
  });
}

const CLI_VALUE_OPTIONS = new Set([
  "--params",
  "--json",
  "--output",
  "--out",
  "-o",
  "--profile",
  "--config",
  "--td-host",
  "--td-port",
  "--timeout",
  "--params-file",
  "--filter",
  "--exclude",
  "--on",
  "--exec",
  "--debounce-ms",
  "--heartbeat-ms",
  "--target",
  "--setlist",
  "--mode",
  "--start",
  "--comp-path",
  "--beats-per-bar",
  "--quantize",
  "--llm-model",
  "--llm-base-url",
]);

function firstPositionalArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") return argv[i + 1];
    if (!arg.startsWith("-")) return arg;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (CLI_VALUE_OPTIONS.has(flag) && !arg.includes("=")) i++;
  }
  return undefined;
}

/** The installed package version (read once from package.json next to the bundle). */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Levenshtein distance — for "did you mean" suggestions on an unknown command. */
function editDistance(a: string, b: string): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/** Nearest known command to an unknown input (within a small edit distance), or undefined. */
function nearestCommand(input: string): string | undefined {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  // Candidates: full command names and their first token (so "noeds" → "nodes").
  const commandNames = listAgentCommands().map((entry) => entry.command);
  const firstTokens = commandNames.map((command) => command.split(" ")[0] ?? command);
  const keys = [...new Set([...commandNames, ...firstTokens])];
  for (const key of keys) {
    // Never suggest the exact token the user typed: when a known-but-unresolvable
    // command (e.g. a gated `exec`) is entered verbatim, "Did you mean exec?" is
    // pure noise. A useful "did you mean" must point at a *different* command.
    if (key === input) continue;
    const d = editDistance(input, key);
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  // Only suggest a genuinely close match (≤ a third of the input length, min 2).
  return best !== undefined && bestDist <= Math.max(2, Math.floor(input.length / 3))
    ? best
    : undefined;
}

/** Reads stdin to a string (for `--params -`). Synchronous: the CLI is a one-shot. */
function readStdin(opts: Pick<RunCliOptions, "stdin"> = {}): string {
  if (opts.stdin !== undefined) return opts.stdin;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Assembles the args object from --params (inline, `-` for stdin, or via --params-file)
 * merged with --json. Completes the Unix-filter story: `… | tdmcp-agent x --params -`.
 */
function assembleParams(
  values: Record<string, unknown>,
  opts: Pick<RunCliOptions, "stdin"> = {},
): { raw: Record<string, unknown> } | { error: string } {
  const raw: Record<string, unknown> = {};
  try {
    let paramsStr = typeof values.params === "string" ? values.params : undefined;
    if (paramsStr === "-") paramsStr = readStdin(opts);
    else if (typeof values["params-file"] === "string")
      paramsStr = readFileSync(values["params-file"], "utf8");
    if (typeof paramsStr === "string" && paramsStr.trim())
      Object.assign(raw, JSON.parse(paramsStr));
    if (typeof values.json === "string") Object.assign(raw, JSON.parse(values.json));
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { raw };
}

function blockedAiPartyLlmResult(
  args: z.infer<typeof AiPartyGatewaySchema>,
  reason: string,
): AiPartyGatewayResult {
  const decision: PolicyDecision = {
    decision: "block",
    reason,
    intent_type: "llm_showintent",
    limits_applied: [],
    requires_operator: false,
  };
  const state = args.state ?? createShowDirectorState();
  const next = ShowDirectorStateSchema.parse(state);
  next.audit_log.push({
    id: `audit_${String(next.audit_log.length + 1).padStart(4, "0")}`,
    at: new Date().toISOString(),
    status: "blocked",
    intent_type: decision.intent_type,
    decision: decision.decision,
    reason: decision.reason,
  });
  const result: AiPartyGatewayResult = {
    dryRun: true,
    source: "blocked",
    message: args.message,
    decision,
    plan: [],
    state: next,
    telegram_reply: "",
  };
  return { ...result, telegram_reply: formatAiPartyTelegramReply(result) };
}

const runStepSchema = z
  .object({
    command: z.union([z.string(), z.array(z.string()).min(1)]),
    params: z.record(z.string(), z.unknown()).optional(),
    json: z.record(z.string(), z.unknown()).optional(),
    output: z.enum(["json", "ndjson", "text"]).optional(),
    dry_run: z.boolean().optional(),
    allow_unsafe: z.boolean().optional(),
    quiet: z.boolean().optional(),
    no_color: z.boolean().optional(),
  })
  .passthrough();
const runFileSchema = z.union([
  z.array(runStepSchema),
  z.object({ steps: z.array(runStepSchema) }),
]);
type RunStep = z.infer<typeof runStepSchema>;

function runStepArgv(step: RunStep): string[] {
  const argv = Array.isArray(step.command) ? [...step.command] : tokenizeLine(step.command);
  if (step.params !== undefined) argv.push("--params", JSON.stringify(step.params));
  if (step.json !== undefined) argv.push("--json", JSON.stringify(step.json));
  if (step.output !== undefined) argv.push("--output", step.output);
  if (step.dry_run === true) argv.push("--dry-run");
  if (step.allow_unsafe === true) argv.push("--allow-unsafe");
  if (step.quiet === true) argv.push("--quiet");
  if (step.no_color === true) argv.push("--no-color");
  return argv;
}

function forwardedGlobalArgv(values: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const key of ["config", "profile", "td-host", "td-port", "timeout"]) {
    const value = values[key];
    if (typeof value === "string") argv.push(`--${key}`, value);
  }
  if (values["dry-run"] === true) argv.push("--dry-run");
  if (values["allow-unsafe"] === true) argv.push("--allow-unsafe");
  if (values["no-color"] === true) argv.push("--no-color");
  return argv;
}

function parseStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return stdout;
  }
}

function completionWords(): string[] {
  const commands = listAgentCommands().map((entry) => entry.command);
  const flags = [
    "--params",
    "--json",
    "--output",
    "--dry-run",
    "--allow-unsafe",
    "--out",
    "--include-high-frequency",
    "--profile",
    "--config",
    "--td-host",
    "--td-port",
    "--timeout",
    "--params-file",
    "--continue-on-error",
    "--filter",
    "--exclude",
    "--on",
    "--exec",
    "--debounce-ms",
    "--heartbeat-ms",
    "--pretty",
    "--quiet",
    "--no-color",
    "--force",
    "--version",
    "--help",
  ];
  return [...commands, ...flags];
}

export function completeReplLine(line: string): [string[], string] {
  const words = [...completionWords(), "exit", "quit"];
  const trimmedLeft = line.trimStart();
  const prefix = trimmedLeft.includes(" ") ? (trimmedLeft.match(/\S*$/)?.[0] ?? "") : trimmedLeft;
  const matches = words.filter((word) => word.startsWith(prefix));
  return [matches.length ? matches : words, prefix];
}

export function replHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TDMCP_AGENT_HISTORY?.trim();
  if (explicit) return explicit;
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "tdmcp-agent", "history");
}

export function loadReplHistory(path = replHistoryPath()): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-1000);
  } catch {
    return [];
  }
}

export function saveReplHistory(lines: string[], path = replHistoryPath()): void {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 && all.indexOf(line) === index)
    .slice(-1000);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, cleaned.length ? `${cleaned.join("\n")}\n` : "", "utf8");
  } catch {
    // History is a convenience; never fail the interactive session because it cannot be saved.
  }
}

function completionScript(shell: string): string | undefined {
  const words = completionWords().join(" ");
  if (shell === "bash") {
    return [
      "_tdmcp_agent() {",
      `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
      `  COMPREPLY=( $(compgen -W '${words}' -- "$cur") )`,
      "}",
      "complete -F _tdmcp_agent tdmcp-agent",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    return ["#compdef tdmcp-agent", `_arguments '*::command:(${words})'`, ""].join("\n");
  }
  if (shell === "fish") {
    return [`complete -c tdmcp-agent -f -a '${words}'`, ""].join("\n");
  }
  return undefined;
}

/** `--interval` for `preview --watch`, clamped to a 100ms floor (default 1000ms). */
function previewIntervalMs(values: Record<string, unknown>): number {
  const raw = typeof values.interval === "string" ? Number(values.interval) : Number.NaN;
  return Number.isFinite(raw) && raw >= 100 ? raw : 1000;
}

/**
 * `preview --inline [--watch]`: render a terminal thumbnail (iTerm2/Kitty, else an
 * honest ASCII fallback). `--watch` re-renders on an interval until Ctrl-C; the abort
 * controller is wired to SIGINT/SIGTERM only in watch mode.
 */
async function runInlinePreview(
  ctx: ToolContext,
  args: { node_path: string; width: number; height: number },
  values: Record<string, unknown>,
  watchMode: boolean,
): Promise<CliResult> {
  const ac = new AbortController();
  const onSig = () => ac.abort();
  if (watchMode) {
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  }
  try {
    const r = await runPreviewInline(ctx.client, {
      nodePath: args.node_path,
      width: args.width,
      height: args.height,
      watch: watchMode,
      intervalMs: previewIntervalMs(values),
      signal: ac.signal,
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

/** `preview <nodePath> -o file.png`: capture the TOP and write it to disk. */
async function capturePreviewToFile(
  ctx: ToolContext,
  args: { node_path: string; width: number; height: number },
  outPath: string,
): Promise<CliResult> {
  try {
    const preview = await capturePreview(ctx.client, args.node_path, args.width, args.height);
    const bytes = Buffer.from(preview.base64, "base64");
    writeFileSync(outPath, bytes);
    const doc = {
      node_path: preview.path,
      file: resolve(outPath),
      width: preview.width,
      height: preview.height,
      bytes: bytes.length,
      mimeType: preview.mimeType,
    };
    return {
      stdout: `${JSON.stringify(doc, null, 2)}\n`,
      stderr: `Saved preview of ${preview.path} to ${outPath} (${bytes.length} bytes).\n`,
      code: 0,
    };
  } catch (err) {
    const msg = friendlyTdError(err);
    return { stdout: "", stderr: `${msg}\n`, code: classifyTdErrorExit(msg) };
  }
}

type PreviewArgs = { node_path: string; width: number; height: number };

/** Assemble + validate `preview` args (node_path required). Returns args or an error result. */
function parsePreviewArgs(
  values: Record<string, unknown>,
  positionals: string[],
  opts: RunCliOptions,
): { args: PreviewArgs } | { error: CliResult } {
  const assembled = assembleParams(values, opts);
  if ("error" in assembled) {
    const stderr = `Invalid JSON in --params/--json: ${assembled.error}\n`;
    return { error: { stdout: "", stderr, code: 2 } };
  }
  const raw = assembled.raw;
  if (positionals[1]) raw.node_path = positionals[1];
  // The CLI always captures (never collects a deferred job), so node_path is required.
  const parsed = getPreviewSchema.required({ node_path: true }).safeParse(raw);
  if (!parsed.success) {
    const stderr = `Invalid arguments for "preview": ${parsed.error.message}\n`;
    return { error: { stdout: "", stderr, code: 2 } };
  }
  return { args: parsed.data };
}

/** `preview <nodePath>` to a PNG file (or `--inline`/`--dry-run`). A CLI side effect. */
async function handlePreviewCommand(
  values: Record<string, unknown>,
  positionals: string[],
  opts: RunCliOptions,
): Promise<CliResult> {
  const result = parsePreviewArgs(values, positionals, opts);
  if ("error" in result) return result.error;
  const args = result.args;
  const inlineMode = values.inline === true;
  const watchMode = values.watch === true;
  const outPath = typeof values.out === "string" && values.out ? values.out : "preview.png";
  if (values["dry-run"]) {
    const doc = inlineMode
      ? { dryRun: true, command: "preview", args, inline: true, watch: watchMode }
      : { dryRun: true, command: "preview", args, out: resolve(outPath) };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }
  let ctx: ToolContext;
  try {
    ctx = buildCtx(opts, cliLoadOptions(values));
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }
  if (inlineMode) return runInlinePreview(ctx, args, values, watchMode);
  return capturePreviewToFile(ctx, args, outPath);
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }

  const { values, positionals } = parsed;
  if (values.version || positionals[0] === "version") {
    return {
      stdout: `tdmcp-agent ${packageVersion()} (node ${process.version})\n`,
      stderr: "",
      code: 0,
    };
  }
  if (values.help && positionals.length > 0) {
    const target = positionals.join(" ");
    const help = formatCommandHelp(target);
    if (!help) {
      return { stdout: "", stderr: `Unknown command for help: "${target}".\n`, code: 2 };
    }
    return { stdout: `${help}\n`, stderr: "", code: 0 };
  }
  if (values.help || positionals.length === 0) {
    return { stdout: `${usage()}\n`, stderr: "", code: 0 };
  }

  // `help <command>` — focused offline help for humans and agents that need the
  // exact schema/side-effect flags for one verb.
  if (positionals[0] === "help") {
    const target = positionals.slice(1).join(" ");
    if (!target) return { stdout: `${usage()}\n`, stderr: "", code: 0 };
    const help = formatCommandHelp(target);
    if (!help) {
      return { stdout: "", stderr: `Unknown command for help: "${target}".\n`, code: 2 };
    }
    return { stdout: `${help}\n`, stderr: "", code: 0 };
  }

  // `commands --json` — expose the same command catalog used by docs/resources.
  // It is intentionally offline so CI and agent clients can discover commands
  // without a running TouchDesigner bridge.
  if (positionals[0] === "commands") {
    const commands = listAgentCommands();
    return {
      stdout: `${JSON.stringify({ count: commands.length, commands }, null, 2)}\n`,
      stderr: "",
      code: 0,
    };
  }

  // `schema <command>` — emit the input contract without touching TD.
  if (positionals[0] === "schema") {
    const target = positionals.slice(1).join(" ");
    if (target === "show-director") {
      const doc = {
        command: target,
        summary: "Dry-run AI Show Director intent policy decisions.",
        mutates: false,
        unsafe: false,
        input: z.toJSONSchema(showDirectorCliSchema),
      };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    if (target === "ai-party-poc") {
      const doc = {
        command: target,
        summary: "Run the AI-Controlled Party producer POC in dry-run/simulated mode.",
        mutates: false,
        unsafe: false,
        input: z.toJSONSchema(aiPartyPocCliSchema),
      };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    if (target === "ai-party") {
      const doc = {
        command: target,
        summary: "Dry-run one Hermes/Telegram AI party message through policy.",
        mutates: false,
        unsafe: false,
        input: z.toJSONSchema(AiPartyGatewaySchema),
      };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    if (target === "ai-party telegram-once") {
      const doc = {
        command: target,
        summary: "Process one Telegram long-poll batch through the AI party gateway.",
        mutates: false,
        unsafe: false,
        input: z.toJSONSchema(TelegramShowPollOnceSchema),
      };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    const cmd = COMMANDS[target];
    if (!cmd) return { stdout: "", stderr: `Unknown command for schema: "${target}".\n`, code: 2 };
    const doc = {
      command: target,
      summary: cmd.summary,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      input: z.toJSONSchema(cmd.schema),
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `ai-party-poc` is an offline producer-rehearsal runner. It proves fan-in,
  // policy decisions, approval queue state, audit log, and simulated effects
  // without constructing a TouchDesigner context or touching hardware.
  if (positionals[0] === "ai-party-poc") {
    const assembled = assembleParams(values, opts);
    if ("error" in assembled) {
      return {
        stdout: "",
        stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`,
        code: 2,
      };
    }
    const args = aiPartyPocCliSchema.safeParse(assembled.raw);
    if (!args.success) {
      return {
        stdout: "",
        stderr: `Invalid arguments for "ai-party-poc": ${args.error.message}\n`,
        code: 2,
      };
    }
    const doc = runAiPartyPoc(args.data);
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `ai-party` is the Hermes/Telegram POC entry point. The default mode runs a
  // single message through the dry-run policy path. `telegram-once` performs one
  // Bot API long-poll batch and sends textual replies, but still does not create
  // a TouchDesigner context or drive hardware.
  if (positionals[0] === "ai-party") {
    const assembled = assembleParams(values, opts);
    if ("error" in assembled) {
      return {
        stdout: "",
        stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`,
        code: 2,
      };
    }

    if (positionals[1] === "llm-setup") {
      const report = await inspectAiPartyOllamaSetup({
        model: typeof values["llm-model"] === "string" ? values["llm-model"] : undefined,
        baseUrl: typeof values["llm-base-url"] === "string" ? values["llm-base-url"] : undefined,
        autoStart: values["no-ollama"] !== true,
      });
      return { stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: "", code: 0 };
    }

    if (positionals[1] === "telegram-once") {
      const args = TelegramShowPollOnceSchema.safeParse(assembled.raw);
      if (!args.success) {
        return {
          stdout: "",
          stderr: `Invalid arguments for "ai-party telegram-once": ${args.error.message}\n`,
          code: 2,
        };
      }
      try {
        const result = await pollTelegramShowOnce(args.data);
        return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "", code: 0 };
      } catch (err) {
        return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
      }
    }

    if (positionals[1] !== undefined) {
      return { stdout: "", stderr: `Unknown ai-party verb "${positionals[1]}".\n`, code: 2 };
    }

    const args = AiPartyGatewaySchema.safeParse(assembled.raw);
    if (!args.success) {
      return {
        stdout: "",
        stderr: `Invalid arguments for "ai-party": ${args.error.message}\n`,
        code: 2,
      };
    }
    if (values.llm === true) {
      const llm = await runShowIntentOllama(args.data, {
        model: typeof values["llm-model"] === "string" ? values["llm-model"] : undefined,
        baseUrl: typeof values["llm-base-url"] === "string" ? values["llm-base-url"] : undefined,
      });
      if (!llm.ok) {
        const blocked = blockedAiPartyLlmResult(
          args.data,
          `Ollama ShowIntent planning failed: ${llm.reason}`,
        );
        return { stdout: `${JSON.stringify(blocked, null, 2)}\n`, stderr: "", code: 0 };
      }
      const result = runAiPartyGateway({ ...args.data, hermes: llm.candidate });
      return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "", code: 0 };
    }
    const result = runAiPartyGateway(args.data);
    return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `show-director` is intentionally policy-only for now: it validates a raw
  // LLM/show-control intent and explains the dry-run decision without building a
  // TD context or touching hardware.
  if (positionals[0] === "show-director") {
    const assembled = assembleParams(values, opts);
    if ("error" in assembled) {
      return {
        stdout: "",
        stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`,
        code: 2,
      };
    }
    const args = showDirectorCliSchema.safeParse(assembled.raw);
    if (!args.success) {
      const intentIssues = args.error.issues.filter((issue) => issue.path[0] === "intent");
      if (intentIssues.length > 0) {
        const issues = intentIssues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        return {
          stdout: "",
          stderr: `Malformed show intent: ${issues.join("; ")}\n`,
          code: 2,
        };
      }
      return {
        stdout: "",
        stderr: `Invalid arguments for "show-director": ${args.error.message}\n`,
        code: 2,
      };
    }
    const sub = positionals[1];
    const state = args.data.state ?? createShowDirectorState();
    // Resolve the trusted mixer-scene catalog. A caller-supplied manifest is
    // re-validated (catalog hash must match) before use; otherwise fall back to
    // the built-in demo manifest. A drifted/invalid catalog is a hard error.
    let mixerManifest = DEMO_MIXER_SCENE_MANIFEST;
    if (args.data.mixer_scene_catalog) {
      const loaded = loadMixerSceneManifest(args.data.mixer_scene_catalog);
      if (!loaded.ok) {
        return {
          stdout: "",
          stderr: `Invalid mixer scene catalog: ${loaded.issues.join("; ")}\n`,
          code: 2,
        };
      }
      mixerManifest = loaded.manifest;
    }
    if (sub === "approve" || sub === "cancel") {
      const approvalId = positionals[2];
      if (!approvalId) {
        return {
          stdout: "",
          stderr: `Missing approval id for "show-director ${sub}".\n`,
          code: 2,
        };
      }
      const operator = args.data.operator;
      if (sub === "approve" && !operator) {
        return {
          stdout: "",
          stderr: 'Missing operator for "show-director approve".\n',
          code: 2,
        };
      }
      const resolved =
        sub === "approve"
          ? approveShowIntent(state, approvalId, operator ?? "", {
              policy: args.data.policy,
              mixerSceneManifest: mixerManifest,
            })
          : cancelShowIntent(state, approvalId, operator);
      if (!resolved.ok) return { stdout: "", stderr: `${resolved.reason}\n`, code: 2 };
      const doc = {
        dryRun: true,
        approval: resolved.approval,
        plan: resolved.plan,
        state: resolved.state,
      };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    if (sub !== undefined) {
      return { stdout: "", stderr: `Unknown show-director verb "${sub}".\n`, code: 2 };
    }

    if (args.data.intent === undefined) {
      return { stdout: "", stderr: 'Missing intent for "show-director".\n', code: 2 };
    }
    const parsedIntent = parseShowIntent(args.data.intent, args.data.policy, {
      mixer_scene_manifest: mixerManifest,
    });
    if (!parsedIntent.ok) {
      return {
        stdout: "",
        stderr: `${parsedIntent.decision.reason}\n`,
        code: 2,
      };
    }
    const submitted = submitShowIntent(state, parsedIntent.intent, args.data.policy, {
      mixerSceneManifest: mixerManifest,
    });
    const doc = {
      dryRun: true,
      intent: parsedIntent.intent,
      decision: submitted.decision,
      approval: submitted.approval,
      plan: submitted.plan,
      state: submitted.state,
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `config init [path]` — write a starter .env-style config file (with sane
  // defaults + per-line comments) that an artist can edit and source. Default
  // target is ~/.tdmcp/config.env. Refuses to clobber existing files unless
  // `--force`. `--dry-run` prints the body without touching the filesystem.
  // Pure Node, reachable even when TD is offline.
  if (positionals[0] === "config" && positionals[1] === "init") {
    const out = positionals[2];
    const result = runConfigInit({
      out,
      force: Boolean(values.force),
      dryRun: Boolean(values["dry-run"]),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }

  // `config profiles` — list named profiles from the selected config file without
  // leaking values. `config profile <name>` resolves one named profile and redacts
  // secrets just like `config`.
  if (positionals[0] === "config" && positionals[1] === "profiles") {
    const listed = listConfigProfiles(process.env, cliLoadOptions(values));
    return { stdout: `${JSON.stringify(listed, null, 2)}\n`, stderr: "", code: 0 };
  }
  if (positionals[0] === "config" && positionals[1] === "profile") {
    const profile = positionals[2];
    if (!profile)
      return { stdout: "", stderr: 'Missing profile name for "config profile".\n', code: 2 };
    let cfg: TdmcpConfig;
    try {
      cfg = loadConfig(process.env, { ...cliLoadOptions(values), profile });
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    return {
      stdout: `${JSON.stringify(
        { profile, tdBaseUrl: tdBaseUrl(cfg), ...describeConfig(cfg) },
        null,
        2,
      )}\n`,
      stderr: "",
      code: 0,
    };
  }

  // `config` — print the effective resolved config (secrets redacted), honoring
  // --profile/--config and the host/port overrides; --write-env emits a paste-ready
  // export block. Read-only and reachable even when TD is offline.
  if (positionals[0] === "config") {
    let cfg: TdmcpConfig;
    try {
      cfg = loadConfig(process.env, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    if (values["write-env"]) {
      return { stdout: `${envExportLines(cfg).join("\n")}\n`, stderr: "", code: 0 };
    }
    return {
      stdout: `${JSON.stringify({ tdBaseUrl: tdBaseUrl(cfg), ...describeConfig(cfg) }, null, 2)}\n`,
      stderr: "",
      code: 0,
    };
  }

  // `completion <shell>` — print a static completion snippet without touching TD.
  if (positionals[0] === "completion") {
    const shell = positionals[1] ?? "";
    const script = completionScript(shell);
    if (!script) {
      return {
        stdout: "",
        stderr: 'Unsupported shell for completion. Use "bash", "zsh", or "fish".\n',
        code: 2,
      };
    }
    return { stdout: script, stderr: "", code: 0 };
  }

  // `run <file>` — execute a JSON file of command steps through the same dispatcher.
  if (positionals[0] === "run") {
    const file = positionals[1];
    if (!file) return { stdout: "", stderr: 'Missing file for "run".\n', code: 2 };
    let steps: RunStep[];
    try {
      const rawFile = file === "-" ? readStdin(opts) : readFileSync(file, "utf8");
      const parsedFile = runFileSchema.parse(JSON.parse(rawFile));
      steps = Array.isArray(parsedFile) ? parsedFile : parsedFile.steps;
    } catch (err) {
      return { stdout: "", stderr: `Invalid run file: ${(err as Error).message}\n`, code: 2 };
    }

    const results: Array<{
      index: number;
      command: string[];
      code: number;
      stdout: unknown;
      stderr: string;
    }> = [];
    const globalArgv = forwardedGlobalArgv(values);
    let finalCode = 0;
    for (const [index, step] of steps.entries()) {
      const stepArgv = [...globalArgv, ...runStepArgv(step)];
      const result = await runCli(stepArgv, opts);
      results.push({
        index,
        command: stepArgv,
        code: result.code,
        stdout: parseStdout(result.stdout),
        stderr: result.stderr,
      });
      if (result.code !== 0) {
        if (finalCode === 0) finalCode = result.code;
        if (!values["continue-on-error"]) {
          return {
            stdout: `${JSON.stringify({ steps: results }, null, 2)}\n`,
            stderr: "",
            code: result.code,
          };
        }
      }
    }
    return {
      stdout: `${JSON.stringify({ steps: results }, null, 2)}\n`,
      stderr: "",
      code: finalCode,
    };
  }

  // `preview <nodePath> -o file.png` — capture a TOP and write it to disk. This is a
  // side effect that doesn't fit the CallToolResult command table, so it's handled here.
  if (positionals[0] === "preview") {
    return handlePreviewCommand(values, positionals, opts);
  }

  // `doctor` — environment diagnostic (TD bridge, LLM copilot, vault, config). Read-only and
  // reachable even when TD is offline, so it bypasses the CallToolResult command table.
  if (positionals[0] === "doctor") {
    const make = opts.makeCtx;
    let cfg: TdmcpConfig | undefined;
    if (!make) {
      try {
        cfg = loadConfig(process.env, cliLoadOptions(values));
      } catch (err) {
        return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
      }
    }
    const { stdout, stderr, code, report } = await runDoctor(
      make ? { makeCtx: () => make(), fix: values.fix } : { config: cfg, fix: values.fix },
    );
    // --output json / --json (explicit) → structured report; --quiet → exit code only.
    const explicitJson =
      argv.includes("--output") || normalizeDoctorJsonFlag(argv).includes("--output");
    if (explicitJson && values.output === "json") {
      return { stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: "", code };
    }
    if (values.quiet) return { stdout: "", stderr: "", code };
    return { stdout, stderr, code };
  }

  // `panic <sub>` — live-show hotkey verb (Campaign BEYOND wave 1, v0.7.0).
  if (positionals[0] === "panic") {
    const sub = (positionals[1] ?? "status") as PanicSubVerb;
    const allowed: ReadonlySet<PanicSubVerb> = new Set([
      "on",
      "off",
      "toggle",
      "freeze",
      "unfreeze",
      "clear",
      "status",
    ]);
    if (!allowed.has(sub)) {
      return {
        stdout: "",
        stderr: `error: unknown panic sub-verb "${sub}". Use one of: on, off, toggle, freeze, unfreeze, clear, status.\n`,
        code: 2,
      };
    }
    let ctx: ToolContext;
    try {
      ctx = buildCtx(opts, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    const result = await runPanic(ctx, {
      sub,
      target: typeof values.target === "string" ? values.target : undefined,
      autoBuild: values["auto-build"] === true,
      all: values.all === true,
      json: values.output === "json",
      dryRun: values["dry-run"] === true,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }

  // `setlist run <file>` — drive a setlist via runSetlist + manageCueImpl adapter.
  if (positionals[0] === "setlist") {
    const verb = positionals[1] ?? "run";
    if (verb !== "run") {
      return { stdout: "", stderr: `error: unknown setlist verb "${verb}". Use "run".\n`, code: 2 };
    }
    const file =
      positionals[2] ?? (typeof values.setlist === "string" ? values.setlist : undefined);
    if (!file) return { stdout: "", stderr: 'Missing setlist path for "setlist run".\n', code: 2 };
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      return {
        stdout: "",
        stderr: `error: could not read setlist: ${(err as Error).message}\n`,
        code: 2,
      };
    }
    const parsedCli = setlistRunnerCliSchema.safeParse({
      setlist: file,
      ...(typeof values.mode === "string" ? { mode: values.mode } : {}),
      ...(typeof values.start === "string" ? { start: values.start } : {}),
      ...(values.loop === true ? { loop: true } : {}),
      ...(values["dry-run"] === true ? { dry_run: true } : {}),
      ...(typeof values["comp-path"] === "string" ? { comp_path: values["comp-path"] } : {}),
      ...(typeof values["beats-per-bar"] === "string"
        ? { beats_per_bar: Number(values["beats-per-bar"]) }
        : {}),
      ...(typeof values.quantize === "string" ? { quantize: values.quantize } : {}),
      json: values.output === "json",
    });
    if (!parsedCli.success) {
      return { stdout: "", stderr: `Invalid setlist args: ${parsedCli.error.message}\n`, code: 2 };
    }
    const parsedInput = parseSetlistInput(raw, file);
    if (!parsedInput.ok) {
      return { stdout: "", stderr: `error: ${parsedInput.message}\n`, code: 2 };
    }
    const loaded = loadCanonicalSetlist(parsedInput.input);
    if (!loaded.ok) {
      return { stdout: "", stderr: `error: ${loaded.message}\n`, code: 2 };
    }
    let ctx: ToolContext;
    try {
      ctx = buildCtx(opts, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    const { manageCueImpl } = await import("../tools/layer2/manageCue.js");
    const cueCaller: CueCaller = {
      async fire(call) {
        // manageCueImpl returns a CallToolResult with isError=true on TD/cue
        // failures (missing COMP, unknown cue name, bridge offline) — it does
        // NOT throw. Convert that into a thrown error here so runSetlist's
        // warnings/dry-run-on-bridge-loss path engages instead of silently
        // marking every fire as success.
        const res = await manageCueImpl(ctx, {
          action: call.action,
          comp_path: call.comp_path,
          name: call.name,
          duration: call.duration,
          quantize: call.quantize,
        });
        if (res.isError) {
          const text = res.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")
            .trim();
          throw new Error(text || `manage_cue ${call.action} failed`);
        }
      },
    };
    const lines: string[] = [];
    const summary = await runSetlist({
      setlist: loaded.setlist,
      args: parsedCli.data,
      client: cueCaller,
      clock: {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      },
      emit: (e) => lines.push(JSON.stringify(e)),
    });
    return {
      stdout: `${lines.join("\n")}\n${JSON.stringify(summary)}\n`,
      stderr: "",
      code: summary.ended_reason === "complete" ? 0 : 1,
    };
  }

  // `schedule <file>` — scene scheduler (at/every/cron triggers → command|cue|setlist).
  if (positionals[0] === "schedule") {
    const file = positionals[1];
    if (!file) {
      return { stdout: "", stderr: 'Missing schedule path for "schedule <file>".\n', code: 2 };
    }
    const loaded = loadScheduleFile(file);
    if (!loaded.ok) {
      return { stdout: "", stderr: `error: ${loaded.message}\n`, code: 2 };
    }
    const parsedCli = schedulerCliSchema.safeParse({
      file,
      dry_run: values["dry-run"] === true,
      once: values.once === true,
      loop: values.loop === true,
      tz_info: values["tz-info"] === true,
      comp_path: typeof values["comp-path"] === "string" ? values["comp-path"] : undefined,
      json: values.output === "json",
    });
    if (!parsedCli.success) {
      return {
        stdout: "",
        stderr: `Invalid schedule args: ${parsedCli.error.message}\n`,
        code: 2,
      };
    }
    if (parsedCli.data.tz_info) {
      const lines = tzInfo(loaded.schedule, new Date());
      return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
    }
    let ctx: ToolContext;
    try {
      ctx = buildCtx(opts, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    const { manageCueImpl } = await import("../tools/layer2/manageCue.js");
    const { runSetlist: runSetlistImpl } = await import("./setlistRunner.js");
    const { spawn } = await import("node:child_process");
    const dryRun = parsedCli.data.dry_run;
    const compPath = parsedCli.data.comp_path;
    const runner = {
      async command(a: { cmd: string; args: string[]; timeout_ms: number }): Promise<void> {
        if (dryRun) return;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(a.cmd, a.args, { stdio: "ignore" });
          const t = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`command "${a.cmd}" timed out after ${a.timeout_ms}ms`));
          }, a.timeout_ms);
          child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
          });
          child.on("exit", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(`command "${a.cmd}" exited with code ${code}`));
          });
        });
      },
      async cue(a: {
        cue_action: "store" | "recall" | "morph" | "delete";
        name: string;
        duration?: number;
        quantize: "off" | "beat" | "bar";
      }): Promise<void> {
        if (dryRun) return;
        const res = await manageCueImpl(ctx, {
          action: a.cue_action,
          comp_path: compPath,
          name: a.name,
          duration: a.duration ?? 0,
          quantize: a.quantize,
        });
        if (res.isError) {
          const text = res.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")
            .trim();
          throw new Error(text || `manage_cue ${a.cue_action} failed`);
        }
      },
      async setlist(a: {
        file: string;
        mode: "duration" | "beat" | "manual";
        loop: boolean;
      }): Promise<void> {
        if (dryRun) return;
        let raw: string;
        try {
          raw = readFileSync(a.file, "utf8");
        } catch (err) {
          throw new Error(`could not read setlist: ${(err as Error).message}`);
        }
        const parsedInput = parseSetlistInput(raw, a.file);
        if (!parsedInput.ok) throw new Error(parsedInput.message);
        const loadedSetlist = loadCanonicalSetlist(parsedInput.input);
        if (!loadedSetlist.ok) throw new Error(loadedSetlist.message);
        const cueCaller: CueCaller = {
          async fire(call) {
            const res = await manageCueImpl(ctx, {
              action: call.action,
              comp_path: call.comp_path,
              name: call.name,
              duration: call.duration,
              quantize: call.quantize,
            });
            if (res.isError) {
              const text = res.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("")
                .trim();
              throw new Error(text || `manage_cue ${call.action} failed`);
            }
          },
        };
        await runSetlistImpl({
          setlist: loadedSetlist.setlist,
          args: {
            setlist: a.file,
            mode: a.mode,
            loop: a.loop,
            comp_path: compPath,
            dry_run: false,
            json: false,
            beats_per_bar: 4,
            quantize: "off",
          },
          client: cueCaller,
          clock: {
            setTimeout: (cb, ms) => setTimeout(cb, ms),
            clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
            now: () => Date.now(),
          },
          emit: () => {},
        });
      },
    };
    const lines: string[] = [];
    const summary = await runScheduler({
      schedule: loaded.schedule,
      args: parsedCli.data,
      runner,
      clock: realClock,
      emit: (e) => lines.push(JSON.stringify(e)),
    });
    return {
      stdout: `${lines.join("\n")}\n${JSON.stringify(summary)}\n`,
      stderr: "",
      code: summary.ended_reason === "complete" || summary.ended_reason === "once" ? 0 : 1,
    };
  }

  const resolved = resolveCommand(positionals);
  if (!resolved) {
    const guess = nearestCommand(positionals[0] ?? "");
    const hint = guess ? ` Did you mean "${guess}"?` : "";
    return {
      stdout: "",
      stderr: `Unknown command: "${positionals.join(" ")}".${hint} Run with --help.\n`,
      code: 2,
    };
  }
  const { key, cmd } = resolved;

  const assembled = assembleParams(values, opts);
  if ("error" in assembled) {
    return { stdout: "", stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`, code: 2 };
  }
  const raw = assembled.raw;

  const args = cmd.schema.safeParse(raw);
  if (!args.success) {
    return {
      stdout: "",
      stderr: `Invalid arguments for "${key}": ${args.error.message}\n`,
      code: 2,
    };
  }

  if (values["dry-run"]) {
    const doc = {
      dryRun: true,
      command: key,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      args: args.data,
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  let ctx: ToolContext;
  try {
    ctx = buildCtx(opts, cliLoadOptions(values));
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }

  if (cmd.unsafe) {
    if (ctx.allowRawPython === false) {
      return { stdout: "", stderr: `"${key}" is disabled (TDMCP_RAW_PYTHON=off).\n`, code: 2 };
    }
    if (!values["allow-unsafe"]) {
      return {
        stdout: "",
        stderr: `"${key}" is an escape hatch. Re-run with --allow-unsafe to execute.\n`,
        code: 2,
      };
    }
  }

  const result = await cmd.run(ctx, args.data);
  // -q/--quiet keeps stdout=data and silences the friendly stderr summary (for pipelines/CI).
  const summary = values.quiet ? "" : (textOf(result).split("\n")[0] ?? "");
  if (result.isError) {
    // Exit-code taxonomy: distinguish "TD unreachable" (3) from "TD reached but
    // the op failed" (4) so callers can branch without scraping stderr.
    const errText = textOf(result);
    return { stdout: "", stderr: `${errText}\n`, code: classifyTdErrorExit(errText) };
  }

  const output = String(values.output);
  const data = extractData(result);
  if (output === "text") return { stdout: `${textOf(result)}\n`, stderr: "", code: 0 };
  if (output === "ndjson") {
    const arr = firstArray(data);
    const body = arr ? arr.map((item) => JSON.stringify(item)).join("\n") : JSON.stringify(data);
    return { stdout: `${body}\n`, stderr: summary ? `${summary}\n` : "", code: 0 };
  }
  if (output === "table") {
    return { stdout: `${formatTable(data)}\n`, stderr: summary ? `${summary}\n` : "", code: 0 };
  }
  if (output === "csv") {
    return { stdout: `${formatCsv(data)}\n`, stderr: summary ? `${summary}\n` : "", code: 0 };
  }
  return {
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: summary ? `${summary}\n` : "",
    code: 0,
  };
}

export interface RunWatchOptions {
  config?: TdmcpConfig;
  includeHighFrequency?: boolean;
  /** Only emit events whose `type` is in this list (e.g. ["beat","onset"]). */
  filter?: string[];
  /** Drop events whose `type` is in this list (e.g. ["timeline.frame"]). */
  exclude?: string[];
  /** Only run `exec` for matching event names; defaults to `filter` when unset. */
  execOn?: string[];
  /** Shell command to run for each matching event. */
  exec?: string;
  /** Minimum gap between exec runs for the same event name. */
  execDebounceMs?: number;
  /** Periodically report how many events have passed the watch filters. */
  heartbeatMs?: number;
  /** Inject command execution for tests. */
  execCommand?: (command: string, event: unknown) => void;
  /** Inject time for debounce tests. */
  now?: () => number;
  /** Render compact event labels instead of raw ndjson. */
  pretty?: boolean;
  /** Where each event line goes; defaults to stdout. Overridable for tests. */
  write?: (line: string) => void;
  /** Where lifecycle/status lines go; defaults to stderr. Overridable for tests. */
  writeStatus?: (line: string) => void;
  /** Inject a stream factory for tests; defaults to a real `TdEventStream`. */
  makeStream?: (args: { url: string; onEvent: TdEventHandler; includeHighFrequency: boolean }) => {
    start: () => void;
    close: () => void;
  };
  /** Resolve the returned promise when aborted; defaults to listening for SIGINT. */
  signal?: AbortSignal;
}

function eventName(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as { type?: unknown; event?: unknown };
  if (typeof candidate.type === "string") return candidate.type;
  if (typeof candidate.event === "string") return candidate.event;
  return undefined;
}

function prettyEventLine(event: unknown): string {
  const name = eventName(event) ?? "event";
  if (event && typeof event === "object" && "data" in event) {
    const data = (event as { data?: unknown }).data;
    return data === undefined ? name : `${name} ${rowValue(data)}`;
  }
  return `${name} ${rowValue(event)}`.trimEnd();
}

function defaultExecCommand(command: string, event: unknown): void {
  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      TDMCP_EVENT: eventName(event) ?? "",
      TDMCP_EVENT_JSON: JSON.stringify(event),
    },
  });
  child.on("error", (err) => {
    process.stderr.write(`watch --exec failed: ${String(err)}\n`);
  });
}

/**
 * Streams TouchDesigner bridge events to stdout as ndjson until interrupted.
 * Runs outside `runCli` because it is a long-lived stream, not a request/response.
 */
export function runWatch(opts: RunWatchOptions = {}): Promise<void> {
  const config = opts.config ?? loadConfig(process.env, { useFiles: true });
  const url = `${tdBaseUrl(config).replace(/^http/, "ws")}/`;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStatus = opts.writeStatus ?? ((line: string) => process.stderr.write(`${line}\n`));
  const includeHighFrequency = opts.includeHighFrequency ?? false;
  const filter = opts.filter?.length ? opts.filter : undefined;
  const exclude = opts.exclude?.length ? opts.exclude : undefined;
  const execOn = opts.execOn?.length ? opts.execOn : filter;
  const exec = opts.exec;
  const execCommand = opts.execCommand ?? defaultExecCommand;
  const execDebounceMs = Math.max(0, opts.execDebounceMs ?? 0);
  const heartbeatMs = opts.heartbeatMs !== undefined ? Math.max(0, opts.heartbeatMs) : undefined;
  const lastExecByEvent = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  let count = 0;
  const onEvent: TdEventHandler = (event) => {
    const type = eventName(event);
    if (filter && (type === undefined || !filter.includes(type))) return;
    if (exclude && type !== undefined && exclude.includes(type)) return;
    count += 1;
    write(opts.pretty ? prettyEventLine(event) : JSON.stringify(event));
    if (!exec) return;
    if (execOn && (type === undefined || !execOn.includes(type))) return;
    const key = type ?? "*";
    const timestamp = now();
    const last = lastExecByEvent.get(key);
    if (last !== undefined && timestamp - last < execDebounceMs) return;
    lastExecByEvent.set(key, timestamp);
    execCommand(exec, event);
  };
  const stream = opts.makeStream
    ? opts.makeStream({ url, onEvent, includeHighFrequency })
    : new TdEventStream({ url, onEvent, includeHighFrequency });
  stream.start();
  writeStatus(`Watching ${url} for TouchDesigner events (Ctrl-C to stop).`);
  const heartbeat =
    heartbeatMs && heartbeatMs > 0
      ? setInterval(() => {
          writeStatus(`Heartbeat: ${count} event${count === 1 ? "" : "s"}.`);
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref?.();
  return new Promise<void>((resolveDone) => {
    const stop = () => {
      stream.close();
      if (heartbeat) clearInterval(heartbeat);
      writeStatus(`Stopped after ${count} event${count === 1 ? "" : "s"}.`);
      resolveDone();
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}

/** Splits a REPL line into argv, respecting single/double quotes (so JSON --params works). */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
    m = re.exec(line);
  }
  return tokens;
}

/** Interactive read-eval-print loop: each line is tokenized and run through runCli. */
export async function runRepl(opts: RunCliOptions = {}): Promise<void> {
  const historyPath = replHistoryPath();
  const history = loadReplHistory(historyPath);
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    completer: completeReplLine,
    historySize: 1000,
  }) as ReturnType<typeof createInterface> & { history: string[] };
  rl.history = [...history].reverse();
  process.stderr.write(
    "tdmcp REPL — enter a command (e.g. `info`, `nodes list`); `help` for commands, `exit` to quit.\n> ",
  );
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "help") {
      process.stdout.write(`${usage()}\n`);
    } else if (trimmed) {
      const result = await runCli(tokenizeLine(trimmed), opts);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.stderr.write("> ");
  }
  saveReplHistory([...rl.history].reverse(), historyPath);
  rl.close();
}

/** Pull a `--name value` (or `--name=value`) string out of a raw argv list. */
function rawFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Split a comma-separated flag value into a trimmed list, or undefined if absent/empty. */
function csvFlag(argv: string[], name: string): string[] | undefined {
  const raw = rawFlag(argv, name);
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = rawFlag(argv, name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  // `watch-build` (dev-loop tsc/tsup watcher) and `soundcheck-monitor` (long-running
  // audio-features poller) bypass runCli's request/response model. Campaign BEYOND Wave 4.
  if (argv[0] === "watch-build" && !wantsHelp) {
    process.exitCode = await runBridgeWatchBuild(argv.slice(1));
    return;
  }
  if (argv[0] === "soundcheck-monitor" && !wantsHelp) {
    const raw = assembleParams(parseCliArgs(argv).values);
    if ("error" in raw) {
      process.stderr.write(`Invalid soundcheck-monitor params: ${raw.error}\n`);
      process.exitCode = 2;
      return;
    }
    const parsed = soundcheckMonitorSchema.safeParse(raw.raw);
    if (!parsed.success) {
      process.stderr.write(`Invalid soundcheck-monitor params: ${parsed.error.message}\n`);
      process.exitCode = 2;
      return;
    }
    let ctx: ToolContext;
    try {
      ctx = buildToolContext(loadConfig(process.env, { useFiles: true }), {
        logger: silentLogger,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    try {
      await runSoundcheckMonitor(ctx, parsed.data, ac.signal);
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  // Long-running CLI streamers (wave-5 follow-up). Each owns its own argv parsing.
  if (argv[0] === "log-tail" && !wantsHelp) {
    process.exitCode = await runLogTailFiltered(argv.slice(1));
    return;
  }
  if (argv[0] === "record-fixtures" && !wantsHelp) {
    try {
      await runFixtureRecorder(argv.slice(1));
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (argv[0] === "fanout" && !wantsHelp) {
    process.exitCode = await runRemoteFanout(argv.slice(1));
    return;
  }
  if (argv[0] === "controller-bridge" && !wantsHelp) {
    const raw = assembleParams(parseCliArgs(argv).values);
    if ("error" in raw) {
      process.stderr.write(`Invalid controller-bridge params: ${raw.error}\n`);
      process.exitCode = 2;
      return;
    }
    const parsed = controllerBridgeCliSchema.safeParse(raw.raw);
    if (!parsed.success) {
      process.stderr.write(`Invalid controller-bridge params: ${parsed.error.message}\n`);
      process.exitCode = 2;
      return;
    }
    let ctx: ToolContext;
    try {
      ctx = buildToolContext(loadConfig(process.env, { useFiles: true }), {
        logger: silentLogger,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const summary = await runControllerBridge(ctx, parsed.data);
      process.exitCode = summary.exit_code;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if ((argv[0] === "voice" || argv[0] === "llm-voice") && !wantsHelp) {
    try {
      await runVoiceCopilotChat(argv.slice(1));
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  // `watch` (a long-lived stream) and `repl` (interactive) bypass runCli's request/response model.
  if (argv[0] === "watch" && !wantsHelp) {
    const on = csvFlag(argv, "on");
    await runWatch({
      includeHighFrequency: argv.includes("--include-high-frequency"),
      filter: csvFlag(argv, "filter") ?? on,
      exclude: csvFlag(argv, "exclude"),
      pretty: argv.includes("--pretty"),
      execOn: on,
      exec: rawFlag(argv, "exec"),
      execDebounceMs: numberFlag(argv, "debounce-ms"),
      heartbeatMs: numberFlag(argv, "heartbeat-ms"),
    });
    return;
  }
  if (argv[0] === "repl" && !wantsHelp) {
    await runRepl();
    return;
  }
  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main();
