import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createAudioReactiveImpl,
  createAudioReactiveSchema,
} from "../tools/layer1/createAudioReactive.js";
import {
  createFeedbackNetworkImpl,
  createFeedbackNetworkSchema,
} from "../tools/layer1/createFeedbackNetwork.js";
import {
  createGenerativeArtImpl,
  createGenerativeArtSchema,
} from "../tools/layer1/createGenerativeArt.js";
import { listRecipesImpl, listRecipesSchema } from "../tools/layer1/listRecipes.js";
import { connectNodesImpl, connectNodesSchema } from "../tools/layer2/connectNodes.js";
import {
  compactGraphDigestImpl,
  compactGraphDigestSchema,
} from "../tools/layer3/compactGraphDigest.js";
import {
  compareOperatorDocsImpl,
  compareOperatorDocsSchema,
} from "../tools/layer3/compareOperatorDocs.js";
import { compareTdNodesImpl, compareTdNodesSchema } from "../tools/layer3/compareTdNodes.js";
import { createTdNodeImpl, createTdNodeSchema } from "../tools/layer3/createTdNode.js";
import { deleteTdNodeImpl, deleteTdNodeSchema } from "../tools/layer3/deleteTdNode.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { getModuleHelpImpl, getModuleHelpSchema } from "../tools/layer3/getModuleHelp.js";
import {
  getOperatorWorkflowGuideImpl,
  getOperatorWorkflowGuideSchema,
} from "../tools/layer3/getOperatorWorkflowGuide.js";
import {
  getTdClassDetailsImpl,
  getTdClassDetailsSchema,
} from "../tools/layer3/getTdClassDetails.js";
import { getTdClassesImpl, getTdClassesSchema } from "../tools/layer3/getTdClasses.js";
import { getTdInfoImpl } from "../tools/layer3/getTdInfo.js";
import { getTdNodeErrorsImpl, getTdNodeErrorsSchema } from "../tools/layer3/getTdNodeErrors.js";
import {
  getTdNodeParametersImpl,
  getTdNodeParametersSchema,
} from "../tools/layer3/getTdNodeParameters.js";
import { getTdNodesImpl, getTdNodesSchema } from "../tools/layer3/getTdNodes.js";
import { getTdTopologyImpl, getTdTopologySchema } from "../tools/layer3/getTdTopology.js";
import { searchOperatorsImpl, searchOperatorsSchema } from "../tools/layer3/searchOperators.js";
import { searchPythonApiImpl, searchPythonApiSchema } from "../tools/layer3/searchPythonApi.js";
import {
  searchTouchDesignerKnowledgeImpl,
  searchTouchDesignerKnowledgeSchema,
} from "../tools/layer3/searchTouchDesignerKnowledge.js";
import {
  summarizeTdErrorsImpl,
  summarizeTdErrorsSchema,
} from "../tools/layer3/summarizeTdErrors.js";
import {
  updateTdNodeParametersImpl,
  updateTdNodeParametersSchema,
} from "../tools/layer3/updateTdNodeParameters.js";
import type { ToolContext } from "../tools/types.js";
import type { OpenAITool } from "./client.js";
import { createProjectRagSearchTool } from "./projectRagSearchTool.js";

// biome-ignore lint/suspicious/noExplicitAny: args are validated by each tool's zod schema before use.
type Runner = (ctx: ToolContext, args: any) => CallToolResult | Promise<CallToolResult>;

export interface LlmTool {
  /** Function name advertised to the model (mirrors the MCP tool name). */
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: Runner;
  /** Whether the tool changes the TD project (vs. read-only inspection). */
  mutates: boolean;
}

const t = (
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  run: Runner,
  mutates = false,
): LlmTool => ({
  name,
  description,
  schema,
  run,
  mutates,
});

/**
 * The subset of tdmcp tools exposed to the *local* copilot. Deliberately limited
 * to single-call inspection and CRUD — the Layer-1 system generators and the raw
 * Python escape hatches are withheld so a small model stays in its lane. Complex,
 * multi-step builds are meant to be escalated to Claude/Codex, which see the full
 * toolset over the same bridge.
 */
export const LLM_TOOLS: LlmTool[] = [
  // --- read-only inspection ---
  t(
    "get_td_info",
    "Health check: confirm the TouchDesigner bridge is reachable and report TD/bridge versions.",
    z.object({}),
    (ctx) => getTdInfoImpl(ctx),
  ),
  t(
    "get_td_nodes",
    "List the direct child nodes of a COMP (defaults to /project1).",
    getTdNodesSchema,
    getTdNodesImpl,
  ),
  t(
    "find_td_nodes",
    "Search the project for nodes by name pattern and/or operator type.",
    findTdNodesSchema,
    findTdNodesImpl,
  ),
  t(
    "get_td_node_parameters",
    "Read one node's current parameter values.",
    getTdNodeParametersSchema,
    getTdNodeParametersImpl,
  ),
  t(
    "get_td_node_errors",
    "Check a node or network for errors and warnings.",
    getTdNodeErrorsSchema,
    getTdNodeErrorsImpl,
  ),
  t(
    "summarize_td_errors",
    "Cluster a network's errors by likely cause.",
    summarizeTdErrorsSchema,
    summarizeTdErrorsImpl,
  ),
  t(
    "get_td_topology",
    "Map the nodes and their connections in a network.",
    getTdTopologySchema,
    getTdTopologyImpl,
  ),
  t(
    "compact_graph_digest",
    "Tiny, token-bounded structural summary of a network (families + output chain + grouped errors) — pick this first for small LLM context.",
    compactGraphDigestSchema,
    compactGraphDigestImpl,
  ),
  t(
    "compare_td_nodes",
    "Diff two nodes' parameters to see what differs.",
    compareTdNodesSchema,
    compareTdNodesImpl,
  ),
  // --- offline knowledge base (no TD required) ---
  t(
    "search_operators",
    "Search the 629-operator knowledge base by keyword to find the right operator type (offline).",
    searchOperatorsSchema,
    searchOperatorsImpl,
  ),
  t(
    "compare_operator_docs",
    "Compare two operator types from the offline knowledge base, including shared and unique documented parameters.",
    compareOperatorDocsSchema,
    compareOperatorDocsImpl,
  ),
  t(
    "get_operator_workflow_guide",
    "Get one operator's common inputs, outputs, examples, and next-operator suggestions (offline).",
    getOperatorWorkflowGuideSchema,
    getOperatorWorkflowGuideImpl,
  ),
  t(
    "search_touchdesigner_knowledge",
    "Search embedded TouchDesigner operators, versions, compatibility notes, technique packs, TD classes, and experimental notes (offline).",
    searchTouchDesignerKnowledgeSchema,
    searchTouchDesignerKnowledgeImpl,
  ),
  t(
    "search_python_api",
    "Search TouchDesigner Python API classes, methods, and members from the offline knowledge base.",
    searchPythonApiSchema,
    searchPythonApiImpl,
  ),
  t(
    "list_recipes",
    "Browse the built-in recipe library (pre-validated network templates) by id (offline).",
    listRecipesSchema,
    listRecipesImpl,
  ),
  t(
    "get_td_classes",
    "List TouchDesigner Python API classes from the offline knowledge base.",
    getTdClassesSchema,
    getTdClassesImpl,
  ),
  t(
    "get_td_class_details",
    "Get details for one TouchDesigner Python class from the offline knowledge base.",
    getTdClassDetailsSchema,
    getTdClassDetailsImpl,
  ),
  t(
    "get_module_help",
    "Human-readable help for a TouchDesigner Python class (offline).",
    getModuleHelpSchema,
    getModuleHelpImpl,
  ),
  // --- simple mutations ---
  t(
    "create_td_node",
    "Create a single operator inside a COMP.",
    createTdNodeSchema,
    createTdNodeImpl,
    true,
  ),
  t(
    "update_td_node_parameters",
    "Set one or more parameters on an existing node.",
    updateTdNodeParametersSchema,
    updateTdNodeParametersImpl,
    true,
  ),
  t("delete_td_node", "Delete a node.", deleteTdNodeSchema, deleteTdNodeImpl, true),
  t(
    "connect_nodes",
    "Wire one node's output into another node's input.",
    connectNodesSchema,
    connectNodesImpl,
    true,
  ),
];

/**
 * A small, safe set of Layer-1 *generators* offered only in the opt-in `creative` tier,
 * so the local copilot can build a whole look offline (no cloud handoff) for a no-internet
 * gig. Each generator orchestrates a network server-side and returns a friendly error on
 * failure, so a misfire can't corrupt the project. Kept deliberately tiny — small-model
 * tool-call accuracy on multi-arg generator schemas is unbenchmarked, so this is off by
 * default; widen it only after benchmarking the configured model.
 */
export const CREATIVE_TOOLS: LlmTool[] = [
  t(
    "create_generative_art",
    "Build a whole generative-art visual system from a short description (noise/feedback/flow).",
    createGenerativeArtSchema,
    createGenerativeArtImpl,
    true,
  ),
  t(
    "create_feedback_network",
    "Build a feedback-loop visual network (trails / tunnels) in one call.",
    createFeedbackNetworkSchema,
    createFeedbackNetworkImpl,
    true,
  ),
  t(
    "create_audio_reactive",
    "Build an audio-reactive visual that responds to the music in one call.",
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    true,
  ),
];

/**
 * Tool exposure tiers. `safe` = inspection only; `standard` = inspection + simple CRUD;
 * `creative` = standard + a curated set of safe Layer-1 generators (opt-in).
 */
export type ToolTier = "standard" | "safe" | "creative";

/**
 * Optional knobs for {@link resolveTools}. Used to opt-in features that should
 * be advertised in the LLM tool catalog only when their underlying service is
 * enabled (e.g. Project RAG search is only exposed when
 * `TDMCP_PROJECT_RAG_ENABLED=1` and the service is wired into `ctx.projectRag`).
 */
export interface ResolveToolsOptions {
  /**
   * When true, append the read-only `project_rag_search` LLM tool to every
   * tier. Gated at catalog assembly so a disabled server never advertises the
   * tool. Should be `true` only when `ctx.projectRag !== undefined`.
   */
  projectRag?: boolean;
}

/**
 * Resolve the tool set for a tier. `safe` drops every mutating tool (read-only copilot);
 * `creative` adds the curated Layer-1 generators on top of `standard`.
 */
export function resolveTools(
  tier: ToolTier = "standard",
  opts: ResolveToolsOptions = {},
): LlmTool[] {
  const base =
    tier === "safe"
      ? LLM_TOOLS.filter((tool) => !tool.mutates)
      : tier === "creative"
        ? [...LLM_TOOLS, ...CREATIVE_TOOLS]
        : LLM_TOOLS;
  if (opts.projectRag === true) {
    return [...base, createProjectRagSearchTool()];
  }
  return base;
}

/** Flatten a CallToolResult's text blocks into a single string. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Convert the curated registry into the OpenAI `tools` array sent on every request. */
export function toOpenAITools(tools: LlmTool[] = LLM_TOOLS): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema),
    },
  }));
}

export interface ToolOutcome {
  ok: boolean;
  /** First line of the result — shown as a chip in the UI. */
  summary: string;
  /** Full payload (text + structured JSON) fed back to the model. */
  payload: string;
}

/** Validate args against the tool's schema, run it, and package the result for the model. */
export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  rawArgs: string,
  tools: LlmTool[] = LLM_TOOLS,
): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool)
    return {
      ok: false,
      summary: `unknown tool: ${name}`,
      payload: `Error: no tool named "${name}".`,
    };

  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return {
      ok: false,
      summary: `bad JSON args for ${name}`,
      payload: `Error: arguments were not valid JSON: ${(err as Error).message}`,
    };
  }

  const args = tool.schema.safeParse(parsed);
  if (!args.success) {
    return {
      ok: false,
      summary: `invalid args for ${name}`,
      payload: `Error: invalid arguments: ${args.error.message}`,
    };
  }

  const result = await tool.run(ctx, args.data);
  const text = textOf(result);
  const payload = result.structuredContent
    ? `${text}\n\n${JSON.stringify(result.structuredContent)}`
    : text;
  return { ok: !result.isError, summary: text.split("\n")[0] ?? name, payload };
}
