import { isRagFeatureFlagEnabled } from "../../utils/config.js";
import type { ToolRegistrar } from "../types.js";
import { registerApplyCreativeCard } from "./applyCreativeCard.js";
import { registerApplyPostProcessing } from "./applyPostProcessing.js";
import { registerApplyRecipe } from "./applyRecipe.js";
import { registerAudioFingerprintToVisual } from "./audioFingerprintToVisual.js";
import { registerBlenderSceneImport } from "./blenderSceneImport.js";
import { registerComposeCueList } from "./composeCueList.js";
import { registerControlledDisorderGrid } from "./controlledDisorderGrid.js";
import { registerCreate3dAudioReactive } from "./create3dAudioReactive.js";
import { registerCreate3dScene } from "./create3dScene.js";
import { registerCreateAiMirror } from "./createAiMirror.js";
import { registerCreateAsciiRender } from "./createAsciiRender.js";
import { registerCreateAsemicWriting } from "./createAsemicWriting.js";
import { registerCreateAudioReactive } from "./createAudioReactive.js";
import { registerCreateAutomationLane } from "./createAutomationLane.js";
import { registerCreateAutopilot } from "./createAutopilot.js";
// Campaign Wave 3 — artist controls (backlog 2026-05-29):
import { registerCreateBlobReactive } from "./createBlobReactive.js";
import { registerCreateBlobTrace } from "./createBlobTrace.js";
import { registerCreateBodyBubbles } from "./createBodyBubbles.js";
import { registerCreateBodyReactive } from "./createBodyReactive.js";
import { registerCreateChopRecorder } from "./createChopRecorder.js";
import { registerCreateChromaReactive } from "./createChromaReactive.js";
import { registerCreateChromeBlobs } from "./createChromeBlobs.js";
import { registerCreateColorGrade } from "./createColorGrade.js";
import { registerCreateColorWheels } from "./createColorWheels.js";
import { registerCreateCubemapDome } from "./createCubemapDome.js";
import { registerCreateDatamosh } from "./createDatamosh.js";
import { registerCreateDataVisualization } from "./createDataVisualization.js";
import { registerCreateDepthDisplacement } from "./createDepthDisplacement.js";
import { registerCreateDepthFromTwoD } from "./createDepthFromTwoD.js";
import { registerCreateDepthPopField } from "./createDepthPopField.js";
import { registerCreateDepthSilhouette } from "./createDepthSilhouette.js";
import { registerCreateDetectionReactive } from "./createDetectionReactive.js";
import { registerCreateDisplacementWarp } from "./createDisplacementWarp.js";
import { registerCreateDither } from "./createDither.js";
import { registerCreateDmxFixturePipeline } from "./createDmxFixturePipeline.js";
import { registerCreateDomeOutput } from "./createDomeOutput.js";
import { registerCreateEnergyStructure } from "./createEnergyStructure.js";
import { registerCreateEngineComp } from "./createEngineComp.js";
import { registerCreateFacadeMapping } from "./createFacadeMapping.js";
import { registerCreateFeedbackNetwork } from "./createFeedbackNetwork.js";
import { registerCreateFeedbackTunnel } from "./createFeedbackTunnel.js";
import { registerCreateFixtureControl } from "./createFixtureControl.js";
import { registerCreateFluidSim } from "./createFluidSim.js";
import { registerCreateGaussianSplatScene } from "./createGaussianSplatScene.js";
import { registerCreateGenerativeArt } from "./createGenerativeArt.js";
import { registerCreateGenerativeAudio } from "./createGenerativeAudio.js";
import { registerCreateGeoVisualization } from "./createGeoVisualization.js";
import { registerCreateGlitch } from "./createGlitch.js";
import { registerCreateGpuParticleField } from "./createGpuParticleField.js";
import { registerCreateGrowthSystem } from "./createGrowthSystem.js";
import { registerCreateHalftone } from "./createHalftone.js";
import { registerCreateHandHologram } from "./createHandHologram.js";
import { registerCreateHistogramScope } from "./createHistogramScope.js";
import { registerCreateImageToParticles } from "./createImageToParticles.js";
import { registerCreateInteractionZones } from "./createInteractionZones.js";
import { registerCreateInteractiveProjectionMapping } from "./createInteractiveProjectionMapping.js";
import { registerCreateIphoneDepthSource } from "./createIphoneDepthSource.js";
import { registerCreateJfaVoronoi } from "./createJfaVoronoi.js";
import { registerCreateKaleidoscope } from "./createKaleidoscope.js";
import { registerCreateKeyer } from "./createKeyer.js";
import { registerCreateKeyframeAnimation } from "./createKeyframeAnimation.js";
import { registerCreateKinectWallHarp } from "./createKinectWallHarp.js";
import { registerCreateKineticText } from "./createKineticText.js";
import { registerCreateLayerMixer } from "./createLayerMixer.js";
import { registerCreateLayerStack } from "./createLayerStack.js";
import { registerCreateLiveSource } from "./createLiveSource.js";
import { registerCreateMediaBin } from "./createMediaBin.js";
import { registerCreateMeshWarp } from "./createMeshWarp.js";
import { registerCreateMidiNoteReactive } from "./createMidiNoteReactive.js";
import { registerCreateMotionReactive } from "./createMotionReactive.js";
import { registerCreateMultiOutput } from "./createMultiOutput.js";
import { registerMultipass3dDepth } from "./createMultipass3dDepth.js";
import { registerCreateNuitrackBodyBus } from "./createNuitrackBodyBus.js";
import { registerCreateOpticalFlow } from "./createOpticalFlow.js";
import { registerCreateOrbbecDepthSilhouette } from "./createOrbbecDepthSilhouette.js";
import { registerCreateParticleFlock } from "./createParticleFlock.js";
import { registerCreateParticleSystem } from "./createParticleSystem.js";
import { registerCreatePbrScene } from "./createPbrScene.js";
import { registerCreatePhoneGesture } from "./createPhoneGesture.js";
import { registerCreatePhraseLockedCueEngine } from "./createPhraseLockedCueEngine.js";
import { registerCreatePixelSort } from "./createPixelSort.js";
import { registerCreatePointCloud } from "./createPointCloud.js";
import { registerCreatePointerReactive } from "./createPointerReactive.js";
import { registerCreatePopField } from "./createPopField.js";
import { registerCreatePopGeometry } from "./createPopGeometry.js";
import { registerCreatePopGrowth } from "./createPopGrowth.js";
import { registerCreatePopLinesPointcloud } from "./createPopLinesPointcloud.js";
import { registerCreatePopParticleSystem } from "./createPopParticleSystem.js";
import { registerCreatePoseControlnetDriver } from "./createPoseControlnetDriver.js";
import { registerCreatePoseReactive } from "./createPoseReactive.js";
import { registerCreatePoseSkeleton } from "./createPoseSkeleton.js";
import { registerCreatePoseTracking } from "./createPoseTracking.js";
import { registerCreateProbSequencer } from "./createProbSequencer.js";
import { registerCreateProjectionMapping } from "./createProjectionMapping.js";
import { registerCreateRaymarchScene } from "./createRaymarchScene.js";
import { registerCreateRaytkScene } from "./createRaytkScene.js";
import { registerCreateRaytkSdfGraph } from "./createRaytkSdfGraph.js";
import { registerCreateReactionDiffusion } from "./createReactionDiffusion.js";
import { registerCreateSafetyBlackoutChain } from "./createSafetyBlackoutChain.js";
import { registerCreateSam2SegmentationBridge } from "./createSam2SegmentationBridge.js";
import { registerCreateSdfField } from "./createSdfField.js";
import { registerCreateSdfText } from "./createSdfText.js";
import { registerCreateSetlistRunner } from "./createSetlistRunner.js";
import { registerCreateSetNavigator } from "./createSetNavigator.js";
import { registerCreateShaderLib } from "./createShaderLib.js";
import { registerCreateShaderPark } from "./createShaderPark.js";
import { registerCreateShowFailover } from "./createShowFailover.js";
import { registerCreateSimulation } from "./createSimulation.js";
import { registerCreateSlitScan } from "./createSlitScan.js";
import { registerCreateSpectrum } from "./createSpectrum.js";
import { registerCreateStepRepeat } from "./createStepRepeat.js";
import { registerCreateStipplePointcloud } from "./createStipplePointcloud.js";
import { registerCreateStrangeAttractor } from "./createStrangeAttractor.js";
import { registerCreateStrobe } from "./createStrobe.js";
import { registerCreateSyncExternalClock } from "./createSyncExternalClock.js";
import { registerCreateTempoSync } from "./createTempoSync.js";
import { registerCreateTerrain } from "./createTerrain.js";
import { registerCreateTestPattern } from "./createTestPattern.js";
import { registerCreateText3d } from "./createText3d.js";
import { registerCreateTextCrawl } from "./createTextCrawl.js";
import { registerCreateTextOverlay } from "./createTextOverlay.js";
import { registerCreateTransientReactive } from "./createTransientReactive.js";
import { registerCreateTransition } from "./createTransition.js";
import { registerCreateTwoWaySurface } from "./createTwoWaySurface.js";
import { registerCreateVectorLines } from "./createVectorLines.js";
import { registerCreateVertexDisplacementMat } from "./createVertexDisplacementMat.js";
import { registerCreateVideoPlayer } from "./createVideoPlayer.js";
import { registerCreateVideoScopes } from "./createVideoScopes.js";
import { registerCreateVideoSynth } from "./createVideoSynth.js";
import { registerCreateVintageLens } from "./createVintageLens.js";
import { registerCreateVisualSystem } from "./createVisualSystem.js";
import { registerCreateVolumetricField } from "./createVolumetricField.js";
import { registerCreateVoxelStack } from "./createVoxelStack.js";
import { registerCreateWaveform } from "./createWaveform.js";
import { registerCreateYoloOnnxTracker } from "./createYoloOnnxTracker.js";
import { registerDescribeProject } from "./describeProject.js";
import { registerDetectOnsets } from "./detectOnsets.js";
import { registerDetectPitch } from "./detectPitch.js";
import { registerDetectTempo } from "./detectTempo.js";
import { registerDriveStreamdiffusion } from "./driveStreamdiffusion.js";
import { registerEnhanceBuild } from "./enhanceBuild.js";
import { registerExtractAudioFeatures } from "./extractAudioFeatures.js";
import { registerGetPreview } from "./getPreview.js";
import { registerImportIsfShader } from "./importIsfShader.js";
import { registerImportModel } from "./importModel.js";
import { registerImportShadertoy } from "./importShadertoy.js";
import { registerLidarFloorTracker } from "./lidarFloorTracker.js";
import { registerListRecipes } from "./listRecipes.js";
import { registerMoodboardToSystem } from "./moodboardToSystem.js";
import { registerProjectorCalibrationWizard } from "./projectorCalibrationWizard.js";
import { registerRaytkExprGraphBuilder } from "./raytkExprGraphBuilder.js";
import { registerScaffoldGenre } from "./scaffoldGenre.js";
import { registerScaffoldShow } from "./scaffoldShow.js";
import { registerSetupBodyTracking } from "./setupBodyTracking.js";
import { registerSetupMediapipePlugin } from "./setupMediapipePlugin.js";
import { registerSetupOutput } from "./setupOutput.js";
import { registerSetupTdableton } from "./setupTdableton.js";

export const layer1Registrars: ToolRegistrar[] = [
  registerCreateFeedbackNetwork,
  registerCreateGenerativeArt,
  registerCreateAudioReactive,
  registerCreateParticleSystem,
  registerCreateDataVisualization,
  registerApplyPostProcessing,
  registerSetupOutput,
  registerGetPreview,
  registerDescribeProject,
  registerCreateVisualSystem,
  registerExtractAudioFeatures,
  registerCreateMotionReactive,
  registerCreateInteractiveProjectionMapping,
  registerCreateKinectWallHarp,
  registerCreateMultiOutput,
  registerCreateSyncExternalClock,
  registerCreateTempoSync,
  registerCreateTextOverlay,
  registerCreateAutopilot,
  registerCreateLayerMixer,
  registerCreateVideoPlayer,
  registerCreate3dScene,
  registerCreateProjectionMapping,
  registerProjectorCalibrationWizard,
  registerCreateKeyframeAnimation,
  registerCreateSimulation,
  registerListRecipes,
  registerApplyRecipe,
  registerScaffoldShow,
  // Waves 1–5 — signature effects, deeper reactivity, creation:
  registerCreateStrobe,
  registerCreateKaleidoscope,
  registerCreateGlitch,
  registerCreateSpectrum,
  registerDetectOnsets,
  registerCreateColorGrade,
  registerCreateColorWheels,
  registerImportModel,
  registerBlenderSceneImport,
  registerCreateShaderLib,
  registerCreateShaderPark,
  registerCreateVideoSynth,
  registerCreateDetectionReactive,
  registerCreateFixtureControl,
  registerCreateGeoVisualization,
  registerCreateDepthSilhouette,
  registerCreateKineticText,
  registerCreateWaveform,
  registerDetectPitch,
  // Phase 12 — dimensional (3D, depth & spatial mapping):
  registerCreate3dAudioReactive,
  registerCreateDomeOutput,
  registerCreateMeshWarp,
  registerCreateDepthDisplacement,
  registerCreateGpuParticleField,
  // Post-0.3.0 parallel build — wave 1:
  registerCreateRaymarchScene,
  // RayTK integration (Wave W4) — native RayTK node-graph scene (complement to the GLSL one):
  registerCreateRaytkScene,
  // External-integration Wave 1 (2026-07-09): deeper RayTK graph, iPhone depth, AI masks.
  registerCreateRaytkSdfGraph,
  registerCreateIphoneDepthSource,
  registerCreateSam2SegmentationBridge,
  // External-integration Wave 2 (2026-07-09): vision and depth sensor scaffolds.
  registerCreateYoloOnnxTracker,
  registerCreateNuitrackBodyBus,
  registerCreateOrbbecDepthSilhouette,
  // Tool-integration Wave 7 — RayTK expression graph builder:
  registerRaytkExprGraphBuilder,
  registerDetectTempo,
  // Post-0.3.0 parallel build — wave 2:
  registerCreatePbrScene,
  registerCreateParticleFlock,
  registerCreatePointCloud,
  registerCreateGenerativeAudio,
  // Post-0.3.0 parallel build — wave 3:
  registerCreateCubemapDome,
  registerScaffoldGenre,
  // Body / pose tracking (MediaPipe-driven, camera-reactive performance):
  registerCreatePoseTracking,
  registerCreatePoseSkeleton,
  registerCreateBodyBubbles,
  registerCreateBodyReactive,
  registerCreateHandHologram,
  registerSetupBodyTracking,
  // Phase 14 — live mixing & external content (v0.5.0):
  registerCreateTransition,
  registerCreateLiveSource,
  registerCreateLayerStack,
  registerCreateMediaBin,
  registerCreateKeyer,
  // Phase 14 — signature effects + multipass 3D:
  registerCreateDatamosh,
  registerCreateDisplacementWarp,
  registerCreateHalftone,
  registerCreateVectorLines,
  registerCreateFeedbackTunnel,
  registerMultipass3dDepth,
  // Phase 15 — set navigation + POP (experimental, live-validation pending):
  registerCreateSetNavigator,
  registerCreatePopField,
  registerCreatePopGeometry,
  // Phase 15 — 3D text + MIDI note reactivity (device path held pending hardware):
  registerCreateText3d,
  registerCreateMidiNoteReactive,
  // Campaign Wave 3 — artist controls (backlog 2026-05-29):
  registerCreateTestPattern,
  registerCreateTextCrawl,
  registerCreateBlobReactive,
  // Campaign Wave 2 — composition/scheduling/reactivity/interaction (v0.8.0):
  registerComposeCueList,
  registerEnhanceBuild,
  registerCreateProbSequencer,
  registerCreateTwoWaySurface,
  registerCreateAutomationLane,
  registerCreateChromaReactive,
  registerCreateTransientReactive,
  registerCreateEnergyStructure,
  registerCreatePhoneGesture,
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerMoodboardToSystem,
  registerAudioFingerprintToVisual,
  // Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
  registerCreateEngineComp,
  registerCreateDmxFixturePipeline,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerCreateGrowthSystem,
  // Campaign ingest-extend Wave 1 (2026-05-31): shader ingest + new looks:
  registerImportShadertoy,
  registerImportIsfShader,
  registerCreateFluidSim,
  registerCreateImageToParticles,
  registerCreateDither,
  registerCreateJfaVoronoi,
  // Campaign ingest-extend Wave 2 (2026-05-31): live integrations + scopes + recording:
  registerSetupTdableton,
  registerCreateChopRecorder,
  registerCreateVideoScopes,
  // New wave: SDF/strange-attractor/optical-flow/histogram-scope:
  registerCreateSdfField,
  registerCreateStrangeAttractor,
  registerCreateOpticalFlow,
  registerCreateHistogramScope,
  // Wave 2026-06-02 — safety, setlist, failover, pose reactivity:
  registerCreateSafetyBlackoutChain,
  registerCreateSetlistRunner,
  registerCreateShowFailover,
  registerCreatePoseReactive,
  // Hype-scout Round 4 Wave 2 (2026-06-09):
  registerCreatePoseControlnetDriver,
  registerCreateAsciiRender,
  registerCreatePhraseLockedCueEngine,
  // Hype-scout Round 4 Wave 3 (2026-06-09) — POP combos:
  registerCreatePopParticleSystem,
  registerCreatePopGrowth,
  registerCreatePopLinesPointcloud,
  registerCreateDepthPopField,
  registerCreateStipplePointcloud,
  // Hype-scout Round 4 Wave 4 (2026-06-09) — AI bridges:
  registerDriveStreamdiffusion,
  registerSetupMediapipePlugin,
  registerCreateDepthFromTwoD,
  registerCreateGaussianSplatScene,
  registerCreateAiMirror,
  // Hype-scout Round 4 Wave 5 (2026-06-09) — VFX aesthetic tail:
  registerCreateSlitScan,
  registerCreateChromeBlobs,
  registerCreateVintageLens,
  registerCreateReactionDiffusion,
  registerCreatePixelSort,
  registerCreateVolumetricField,
  registerCreateVoxelStack,
  registerCreateFacadeMapping,
  // Roadmap-to-1.0 Wave 3 (2026-07-06) — stock-TD artist/interaction tools:
  registerCreateStepRepeat,
  registerCreatePointerReactive,
  registerCreateInteractionZones,
  registerLidarFloorTracker,
  // Roadmap-to-1.0 Wave 4 (2026-07-06) — stock-TD generators:
  registerCreateTerrain,
  registerCreateAsemicWriting,
  registerCreateSdfText,
  registerCreateVertexDisplacementMat,
  registerControlledDisorderGrid,
  registerCreateBlobTrace,
];

// v0.6.0 — Creative RAG inspiration -> execution loop (gated behind env flag).
//
// Exception to the "all env vars parsed in src/utils/config.ts" rule: tool
// registration runs before the parsed config object is built, so the layer index
// has no `ctx` to pull from. Keep the env check here but route the "enabled"
// decision through the shared config helper to avoid drift.
if (isRagFeatureFlagEnabled(process.env.TDMCP_RAG_APPLY_CARD)) {
  layer1Registrars.push(registerApplyCreativeCard);
}
