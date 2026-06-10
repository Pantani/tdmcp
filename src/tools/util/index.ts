import type { ToolRegistrar } from "../types.js";

export type {
  DropExternalToxOk,
  DropExternalToxOptions,
  DropExternalToxResult,
} from "./dropExternalTox.js";
export { dropExternalTox } from "./dropExternalTox.js";
export type { ToxCandidatePrecheckResult } from "./toxCandidatePrecheck.js";
export { precheckToxCandidates } from "./toxCandidatePrecheck.js";

/**
 * Utility helpers for cross-cutting substrate concerns (external-asset loading,
 * path resolution, etc.). No tools are registered from this group today; the
 * empty array is intentional so the integrator can wire the spread into
 * `src/tools/index.ts` and any future registered util tool becomes a one-line
 * addition here.
 */
export const utilRegistrars: ToolRegistrar[] = [];
