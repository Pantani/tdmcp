import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

// Copied verbatim from tests/integration/layer3.test.ts — introspects the
// assembled server over the in-memory MCP transport (msw mocks the bridge).
async function connectClient(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig(env); // defaults → 127.0.0.1:9980 (matches the mock bridge)
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tdmcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// The tools the `safe` profile drops. Must equal the set flagged
// `destructiveHint: true` (and SAFE_PROFILE_EXCLUDE in src/tools/index.ts).
const SAFE_PROFILE_EXCLUDE = [
  "execute_python_script",
  "exec_node_method",
  "create_python_script",
  "author_script_operator",
  "delete_td_node",
  "rebuild_network",
  "edit_dat_content",
  "set_dat_content",
  "edit_shader_live_loop",
  "create_panic",
  "manage_checkpoint",
  "manage_component",
  "manage_packages",
  "make_portable_tox",
  "export_recipe_bundle",
  "optimize_performance",
  "publish_recipe_bundle",
  "import_recipe_bundle",
  "scaffold_recipe_template",
  "attach_docs_as_assets",
  "local_marketplace_index",
  "marketplace_index_seed",
  "refresh_asset_previews",
  "install_library_package",
  "create_modulators",
  "project_documentation_site",
  "import_recipe_from_url",
  "export_palette_component",
  "collect_project_assets",
  "bundle_dependencies",
  "export_externalized_tree",
  "repair_network",
  "swap_operator",
  "export_sop_to_svg",
  "generative_classics_pack",
  "create_safety_blackout_chain",
  "merge_vaults",
  "manage_component_storage",
  "macro_recorder",
];

// Build/inspect surface that the safe profile must keep available.
const SAFE_PROFILE_KEEP = [
  "create_td_node",
  "connect_nodes",
  "update_td_node_parameters",
  "find_td_nodes",
  "get_td_info",
  "get_td_classes",
  "load_session_profile",
  "search_operators",
];

const DIRECTORY_PROFILE_TOOLS = [
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
];

async function toolList(env: NodeJS.ProcessEnv = {}) {
  const client = await connectClient(env);
  const { tools } = await client.listTools();
  return tools;
}

async function toolNames(env: NodeJS.ProcessEnv = {}): Promise<string[]> {
  const tools = await toolList(env);
  return tools.map((t) => t.name);
}

describe("integration: TDMCP_TOOL_PROFILE", () => {
  it("default (full) registers the destructive/raw tools", async () => {
    const names = await toolNames();
    expect(names).toEqual(expect.arrayContaining(SAFE_PROFILE_EXCLUDE));
  });

  it("explicit full registers the destructive/raw tools", async () => {
    const names = await toolNames({ TDMCP_TOOL_PROFILE: "full" });
    expect(names).toEqual(expect.arrayContaining(SAFE_PROFILE_EXCLUDE));
  });

  it("safe drops the raw-code tools", async () => {
    const names = await toolNames({ TDMCP_TOOL_PROFILE: "safe" });
    expect(names).not.toContain("execute_python_script");
    expect(names).not.toContain("exec_node_method");
    expect(names).not.toContain("create_python_script");
  });

  it("safe drops the destructive tools", async () => {
    const names = await toolNames({ TDMCP_TOOL_PROFILE: "safe" });
    expect(names).not.toContain("delete_td_node");
    expect(names).not.toContain("rebuild_network");
    expect(names).not.toContain("edit_dat_content");
    expect(names).not.toContain("set_dat_content");
    expect(names).not.toContain("create_panic");
    expect(names).not.toContain("manage_checkpoint");
    expect(names).not.toContain("manage_component");
    expect(names).not.toContain("manage_packages");
    expect(names).not.toContain("make_portable_tox");
    expect(names).not.toContain("export_recipe_bundle");
    expect(names).not.toContain("publish_recipe_bundle");
    expect(names).not.toContain("import_recipe_bundle");
    expect(names).not.toContain("scaffold_recipe_template");
    expect(names).not.toContain("attach_docs_as_assets");
    expect(names).not.toContain("local_marketplace_index");
    expect(names).not.toContain("refresh_asset_previews");
    expect(names).not.toContain("install_library_package");
    expect(names).not.toContain("create_modulators");
    expect(names).not.toContain("project_documentation_site");
    expect(names).not.toContain("import_recipe_from_url");
    expect(names).not.toContain("export_palette_component");
    expect(names).not.toContain("collect_project_assets");
    expect(names).not.toContain("repair_network");
    expect(names).not.toContain("swap_operator");
    expect(names).not.toContain("export_sop_to_svg");
    expect(names).not.toContain("generative_classics_pack");
  });

  it("safe keeps the build/inspect surface", async () => {
    const names = await toolNames({ TDMCP_TOOL_PROFILE: "safe" });
    expect(names).toEqual(expect.arrayContaining(SAFE_PROFILE_KEEP));
  });

  it("directory exposes exactly the compact registry-facing surface", async () => {
    const names = await toolNames({ TDMCP_TOOL_PROFILE: "directory" });
    expect(names.sort()).toEqual([...DIRECTORY_PROFILE_TOOLS].sort());
    expect(names).toHaveLength(15);
  });

  it("directory is a non-destructive subset of safe", async () => {
    const directory = await toolNames({ TDMCP_TOOL_PROFILE: "directory" });
    const safe = new Set(await toolNames({ TDMCP_TOOL_PROFILE: "safe" }));
    for (const name of directory) {
      expect(safe.has(name)).toBe(true);
      expect(SAFE_PROFILE_EXCLUDE).not.toContain(name);
    }
  });

  it("safe hides exactly SAFE_PROFILE_EXCLUDE.size fewer tools than full", async () => {
    const full = await toolNames({ TDMCP_TOOL_PROFILE: "full" });
    const safe = await toolNames({ TDMCP_TOOL_PROFILE: "safe" });
    expect(safe.length).toBeLessThan(full.length);
    expect(full.length - safe.length).toBe(SAFE_PROFILE_EXCLUDE.length);
    expect(SAFE_PROFILE_EXCLUDE.length).toBe(39);
  });

  it("safe exclusion list matches destructive tool annotations", async () => {
    const fullTools = await toolList({ TDMCP_TOOL_PROFILE: "full" });
    const destructiveNames = fullTools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(destructiveNames).toEqual([...SAFE_PROFILE_EXCLUDE].sort());
  });

  it("safe ⊇ rawPython=off (composition): safe hides everything rawPython=off hides", async () => {
    const full = await toolNames({ TDMCP_TOOL_PROFILE: "full" });
    const rawOff = await toolNames({ TDMCP_RAW_PYTHON: "off" });
    const safe = await toolNames({ TDMCP_TOOL_PROFILE: "safe" });
    const hiddenByRawOff = full.filter((n) => !rawOff.includes(n));
    const hiddenBySafe = new Set(full.filter((n) => !safe.includes(n)));
    for (const name of hiddenByRawOff) {
      expect(hiddenBySafe.has(name)).toBe(true);
    }
  });
});
