/**
 * Project RAG — public barrel.
 *
 * Re-exports the surface the integrator wires into `src/index.ts` (CLI + config
 * mapper), the server context (`createProjectRagService`), the index store
 * (`ProjectJsonlIndexStore`), and the shared `types.ts` contracts.
 */

export {
  computeProjectContentHash,
  computeProjectId,
  parseProjectCard,
  serializeProjectCard,
} from "./cardParser.js";
export type { RunProjectRagCliDeps } from "./cli.js";
export { runProjectRagCli, toProjectRagConfig } from "./cli.js";
export type { ProjectJsonlIndexStoreOptions } from "./indexStore.js";
export { ProjectJsonlIndexStore } from "./indexStore.js";
export {
  canBridgeAnalyze,
  classifyFromSpdx,
  isCopyleftLicense,
  licenseScore,
  shouldIngestProjectCard,
  shouldStoreProjectBinary,
} from "./licensePolicy.js";
export {
  LicenseConfidenceSchema,
  ProjectProvenanceSchema,
  ProjectRagCardSchema,
  ProjectRagLicenseSchema,
  ProjectRagTypeSchema,
  ProjectScoreSchema,
} from "./schema.js";
export type { ProjectRagServiceDeps } from "./service.js";
export { createProjectRagService } from "./service.js";
export { createProjectIndexStore } from "./storeFactory.js";
export * from "./types.js";
