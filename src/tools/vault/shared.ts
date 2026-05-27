import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ParsedNote } from "../../vault/frontmatter.js";
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

/**
 * Reads a vault note without letting it throw out of the handler. A malformed
 * YAML frontmatter (gray-matter's `matter()` throws) or an I/O error after the
 * `exists()` check (read race, permissions, non-UTF8) becomes a friendly error
 * result instead of crashing the tool with a JSON-RPC protocol error. Usage
 * mirrors {@link requireVault}:
 *
 * ```ts
 * const note = readNoteSafe(vault, rel);
 * if ("error" in note) return note.error;
 * const { data, body } = note;
 * ```
 */
export function readNoteSafe(
  vault: Vault,
  relPath: string,
): ParsedNote | { error: CallToolResult } {
  try {
    return vault.readNote(relPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      error: errorResult(
        `Could not read vault note "${relPath}": ${reason}. ` +
          "Check the file is readable and its YAML frontmatter is valid.",
      ),
    };
  }
}
