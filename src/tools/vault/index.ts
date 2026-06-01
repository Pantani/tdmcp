import type { ToolRegistrar } from "../types.js";
import { registerApplyShaderFromVault } from "./applyShaderFromVault.js";
import { registerAutoTagLibraryAsset } from "./autoTagLibraryAsset.js";
import { registerBindVaultText } from "./bindVaultText.js";
import { registerBrowseVaultLibrary } from "./browseVaultLibrary.js";
import { registerCaptureToVault } from "./captureToVault.js";
import { registerExportLookTox } from "./exportLookTox.js";
import { registerExportNetworkToVault } from "./exportNetworkToVault.js";
import { registerExportSetlistToVault } from "./exportSetlistToVault.js";
import { registerGenerateFromMoodboard } from "./generateFromMoodboard.js";
import { registerGenerateLibraryIndex } from "./generateLibraryIndex.js";
import { registerImportSetlist } from "./importSetlist.js";
import { registerLearnConventions } from "./learnConventions.js";
import { registerLearnFromMyCorpus } from "./learnFromMyCorpus.js";
import { registerLibraryLineageGraph } from "./libraryLineageGraph.js";
import { registerLogPerformance } from "./logPerformance.js";
import { registerMergeVaults } from "./mergeVaults.js";
import { registerMorphPack } from "./morphPack.js";
import { registerRecallSimilarWork } from "./recallSimilarWork.js";
import { registerSaveComponentToVault } from "./saveComponentToVault.js";
import { registerSaveRecipeToVault } from "./saveRecipeToVault.js";
import { registerScaffoldVault } from "./scaffoldVault.js";
import { registerStyleMemory } from "./styleMemory.js";
import { registerSyncPresetsVault } from "./syncPresetsVault.js";
import { registerTagAndSearchLibrary } from "./tagAndSearchLibrary.js";
import { registerTutorialCompanionPack } from "./tutorialCompanionPack.js";
import { registerVariantPack } from "./variantPack.js";
import { registerVaultRepoSync } from "./vaultRepoSync.js";
import { registerVersionLibraryAsset } from "./versionLibraryAsset.js";

/**
 * Tools that bridge an Obsidian vault and TouchDesigner. All of them are gated on
 * `TDMCP_VAULT_PATH` (see {@link requireVault}); registered unconditionally so the
 * artist gets a clear "configure your vault" message rather than a missing tool.
 */
export const vaultRegistrars: ToolRegistrar[] = [
  registerScaffoldVault,
  registerSaveRecipeToVault,
  registerApplyShaderFromVault,
  registerSyncPresetsVault,
  registerExportNetworkToVault,
  registerLogPerformance,
  registerImportSetlist,
  registerBindVaultText,
  registerGenerateFromMoodboard,
  // Phase 14 — component library in the vault:
  registerSaveComponentToVault,
  registerBrowseVaultLibrary,
  // Phase 15 — visual gallery + setlist round-trip:
  registerCaptureToVault,
  registerExportSetlistToVault,
  // Phase 16 — library contact-sheet:
  registerGenerateLibraryIndex,
  // Campaign BEYOND Wave 1 (backlog 2026-05-30 — v0.7.0):
  registerAutoTagLibraryAsset,
  registerRecallSimilarWork,
  registerStyleMemory,
  // Campaign BEYOND Wave 3 (backlog 2026-05-30 — v0.7.0):
  registerLibraryLineageGraph,
  registerMorphPack,
  registerLearnConventions,
  // Campaign BEYOND Wave 5 (backlog 2026-05-30 — v0.7.0):
  registerMergeVaults,
  registerVaultRepoSync,
  registerVariantPack,
  registerLearnFromMyCorpus,
  // Ingest-extend Wave 3 sub-batch A (campaign 2026-05-31 — v0.9.0):
  registerTagAndSearchLibrary,
  registerVersionLibraryAsset,
  // Ingest-extend Wave 3 sub-batch B (campaign 2026-06-01 — v0.9.0):
  registerExportLookTox,
  registerTutorialCompanionPack,
];
