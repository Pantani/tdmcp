import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Vault } from "../../vault/index.js";
import { errorResult } from "../result.js";
import type { ToolContext } from "../types.js";

const NO_VAULT =
  "No Obsidian vault is configured. Set TDMCP_VAULT_PATH to your vault folder " +
  "(e.g. ~/Documents/MyVault) and restart the server, then try again.";

/**
 * Guards a vault tool: returns the configured {@link Vault}, or a friendly
 * error result when `TDMCP_VAULT_PATH` is unset. Usage:
 *
 * ```ts
 * const v = requireVault(ctx);
 * if ("error" in v) return v.error;
 * const { vault } = v;
 * ```
 */
export function requireVault(ctx: ToolContext): { vault: Vault } | { error: CallToolResult } {
  if (!ctx.vault) return { error: errorResult(NO_VAULT) };
  return { vault: ctx.vault };
}
