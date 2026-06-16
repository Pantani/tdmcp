import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMacroRecorder } from "../automation/macroSchema.js";
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

  // Wrap registerTool so each registered handler is recorded when a macro is
  // active (macro_recorder itself is exempt via the recorder's own guard).
  // Installed BEFORE registerAllTools so every tool picks up the hook.
  const macroRecorder = getMacroRecorder();
  // biome-ignore lint/suspicious/noExplicitAny: registerTool is heavily overloaded — type the bound copy as variadic so we can transparently wrap the final handler.
  const realRegisterTool = server.registerTool.bind(server) as (...args: any[]) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's variadic registerTool signature.
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: handler args/return are tool-specific.
      const wrapped = macroRecorder.wrapHandler<any, any>(name, handler);
      rest[rest.length - 1] = wrapped;
    }
    return realRegisterTool(name, ...rest);
  };

  // Expose the live server to tools that introspect the registry
  // (e.g. elicit_missing_args). Set BEFORE registerAllTools runs.
  ctx.server = server;

  try {
    registerAllTools(server, ctx);
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore the original method post-registration.
    (server as any).registerTool = realRegisterTool;
  }
  registerAllResources(server, {
    knowledge,
    recipes,
    logger,
    client: ctx.client,
    creativeRag: ctx.creativeRag,
  });
  registerAllPrompts(server, { knowledge, recipes, logger });

  // Defer the stats log to after we return so the heavy knowledge-base warmup
  // doesn't gate the transport from accepting connections. The version is cheap
  // (cached) so we log it inline; the rest is fire-and-forget.
  logger.info("tdmcp server initializing", { version: getVersion() });
  setImmediate(() => {
    logger.info("tdmcp server ready", {
      knowledge: knowledge.stats(),
      recipes: recipes.list().length,
    });
  });

  return server;
}
