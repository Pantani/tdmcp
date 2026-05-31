import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { layer1Registrars } from "./layer1/index.js";
import { layer2Registrars } from "./layer2/index.js";
import { layer3Registrars } from "./layer3/index.js";
import { libraryRegistrars } from "./library/index.js";
import type { ToolContext } from "./types.js";
import { vaultRegistrars } from "./vault/index.js";

/**
 * Tools hidden by the `safe` profile: every tool flagged `destructiveHint: true`.
 * This is a strict superset of TDMCP_RAW_PYTHON=off (which hides only the first
 * two), so `safe` ⊇ rawPython=off. Keep in sync with `destructiveHint: true`
 * annotations (a registration test guards this — see toolProfile.test.ts).
 *
 * NOTE: this is deliberately NOT the copilot's `LLM_TOOLS` `mutates` classification
 * (src/llm/tools.ts): that splits read-only vs. write over a different, smaller
 * curated toolset, whereas `safe` keeps non-destructive mutations
 * (create/connect/animate) and only drops the destructive ones. Don't unify them.
 */
const SAFE_PROFILE_EXCLUDE = new Set<string>([
  "execute_python_script", // raw client-authored code (also gated by rawPython)
  "exec_node_method", // raw client-authored code (also gated by rawPython)
  "delete_td_node", // removes nodes
  "rebuild_network", // can clear/recreate a parent's children
  "edit_dat_content", // destructive DAT rewrite, even though scoped/guarded
  "set_dat_content", // whole-DAT overwrite
  "create_panic", // bypasses & deletes
  "manage_checkpoint", // overwrites saved state
  "manage_component", // can delete/replace components
  "manage_packages", // stages/uninstalls community package files
  "make_portable_tox", // writes/overwrites .tox packages on disk
  "export_recipe_bundle", // writes bundle files
  "import_recipe_bundle", // writes recipe files
  "scaffold_recipe_template", // writes recipe files
  "attach_docs_as_assets", // copies files and rewrites manifests
  "local_marketplace_index", // writes index files
  "refresh_asset_previews", // writes preview images
  "install_library_package", // copies/extracts package files
  "create_modulators", // rebuilds a same-named container, clearing its children
  "project_documentation_site", // writes/overwrites documentation files
  "import_recipe_from_url", // downloads and writes recipe files
  "export_palette_component", // writes .tox files into the Palette
  "collect_project_assets", // may overwrite the local asset manifest
]);

/** Registers every tool (all layers) against the MCP server, honoring the profile. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  const registrars = [
    ...layer3Registrars,
    ...layer2Registrars,
    ...layer1Registrars,
    ...libraryRegistrars,
    ...vaultRegistrars,
  ];

  // For `safe`, intercept registerTool and drop excluded names. We wrap rather
  // than gate each registrar so the exclusion list lives in one place. The
  // registrars ignore registerTool's return value, so returning undefined for an
  // excluded name is safe; resources/prompts register later, untouched.
  if (ctx.toolProfile === "safe") {
    // biome-ignore lint/suspicious/noExplicitAny: registerTool is overloaded; type the bound copy as variadic so we can forward args.
    const realRegister = server.registerTool.bind(server) as (...args: any[]) => unknown;
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
    (server as any).registerTool = (name: string, ...rest: any[]) =>
      SAFE_PROFILE_EXCLUDE.has(name) ? undefined : realRegister(name, ...rest);
    try {
      for (const register of registrars) register(server, ctx);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore the original method.
      (server as any).registerTool = realRegister;
    }
    return;
  }

  for (const register of registrars) register(server, ctx);
}

export type { ToolContext, ToolRegistrar } from "./types.js";
