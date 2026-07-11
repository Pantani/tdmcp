import type { TdmcpConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";
import { DEFAULT_FAL_MODEL, FalProvider } from "./falProvider.js";
import { DEFAULT_REPLICATE_MODEL, ReplicateProvider } from "./replicateProvider.js";
import type { ImageProvider } from "./types.js";

/**
 * Factory for the hosted image provider, mirroring `resolveLlmClient`. Returns
 * `undefined` (feature off) when the provider is `"none"` OR the selected
 * provider's key is absent — tools then degrade via `errorResult`, never a throw.
 * Both `"fal"` and `"replicate"` are implemented; each branches on its own key.
 */
export function resolveImageProvider(
  config: Pick<TdmcpConfig, "imageGenProvider" | "falKey" | "replicateKey" | "imageGenModel">,
  logger: Logger,
): ImageProvider | undefined {
  switch (config.imageGenProvider) {
    case "fal": {
      if (!config.falKey) {
        logger.debug(
          "imageGen: provider 'fal' selected but TDMCP_FAL_KEY is not set — image generation disabled",
        );
        return undefined;
      }
      return new FalProvider(config.falKey, {
        defaultModel: config.imageGenModel ?? DEFAULT_FAL_MODEL,
      });
    }
    case "replicate": {
      if (!config.replicateKey) {
        logger.debug(
          "imageGen: provider 'replicate' selected but TDMCP_REPLICATE_KEY is not set — image generation disabled",
        );
        return undefined;
      }
      return new ReplicateProvider(config.replicateKey, {
        defaultModel: config.imageGenModel ?? DEFAULT_REPLICATE_MODEL,
      });
    }
    default:
      return undefined;
  }
}
