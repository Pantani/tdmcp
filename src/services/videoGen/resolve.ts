import type { Logger } from "../../utils/logger.js";
import { ComfyuiVideoProvider } from "./comfyuiProvider.js";
import { DEFAULT_FAL_VIDEO_MODEL, FalVideoProvider } from "./falProvider.js";
import type { VideoGenProvider } from "./types.js";

/**
 * Config fields the factory needs. Declared locally (NOT `Pick<TdmcpConfig>`) so
 * this seam file compiles before the integrator adds the `TDMCP_VIDEO_GEN_*`
 * keys to `TdmcpConfig`. The real config is structurally assignable.
 */
export interface VideoGenConfig {
  videoGenProvider: "fal" | "comfyui" | "none";
  videoGenModel?: string;
  falKey?: string;
  comfyuiUrl?: string;
  comfyuiVideoWorkflow?: string;
}

/**
 * Factory for the video provider, mirroring `resolveImageProvider`. Returns
 * `undefined` (feature off) when the provider is `"none"` OR the selected
 * provider's prerequisite (fal key / comfyui workflow) is absent — tools then
 * degrade via `errorResult`, never a throw.
 */
export function resolveVideoProvider(
  config: VideoGenConfig,
  logger: Logger,
): VideoGenProvider | undefined {
  switch (config.videoGenProvider) {
    case "fal": {
      if (!config.falKey) {
        logger.debug(
          "videoGen: provider 'fal' selected but TDMCP_FAL_KEY is not set — video generation disabled",
        );
        return undefined;
      }
      return new FalVideoProvider(config.falKey, {
        defaultModel: config.videoGenModel ?? DEFAULT_FAL_VIDEO_MODEL,
      });
    }
    case "comfyui": {
      if (!config.comfyuiVideoWorkflow) {
        logger.debug(
          "videoGen: provider 'comfyui' selected but TDMCP_COMFYUI_VIDEO_WORKFLOW is not set — video generation disabled",
        );
        return undefined;
      }
      return new ComfyuiVideoProvider(
        config.comfyuiUrl ?? "http://127.0.0.1:8188",
        config.comfyuiVideoWorkflow,
      );
    }
    default:
      return undefined;
  }
}
