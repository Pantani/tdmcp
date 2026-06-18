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
export type { GithubLicenseResult } from "./extractors/githubLicense.js";
export { fetchGithubLicense } from "./extractors/githubLicense.js";
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
export { computeProjectScore } from "./scoring.js";
export type { ProjectRagEmbeddings, ProjectRagServiceDeps } from "./service.js";
export { createProjectRagService } from "./service.js";
export type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./sources/index.js";
export {
  DEFAULT_GITHUB_REPOS,
  githubRepoSource,
  parseRepoListEnv,
  parseRepoSpec,
  resolveProjectSources,
  SourceSkippedError,
} from "./sources/index.js";
export { createProjectIndexStore } from "./storeFactory.js";
export * from "./types.js";
