/**
 * Project RAG — index-store backend factory.
 *
 * F0 baseline: a JSONL store, isolated to `<config.dataDir>/index.jsonl` (which
 * already lives under `<ragDataDir>/project/` because the CLI/context maps
 * `dataDir = ragDataDir + '/project'`). LanceDB upgrade is deferred to F2+ —
 * the type stays open so swapping backends does not break callers.
 */

import { join } from "node:path";
import type { Logger } from "../utils/logger.js";
import { ProjectJsonlIndexStore } from "./indexStore.js";
import type { ProjectIndexStore, ProjectRagConfig } from "./types.js";

/** Build the project index store for `config`. JSONL-only in F0. */
export async function createProjectIndexStore(
  config: ProjectRagConfig,
  _logger: Logger,
): Promise<ProjectIndexStore> {
  const jsonlPath = join(config.dataDir, "index.jsonl");
  return new ProjectJsonlIndexStore({ filePath: jsonlPath });
}
