import type { ToolRegistrar } from "../types.js";
import { registerApplyPostProcessing } from "./applyPostProcessing.js";
import { registerApplyRecipe } from "./applyRecipe.js";
import { registerCreate3dScene } from "./create3dScene.js";
import { registerCreateAudioReactive } from "./createAudioReactive.js";
import { registerCreateAutopilot } from "./createAutopilot.js";
import { registerCreateDataVisualization } from "./createDataVisualization.js";
import { registerCreateFeedbackNetwork } from "./createFeedbackNetwork.js";
import { registerCreateGenerativeArt } from "./createGenerativeArt.js";
import { registerCreateKeyframeAnimation } from "./createKeyframeAnimation.js";
import { registerCreateLayerMixer } from "./createLayerMixer.js";
import { registerCreateMotionReactive } from "./createMotionReactive.js";
import { registerCreateMultiOutput } from "./createMultiOutput.js";
import { registerCreateParticleSystem } from "./createParticleSystem.js";
import { registerCreateProjectionMapping } from "./createProjectionMapping.js";
import { registerCreateSimulation } from "./createSimulation.js";
import { registerCreateSyncExternalClock } from "./createSyncExternalClock.js";
import { registerCreateTempoSync } from "./createTempoSync.js";
import { registerCreateTextOverlay } from "./createTextOverlay.js";
import { registerCreateVideoPlayer } from "./createVideoPlayer.js";
import { registerCreateVisualSystem } from "./createVisualSystem.js";
import { registerDescribeProject } from "./describeProject.js";
import { registerExtractAudioFeatures } from "./extractAudioFeatures.js";
import { registerGetPreview } from "./getPreview.js";
import { registerListRecipes } from "./listRecipes.js";
import { registerScaffoldShow } from "./scaffoldShow.js";
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
];
