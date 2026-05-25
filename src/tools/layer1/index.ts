import type { ToolRegistrar } from "../types.js";
import { registerApplyPostProcessing } from "./applyPostProcessing.js";
import { registerCreateAudioReactive } from "./createAudioReactive.js";
import { registerCreateDataVisualization } from "./createDataVisualization.js";
import { registerCreateFeedbackNetwork } from "./createFeedbackNetwork.js";
import { registerCreateGenerativeArt } from "./createGenerativeArt.js";
import { registerCreateParticleSystem } from "./createParticleSystem.js";
import { registerCreateVisualSystem } from "./createVisualSystem.js";
import { registerDescribeProject } from "./describeProject.js";
import { registerGetPreview } from "./getPreview.js";
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
];
