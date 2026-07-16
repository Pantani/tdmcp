import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreativeRagService } from "../creativeRag/index.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { LlmClientLike } from "../llm/client.js";
import type { ProjectRagService } from "../projectRag/index.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import type { Logger } from "../utils/logger.js";
import type { Vault } from "../vault/index.js";

/** Shared dependencies injected into every tool handler (keeps handlers testable). */
export interface ToolContext {
  client: TouchDesignerClient;
  /** Private bridge credential from config. Never expose this in a tool schema or result. */
  bridgeToken?: string;
  knowledge: KnowledgeBase;
  recipes: RecipeLibrary;
  logger: Logger;
  /** Optional Obsidian vault (set via TDMCP_VAULT_PATH); undefined when not configured. */
  vault?: Vault;
  /**
   * Whether the raw Python escape-hatch tools may be registered. Undefined means
   * allowed (the default); only an explicit `false` locks them out.
   */
  allowRawPython?: boolean;
  /**
   * "YOLO" mode (`TDMCP_YOLO=1`): skip any interactive confirmation the bridge may
   * add for destructive actions. Surfaced in result reporting; false/undefined by
   * default so nothing is silently skipped.
   */
  yolo?: boolean;
  /**
   * Tool exposure profile. `"safe"` hides destructive/raw-code tools; `"directory"`
   * exposes a small registry-facing build/inspect surface.
   * Undefined means `"full"` (the default).
   */
  toolProfile?: "full" | "safe" | "directory";
  /** Effective project root from env, config file, or selected profile. */
  projectRoot?: string;
  /** Effective local-copilot receipt policy from the loaded config. */
  copilotReceipts?: "off" | "persist";
  /** Effective private receipt-store path from the loaded config. */
  copilotReceiptsPath?: string;
  /**
   * Best-effort LLM backend for tools that need vision/captioning/text completion
   * (e.g. caption_top, auto_tag_library_asset). Routed via `resolveLlmClient`:
   * MCP sampling when the client supports it, else a local OpenAI/Ollama client.
   * Tools must degrade gracefully when this is undefined or unreachable.
   */
  llm?: LlmClientLike;
  /**
   * Metadata-only enabled-tool snapshot for planners running outside an MCP
   * transport (for example `tdmcp-agent plan`). It contains no handlers and
   * cannot execute a tool. MCP-hosted planners may instead inspect `server`.
   */
  plannerToolCatalog?: Readonly<
    Record<
      string,
      {
        title?: string;
        description?: string;
        enabled: boolean;
      }
    >
  >;
  /**
   * The MCP server instance. Assigned by `createTdmcpServer` before tool
   * registration so a few tools (e.g. `elicit_missing_args`) can introspect the
   * live tool registry.
   */
  server?: McpServer;
  /**
   * Optional local Creative RAG repertoire service (set when
   * `TDMCP_RAG_ENABLED=1`); undefined when the feature is off. Backs the
   * read-only `tdmcp://creative/*` resources only — no actionable tool.
   */
  creativeRag?: CreativeRagService;
  /**
   * Optional local Project RAG repertoire service (set when
   * `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`); undefined when off.
   * Backs the read-only `tdmcp://project/*` resources only — no actionable
   * tool. NEVER touches the TD bridge; F3 bridge-analyze uses a SEPARATE
   * client on a dedicated port.
   */
  projectRag?: ProjectRagService;
}

/** A function that registers one tool against the MCP server. */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;
