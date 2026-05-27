import type { ToolRegistrar } from "../types.js";
import { registerApplyShaderFromVault } from "./applyShaderFromVault.js";
import { registerSaveRecipeToVault } from "./saveRecipeToVault.js";
import { registerSyncPresetsVault } from "./syncPresetsVault.js";

/**
 * Tools that bridge an Obsidian vault and TouchDesigner. All of them are gated on
 * `TDMCP_VAULT_PATH` (see {@link requireVault}); registered unconditionally so the
 * artist gets a clear "configure your vault" message rather than a missing tool.
 */
export const vaultRegistrars: ToolRegistrar[] = [
  registerSaveRecipeToVault,
  registerApplyShaderFromVault,
  registerSyncPresetsVault,
];
