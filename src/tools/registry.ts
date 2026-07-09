import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { aiRegistrars } from "./ai/index.js";
import { foundationRegistrars } from "./foundation/index.js";
import { layer1Registrars } from "./layer1/index.js";
import { layer2Registrars } from "./layer2/index.js";
import { layer3Registrars } from "./layer3/index.js";
import { libraryRegistrars } from "./library/index.js";
import type { ToolContext, ToolRegistrar } from "./types.js";
import { utilRegistrars } from "./util/index.js";
import { vaultRegistrars } from "./vault/index.js";

/**
 * Tools hidden by the `safe` profile: every tool flagged `destructiveHint: true`.
 * This is a strict superset of TDMCP_RAW_PYTHON=off (which hides the raw-code
 * authoring/execution tools), so `safe` ⊇ rawPython=off. Keep in sync with
 * `destructiveHint: true` annotations (a registration test guards this — see
 * toolProfile.test.ts).
 *
 * NOTE: this is deliberately NOT the copilot's `LLM_TOOLS` `mutates`
 * classification (src/llm/tools.ts): that splits read-only vs. write over a
 * different, smaller curated toolset, whereas `safe` keeps non-destructive
 * mutations (create/connect/animate) and only drops the destructive ones.
 */
const SAFE_PROFILE_EXCLUDE = new Set<string>([
  "execute_python_script", // raw client-authored code (also gated by rawPython)
  "exec_node_method", // raw client-authored code (also gated by rawPython)
  "create_python_script", // raw client-authored code stored in DATs (also gated by rawPython)
  "delete_td_node", // removes nodes
  "rebuild_network", // can clear/recreate a parent's children
  "edit_dat_content", // destructive DAT rewrite, even though scoped/guarded
  "set_dat_content", // whole-DAT overwrite
  "edit_shader_live_loop", // composed shader DAT rewrite + post-edit inspection loop
  "create_panic", // bypasses & deletes
  "manage_checkpoint", // overwrites saved state
  "manage_component", // can delete/replace components
  "manage_packages", // stages/uninstalls community package files
  "make_portable_tox", // writes/overwrites .tox packages on disk
  "export_recipe_bundle", // writes bundle files
  "publish_recipe_bundle", // writes bundle publish artifacts and checksum manifests
  "import_recipe_bundle", // writes recipe files
  "scaffold_recipe_template", // writes recipe files
  "attach_docs_as_assets", // copies files and rewrites manifests
  "local_marketplace_index", // writes index files
  "marketplace_index_seed", // writes/overwrites user-specified seed JSON files
  "refresh_asset_previews", // writes preview images
  "install_library_package", // copies/extracts package files
  "create_modulators", // rebuilds a same-named container, clearing its children
  "project_documentation_site", // writes/overwrites documentation files
  "import_recipe_from_url", // downloads and writes recipe files
  "export_palette_component", // writes .tox files into the Palette
  "collect_project_assets", // may overwrite the local asset manifest
  "bundle_dependencies", // copies assets, rewrites live pars, and saves a .tox package
  "export_externalized_tree", // saves external .tox files and rewrites externaltox pars
  "repair_network", // can reset parameter expressions and re-enable ops when dry_run:false
  "swap_operator", // deletes the old node and creates a replacement (destructive even with rollback)
  "export_sop_to_svg", // writes/overwrites an SVG at a user-controlled filesystem path
  "generative_classics_pack", // writes/overwrites a bundle JSON at a user-controlled filesystem path
  "create_safety_blackout_chain", // builds a panic/kill chain — declared destructive
  "merge_vaults", // the 'theirs' strategy overwrites files in the target vault
  "manage_component_storage", // the delete action removes storage keys; set overwrites values
  "macro_recorder", // stop writes a caller-named file (absolute paths allowed), truncating any existing file
]);

/**
 * Small registry/directory-facing surface. This keeps discovery pages coherent
 * without changing the full local runtime default.
 */
const DIRECTORY_PROFILE_ALLOW = new Set<string>([
  "get_td_info",
  "search_operators",
  "get_td_classes",
  "get_operator_workflow_guide",
  "find_td_nodes",
  "get_td_node_parameters",
  "get_td_node_flags",
  "get_td_topology",
  "create_td_node",
  "connect_nodes",
  "update_td_node_parameters",
  "validate_operator_chain",
  "list_recipes",
  "apply_recipe",
  "browse_library",
]);

export const runtimeToolRegistrars: ToolRegistrar[] = [
  ...layer3Registrars,
  ...layer2Registrars,
  ...layer1Registrars,
  ...foundationRegistrars,
  ...libraryRegistrars,
  ...utilRegistrars,
  ...vaultRegistrars,
  ...aiRegistrars,
];

export function registerToolRegistrars(
  server: McpServer,
  ctx: ToolContext,
  registrars: readonly ToolRegistrar[],
): void {
  // For filtered profiles, intercept registerTool and drop names in one place.
  // The registrars ignore registerTool's return value, so returning undefined
  // for an excluded name is safe; resources/prompts register later, untouched.
  if (ctx.toolProfile === "safe" || ctx.toolProfile === "directory") {
    // biome-ignore lint/suspicious/noExplicitAny: registerTool is overloaded; type the bound copy as variadic so we can forward args.
    const realRegister = server.registerTool.bind(server) as (...args: any[]) => unknown;
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
    (server as any).registerTool = (name: string, ...rest: any[]) => {
      if (ctx.toolProfile === "safe" && SAFE_PROFILE_EXCLUDE.has(name)) return undefined;
      if (ctx.toolProfile === "directory" && !DIRECTORY_PROFILE_ALLOW.has(name)) {
        return undefined;
      }
      return realRegister(name, ...rest);
    };
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

export function registerRuntimeTools(server: McpServer, ctx: ToolContext): void {
  registerToolRegistrars(server, ctx, runtimeToolRegistrars);
}
