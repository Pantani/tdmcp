import type { ToolRegistrar } from "../types.js";
import { registerApplyPostProcessing } from "./applyPostProcessing.js";
import { registerApplyRecipe } from "./applyRecipe.js";
import { registerCreate3dAudioReactive } from "./create3dAudioReactive.js";
import { registerCreate3dScene } from "./create3dScene.js";
import { registerCreateAudioReactive } from "./createAudioReactive.js";
import { registerCreateAutopilot } from "./createAutopilot.js";
import { registerCreateBodyReactive } from "./createBodyReactive.js";
import { registerCreateColorGrade } from "./createColorGrade.js";
import { registerCreateDataVisualization } from "./createDataVisualization.js";
import { registerCreateDepthDisplacement } from "./createDepthDisplacement.js";
import { registerCreateDepthSilhouette } from "./createDepthSilhouette.js";
import { registerCreateDomeOutput } from "./createDomeOutput.js";
import { registerCreateFeedbackNetwork } from "./createFeedbackNetwork.js";
import { registerCreateGenerativeArt } from "./createGenerativeArt.js";
import { registerCreateGlitch } from "./createGlitch.js";
import { registerCreateGpuParticleField } from "./createGpuParticleField.js";
import { registerCreateKaleidoscope } from "./createKaleidoscope.js";
import { registerCreateKeyframeAnimation } from "./createKeyframeAnimation.js";
import { registerCreateKineticText } from "./createKineticText.js";
import { registerCreateLayerMixer } from "./createLayerMixer.js";
import { registerCreateMeshWarp } from "./createMeshWarp.js";
import { registerCreateMotionReactive } from "./createMotionReactive.js";
import { registerCreateMultiOutput } from "./createMultiOutput.js";
import { registerCreateParticleSystem } from "./createParticleSystem.js";
import { registerCreatePoseSkeleton } from "./createPoseSkeleton.js";
import { registerCreatePoseTracking } from "./createPoseTracking.js";
import { registerCreateProjectionMapping } from "./createProjectionMapping.js";
import { registerCreateShaderLib } from "./createShaderLib.js";
import { registerCreateSimulation } from "./createSimulation.js";
import { registerCreateSpectrum } from "./createSpectrum.js";
import { registerCreateStrobe } from "./createStrobe.js";
import { registerCreateSyncExternalClock } from "./createSyncExternalClock.js";
import { registerCreateTempoSync } from "./createTempoSync.js";
import { registerCreateTextOverlay } from "./createTextOverlay.js";
import { registerCreateVideoPlayer } from "./createVideoPlayer.js";
import { registerCreateVideoSynth } from "./createVideoSynth.js";
import { registerCreateVisualSystem } from "./createVisualSystem.js";
import { registerCreateWaveform } from "./createWaveform.js";
import { registerDescribeProject } from "./describeProject.js";
import { registerDetectOnsets } from "./detectOnsets.js";
import { registerDetectPitch } from "./detectPitch.js";
import { registerExtractAudioFeatures } from "./extractAudioFeatures.js";
import { registerGetPreview } from "./getPreview.js";
import { registerImportModel } from "./importModel.js";
import { registerListRecipes } from "./listRecipes.js";
import { registerScaffoldShow } from "./scaffoldShow.js";
import { registerSetupBodyTracking } from "./setupBodyTracking.js";
import { registerSetupOutput } from "./setupOutput.js";

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
  registerCreateMultiOutput,
  registerCreateSyncExternalClock,
  registerCreateTempoSync,
  registerCreateTextOverlay,
  registerCreateAutopilot,
  registerCreateLayerMixer,
  registerCreateVideoPlayer,
  registerCreate3dScene,
  registerCreateProjectionMapping,
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
  registerImportModel,
  registerCreateShaderLib,
  registerCreateVideoSynth,
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
  // Phase 13 — body / pose tracking (MediaPipe-driven, camera-reactive; merged from
  // the parallel build-out):
  registerCreatePoseTracking,
  registerCreatePoseSkeleton,
  registerCreateBodyReactive,
  registerSetupBodyTracking,
];
