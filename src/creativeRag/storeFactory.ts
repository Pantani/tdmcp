/**
 * Creative RAG — index-store backend factory.
 *
 * Selects the index store from `config.backend`: the in-memory {@link JsonlIndexStore}
 * (default) or the optional-dependency {@link LanceIndexStore}. LanceDB is lazily
 * loaded; if the optional `@lancedb/lancedb` dependency is absent (or the first
 * table access fails for any reason), the factory logs one clear warning and FALLS
 * BACK to the JSONL store — so a `TDMCP_RAG_BACKEND=lancedb` misconfig never breaks
 * `sync`/`index`. The LanceIndexStore is constructed WITHOUT a `moduleLoader` so it
 * uses the real `loadLanceModule`; the testing seam stays available only to tests
 * that construct the store directly.
 */

import { join } from "node:path";
import type { Logger } from "../utils/logger.js";
import { JsonlIndexStore } from "./indexStore.js";
import { LanceIndexStore } from "./lanceIndexStore.js";
import type { CreativeRagConfig, IndexStore } from "./types.js";

const LANCE_TABLE_NAME = "creative_rag";

/**
 * Build the index store for `config`. With `backend === "lancedb"`, eagerly opens
 * the Lance table to surface a missing-dep/connection failure here, then falls
 * back to JSONL with a logged warning. Any other backend uses JSONL.
 */
export async function createIndexStore(
  config: CreativeRagConfig,
  logger: Logger,
): Promise<IndexStore> {
  const jsonlPath = join(config.dataDir, "index.jsonl");
  if (config.backend !== "lancedb") {
    return new JsonlIndexStore({ filePath: jsonlPath });
  }
  const lance = new LanceIndexStore({ dir: config.dataDir, tableName: LANCE_TABLE_NAME });
  try {
    // Force the (lazy) module import + table open now so a missing optional dep is
    // caught here and we can fall back cleanly rather than failing mid-sync.
    await lance.existingFingerprints();
    return lance;
  } catch (err) {
    logger.warn(
      "Creative RAG: LanceDB backend unavailable — falling back to JSONL store. " +
        "Install '@lancedb/lancedb' or set TDMCP_RAG_BACKEND=jsonl.",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return new JsonlIndexStore({ filePath: jsonlPath });
  }
}
