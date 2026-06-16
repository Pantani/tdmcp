/**
 * Creative RAG — public barrel.
 *
 * Re-exports the surface the integrator wires into `src/index.ts` (CLI +
 * config mapper), the server context (`createCreativeRagService`), the read-only
 * resource (`JsonlIndexStore`), and the shared `types.ts` contracts.
 */

export type { RunCreativeRagCliDeps } from "./cli.js";
export { runCreativeRagCli, toCreativeRagConfig } from "./cli.js";
export type { JsonlIndexStoreOptions } from "./indexStore.js";
export { JsonlIndexStore } from "./indexStore.js";
export type { CreativeRagServiceDeps } from "./service.js";
export { createCreativeRagService } from "./service.js";
export * from "./types.js";
