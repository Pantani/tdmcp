import type { TdmcpConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";
import { DEFAULT_FAL_MODEL, FalProvider } from "./falProvider.js";
import type { ImageProvider } from "./types.js";

/**
 * Factory for the hosted image provider, mirroring `resolveLlmClient`. Returns
 * `undefined` (feature off) when the provider is `"none"` OR the selected
 * provider's key is absent — tools then degrade via `errorResult`, never a throw.
 * `"replicate"` is a P0 seam only (P1 implementation); it logs a debug note and
 * returns `undefined` so the interface stays a one-file add.
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
    case "replicate":
      logger.debug("imageGen: 'replicate' provider is P1 (seam only) — image generation disabled");
      return undefined;
    default:
      return undefined;
  }
}
