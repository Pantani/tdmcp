import type { ToolRegistrar } from "../types.js";
import { registerApplyPostProcessing } from "./applyPostProcessing.js";
import { registerCreateAudioReactive } from "./createAudioReactive.js";
import { registerCreateFeedbackNetwork } from "./createFeedbackNetwork.js";
import { registerCreateGenerativeArt } from "./createGenerativeArt.js";
import { registerCreateParticleSystem } from "./createParticleSystem.js";
import { registerCreateVisualSystem } from "./createVisualSystem.js";
import { registerGetPreview } from "./getPreview.js";
import { registerSetupOutput } from "./setupOutput.js";

export const layer1Registrars: ToolRegistrar[] = [
  registerCreateFeedbackNetwork,
  registerCreateGenerativeArt,
  registerCreateAudioReactive,
  registerCreateParticleSystem,
  registerApplyPostProcessing,
  registerSetupOutput,
  registerGetPreview,
  registerCreateVisualSystem,
];
