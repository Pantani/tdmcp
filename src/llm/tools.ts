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
import { createGlitchImpl, createGlitchSchema } from "../tools/layer1/createGlitch.js";
import { createStrobeImpl, createStrobeSchema } from "../tools/layer1/createStrobe.js";
import { getPreviewImpl, getPreviewSchema } from "../tools/layer1/getPreview.js";
import { connectNodesImpl, connectNodesSchema } from "../tools/layer2/connectNodes.js";
import { createPaletteImpl, createPaletteSchema } from "../tools/layer2/createPalette.js";
import { compareTdNodesImpl, compareTdNodesSchema } from "../tools/layer3/compareTdNodes.js";
import { createTdNodeImpl, createTdNodeSchema } from "../tools/layer3/createTdNode.js";
import { deleteTdNodeImpl, deleteTdNodeSchema } from "../tools/layer3/deleteTdNode.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { getModuleHelpImpl, getModuleHelpSchema } from "../tools/layer3/getModuleHelp.js";
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
import {
  readParameterModesImpl,
  readParameterModesSchema,
} from "../tools/layer3/readParameterModes.js";
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
    "read_parameter_modes",
    "Read one node's parameter modes, expressions, and binding/export hints.",
    readParameterModesSchema,
    readParameterModesImpl,
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
    "compare_td_nodes",
    "Diff two nodes' parameters to see what differs.",
    compareTdNodesSchema,
    compareTdNodesImpl,
  ),
  // --- offline knowledge base (no TD required) ---
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

export const CREATIVE_LLM_TOOLS: LlmTool[] = [
  ...LLM_TOOLS,
  t(
    "get_preview",
    "Capture a TOP preview after a creative build or change.",
    getPreviewSchema,
    getPreviewImpl,
  ),
  t(
    "create_feedback_network",
    "Build a complete feedback visual network with controls and preview.",
    createFeedbackNetworkSchema,
    createFeedbackNetworkImpl,
    true,
  ),
  t(
    "create_audio_reactive",
    "Build a complete audio-reactive visual system.",
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    true,
  ),
  t(
    "create_glitch",
    "Build a glitch/RGB-tear layer over a source TOP.",
    createGlitchSchema,
    createGlitchImpl,
    true,
  ),
  t(
    "create_strobe",
    "Build a beat-syncable strobe/flash layer.",
    createStrobeSchema,
    createStrobeImpl,
    true,
  ),
  t(
    "create_palette",
    "Generate a color palette/gradient utility network.",
    createPaletteSchema,
    createPaletteImpl,
    true,
  ),
];

/** Tool exposure tiers. `safe` = inspection only; `standard` = CRUD; `creative` adds selected generators. */
export type ToolTier = "standard" | "safe" | "creative";

/** Resolve the tool set for a tier. `safe` drops every mutating tool (read-only copilot). */
export function resolveTools(tier: ToolTier = "standard"): LlmTool[] {
  if (tier === "safe") return LLM_TOOLS.filter((tool) => !tool.mutates);
  if (tier === "creative") return CREATIVE_LLM_TOOLS;
  return LLM_TOOLS;
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
