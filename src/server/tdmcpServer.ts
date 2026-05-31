import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLazyLlmClient } from "../llm/resolve.js";
import { registerAllPrompts } from "../prompts/index.js";
import { registerAllResources } from "../resources/index.js";
import { registerAllTools } from "../tools/index.js";
import type { TdmcpConfig } from "../utils/config.js";
import { getVersion } from "../utils/version.js";
import { buildToolContext, type ToolContextOverrides } from "./context.js";

const INSTRUCTIONS = `tdmcp lets you build visual systems in TouchDesigner.

Workflow:
1. Call get_td_info first to confirm the bridge is reachable.
2. Consult the knowledge base resources (tdmcp://operators/..., tdmcp://recipes/...) before creating nodes — never invent operator types.
3. Build with the highest-level tool that fits, dropping to Layer 2/3 for fine control.
4. After building, check get_td_node_errors and capture get_preview so the artist can see the result.
5. Prefer structured inspection/edit tools (find_td_nodes, get_td_node_parameters, summarize_td_errors, compare_td_nodes, snapshot_td_graph, update_td_node_parameters) and process their structuredContent with code. Treat execute_python_script and exec_node_method as a last resort, only when no structured tool fits.

The server stays usable even when TouchDesigner is offline; tools return a friendly error in that case.`;

export type TdmcpServerOverrides = ToolContextOverrides;

/** Builds a fully wired (but not yet connected) MCP server. */
export function createTdmcpServer(
  config: TdmcpConfig,
  overrides: TdmcpServerOverrides = {},
): McpServer {
  const ctx = buildToolContext(config, overrides);
  const { knowledge, recipes, logger } = ctx;

  const server = new McpServer(
    { name: "tdmcp", version: getVersion() },
    { instructions: INSTRUCTIONS },
  );

  // Wire the LLM shim now that the underlying Server exists. Sampling capability
  // is probed on first method call (post-initialize) — no `sampling` server
  // capability declared. Eager resolution here would race the MCP handshake and
  // always fall through to LlmClient because getClientCapabilities() is empty
  // before the client's initialize request arrives.
  ctx.llm = createLazyLlmClient(config, server.server);

  registerAllTools(server, ctx);
  registerAllResources(server, { knowledge, recipes, logger, client: ctx.client });
  registerAllPrompts(server, { knowledge, recipes, logger });

  logger.info("tdmcp server initialized", {
    version: getVersion(),
    knowledge: knowledge.stats(),
    recipes: recipes.list().length,
  });

  return server;
}
