import type { LoadedTdmcpConfig } from "../utils/config.js";
import { type CalibrationPolicyResolution, resolveCachedCalibrationPolicy } from "./calibration.js";
import type { ToolTier } from "./tools.js";

export type RuntimeCalibrationConfig = Pick<
  LoadedTdmcpConfig,
  "llmBaseUrl" | "llmModel" | "llmApiKey" | "llmCalibrationMode" | "llmCalibrationCachePath"
>;

/** Resolve one surface's requested tier against the exact cached model build. */
export function resolveRuntimeCalibration(
  config: RuntimeCalibrationConfig,
  requestedTier: ToolTier,
  signal?: AbortSignal,
): Promise<CalibrationPolicyResolution> {
  return resolveCachedCalibrationPolicy({
    endpoint: config.llmBaseUrl,
    model: config.llmModel,
    ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
    requestedTier,
    mode: config.llmCalibrationMode,
    ...(config.llmCalibrationCachePath ? { cachePath: config.llmCalibrationCachePath } : {}),
    signal,
  });
}
