import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TdEditorFocus } from "../td-client/validators.js";
import {
  manageProjectBriefImpl,
  manageProjectBriefLlmSchema,
} from "../tools/ai/manageProjectBrief.js";
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
import {
  diagnoseHardwareEnvironmentImpl,
  diagnoseHardwareEnvironmentSchema,
} from "../tools/layer3/diagnoseHardwareEnvironment.js";
import {
  draftRecipeFromOperatorChainImpl,
  draftRecipeFromOperatorChainSchema,
} from "../tools/layer3/draftRecipeFromOperatorChain.js";
import {
  draftRecipeFromTechniqueImpl,
  draftRecipeFromTechniqueSchema,
} from "../tools/layer3/draftRecipeFromTechnique.js";
import {
  draftRecipeFromTutorialImpl,
  draftRecipeFromTutorialSchema,
} from "../tools/layer3/draftRecipeFromTutorial.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { getEditorContextImpl, getEditorContextSchema } from "../tools/layer3/getEditorContext.js";
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
import {
  getTechniqueDetailImpl,
  getTechniqueDetailSchema,
} from "../tools/layer3/getTechniqueDetail.js";
import { getTutorialImpl, getTutorialSchema } from "../tools/layer3/getTutorial.js";
import {
  planTdVersionMigrationImpl,
  planTdVersionMigrationSchema,
} from "../tools/layer3/planTdVersionMigration.js";
import { searchOperatorsImpl, searchOperatorsSchema } from "../tools/layer3/searchOperators.js";
import { searchPythonApiImpl, searchPythonApiSchema } from "../tools/layer3/searchPythonApi.js";
import {
  searchTouchDesignerKnowledgeImpl,
  searchTouchDesignerKnowledgeSchema,
} from "../tools/layer3/searchTouchDesignerKnowledge.js";
import {
  suggestOperatorChainImpl,
  suggestOperatorChainSchema,
} from "../tools/layer3/suggestOperatorChain.js";
import {
  summarizeTdErrorsImpl,
  summarizeTdErrorsSchema,
} from "../tools/layer3/summarizeTdErrors.js";
import {
  updateTdNodeParametersImpl,
  updateTdNodeParametersSchema,
} from "../tools/layer3/updateTdNodeParameters.js";
import {
  validateOperatorChainImpl,
  validateOperatorChainSchema,
} from "../tools/layer3/validateOperatorChain.js";
import type { ToolContext } from "../tools/types.js";
import type { CalibrationMode, CalibrationPolicyResolution } from "./calibration.js";
import type { OpenAITool } from "./client.js";
import { classifyFailure, type RecoveryReport, type ToolFailure } from "./failureRecovery.js";
import {
  connectMutationDescriptor,
  createMutationDescriptor,
  deleteMutationDescriptor,
  generatorMutationDescriptor,
  type MutationDescriptor,
  type MutationVerificationPlan,
  type MutationVerificationReport,
  updateParametersMutationDescriptor,
} from "./mutationVerification.js";
import { createProjectRagSearchTool } from "./projectRagSearchTool.js";

type Runner = (
  ctx: ToolContext,
  // biome-ignore lint/suspicious/noExplicitAny: args are validated by the tool's Zod schema before use.
  args: any,
  execution?: LlmToolExecution,
) => CallToolResult | Promise<CallToolResult>;

export interface LlmToolExecution {
  signal?: AbortSignal;
}

export interface LlmTool {
  /** Function name advertised to the model (mirrors the MCP tool name). */
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: Runner;
  /** Whether the tool changes the TD project (vs. read-only inspection). */
  mutates: boolean;
  /** Deterministic state contract for a successful local-copilot mutation. */
  // biome-ignore lint/suspicious/noExplicitAny: each descriptor receives its tool's validated schema output.
  mutation?: MutationDescriptor<any>;
}

const t = (
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  run: Runner,
  mutates = false,
  // biome-ignore lint/suspicious/noExplicitAny: each descriptor receives its tool's validated schema output.
  mutation?: MutationDescriptor<any>,
): LlmTool => ({
  name,
  description,
  schema,
  run,
  mutates,
  ...(mutation ? { mutation } : {}),
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
    "get_editor_context",
    "Read compact active Network Editor, selection, rollover, viewport and perform-mode context.",
    getEditorContextSchema,
    getEditorContextImpl,
  ),
  t(
    "diagnose_hardware_environment",
    "Preflight a physical installation: bridge, display/projector topology, and generated sensor/helper status DATs.",
    diagnoseHardwareEnvironmentSchema,
    diagnoseHardwareEnvironmentImpl,
  ),
  t(
    "get_td_nodes",
    "List the direct child nodes of an explicit COMP path.",
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
    "suggest_operator_chain",
    "Suggest a read-only TouchDesigner operator chain for a creative or technical goal from offline docs.",
    suggestOperatorChainSchema,
    suggestOperatorChainImpl,
  ),
  t(
    "validate_operator_chain",
    "Validate an ordered TouchDesigner operator chain against offline docs, connection hints, family filters, and version compatibility.",
    validateOperatorChainSchema,
    validateOperatorChainImpl,
  ),
  t(
    "draft_recipe_from_operator_chain",
    "Draft a RecipeSchema-valid recipe JSON from an operator chain without writing files or touching TouchDesigner.",
    draftRecipeFromOperatorChainSchema,
    draftRecipeFromOperatorChainImpl,
  ),
  t(
    "get_technique_detail",
    "Inspect embedded TouchDesigner technique packs and techniques, optionally including code/setup details (offline).",
    getTechniqueDetailSchema,
    getTechniqueDetailImpl,
  ),
  t(
    "draft_recipe_from_technique",
    "Draft a RecipeSchema-valid GLSL recipe JSON from an embedded TouchDesigner technique without writing files or touching TouchDesigner.",
    draftRecipeFromTechniqueSchema,
    draftRecipeFromTechniqueImpl,
  ),
  t(
    "get_tutorial",
    "List, search, or retrieve embedded TouchDesigner tutorials with optional full content (offline).",
    getTutorialSchema,
    getTutorialImpl,
  ),
  t(
    "draft_recipe_from_tutorial",
    "Draft a RecipeSchema-valid recipe JSON from an embedded TouchDesigner tutorial without writing files or touching TouchDesigner.",
    draftRecipeFromTutorialSchema,
    draftRecipeFromTutorialImpl,
  ),
  t(
    "search_touchdesigner_knowledge",
    "Search embedded TouchDesigner operators, versions, compatibility notes, technique packs, TD classes, and experimental notes (offline).",
    searchTouchDesignerKnowledgeSchema,
    searchTouchDesignerKnowledgeImpl,
  ),
  t(
    "plan_td_version_migration",
    "Plan a TouchDesigner version migration from offline release, operator, and Python compatibility knowledge.",
    planTdVersionMigrationSchema,
    planTdVersionMigrationImpl,
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
    createMutationDescriptor(),
  ),
  t(
    "update_td_node_parameters",
    "Set one or more parameters on an existing node.",
    updateTdNodeParametersSchema,
    updateTdNodeParametersImpl,
    true,
    updateParametersMutationDescriptor(),
  ),
  t(
    "delete_td_node",
    "Ask for a native Delete / Bypass / Keep decision, or apply an explicit bypass policy.",
    deleteTdNodeSchema,
    deleteTdNodeImpl,
    true,
    deleteMutationDescriptor(),
  ),
  t(
    "connect_nodes",
    "Wire one node's output into another node's input.",
    connectNodesSchema,
    connectNodesImpl,
    true,
    connectMutationDescriptor(),
  ),
  t(
    "manage_project_brief",
    "Read or atomically replace the bounded project-owned creative brief. Replacement requires an exact revision precondition.",
    manageProjectBriefLlmSchema,
    manageProjectBriefImpl,
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
    generatorMutationDescriptor(),
  ),
  t(
    "create_feedback_network",
    "Build a feedback-loop visual network (trails / tunnels) in one call.",
    createFeedbackNetworkSchema,
    createFeedbackNetworkImpl,
    true,
    generatorMutationDescriptor(),
  ),
  t(
    "create_audio_reactive",
    "Build an audio-reactive visual that responds to the music in one call.",
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    true,
    generatorMutationDescriptor(),
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
  /** Prevalidated runtime calibration policy. Never raises the caller's requested tier. */
  calibration?: CalibrationPolicyResolution;
  /** Enforce without a valid decision fails closed to safe; recommend preserves compatibility. */
  calibrationMode?: CalibrationMode;
}

const TOOL_TIER_RANK: Record<ToolTier, number> = { safe: 0, standard: 1, creative: 2 };

function calibratedTier(tier: ToolTier, opts: ResolveToolsOptions): ToolTier {
  if (!opts.calibration) return opts.calibrationMode === "enforce" ? "safe" : tier;
  return TOOL_TIER_RANK[opts.calibration.effectiveTier] < TOOL_TIER_RANK[tier]
    ? opts.calibration.effectiveTier
    : tier;
}

/**
 * Resolve the tool set for a tier. `safe` drops every mutating tool (read-only copilot);
 * `creative` adds the curated Layer-1 generators on top of `standard`.
 */
export function resolveTools(
  tier: ToolTier = "standard",
  opts: ResolveToolsOptions = {},
): LlmTool[] {
  const effectiveTier = calibratedTier(tier, opts);
  const base =
    effectiveTier === "safe"
      ? LLM_TOOLS.filter((tool) => !tool.mutates)
      : effectiveTier === "creative"
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
  /** Machine result from the tool; never reconstructed from prose. */
  structuredContent?: Record<string, unknown>;
  /** Bounded plan derived only from validated args + structured result. */
  mutationPlan?: MutationVerificationPlan;
  verification?: MutationVerificationReport;
  failure?: ToolFailure;
  recovery?: RecoveryReport;
  validationIssues?: Array<{ path: string; code: string; message: string }>;
  affectedPaths?: string[];
  /** Best-effort UI-only framing receipt after a successful local-copilot mutation. */
  follow?: TdEditorFocus;
  /** Bounded recovery selectors derived from validated keys only; never contains values/raw args. */
  recoveryMetadata?: { parameter?: string; searchRoot?: string };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validationIssues(error: z.ZodError): ToolOutcome["validationIssues"] {
  return error.issues.slice(0, 12).map((issue) => ({
    path: issue.path.map(String).join(".").slice(0, 160) || "arguments",
    code: issue.code.slice(0, 80),
    message: "Value does not satisfy the registered tool schema.",
  }));
}

function affectedPaths(args: unknown): string[] {
  const value = objectValue(args);
  if (!value) return [];
  const pathKeys = ["path", "parent_path", "source_path", "target_path"];
  return [
    ...new Set(
      pathKeys
        .map((key) => stringValue(value[key]))
        .filter((path): path is string => boundedTdPath(path) !== undefined),
    ),
  ].slice(0, 8);
}

function boundedTdPath(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length <= 240
    ? value
    : undefined;
}

function boundedParameter(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,159}$/.test(value)
    ? value
    : undefined;
}

function parameterFromRecord(value: unknown): string | undefined {
  const parameters = objectValue(value);
  if (!parameters) return undefined;
  const names = Object.keys(parameters);
  return names.length === 1 ? boundedParameter(names[0]) : undefined;
}

function recoveryMetadata(args: unknown): { parameter?: string; searchRoot?: string } | undefined {
  const value = objectValue(args);
  if (!value) return undefined;
  const parameter =
    boundedParameter(value.parameter) ??
    boundedParameter(value.par) ??
    parameterFromRecord(value.parameters);
  const searchRoot = boundedTdPath(value.parent_path);
  if (!parameter && !searchRoot) return undefined;
  return {
    ...(parameter ? { parameter } : {}),
    ...(searchRoot ? { searchRoot } : {}),
  };
}

function failureFromResult(result: CallToolResult, mutates: boolean): ToolFailure {
  const structured = objectValue(result.structuredContent);
  const error = objectValue(structured?.error);
  return classifyFailure({
    phase: "dispatch",
    mutates,
    code: stringValue(error?.code),
    apiCode: stringValue(error?.api_code),
    status: numberValue(error?.status),
  });
}

type PreparedToolArgs = { ok: true; data: unknown } | { ok: false; outcome: ToolOutcome };

function prepareToolArgs(tool: LlmTool, name: string, rawArgs: string): PreparedToolArgs {
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      ok: false,
      outcome: {
        ok: false,
        summary: `bad JSON args for ${name}`,
        payload: "Error: arguments were not valid JSON.",
        failure: classifyFailure({ phase: "parse", mutates: tool.mutates, code: "bad_json" }),
      },
    };
  }

  const args = tool.schema.safeParse(parsed);
  if (args.success) return { ok: true, data: args.data };
  const issues = validationIssues(args.error);
  return {
    ok: false,
    outcome: {
      ok: false,
      summary: `invalid args for ${name}`,
      payload: `Error: invalid arguments: ${JSON.stringify({ issues })}`,
      failure: classifyFailure({
        phase: "validate",
        mutates: tool.mutates,
        code: "invalid_args",
      }),
      validationIssues: issues,
    },
  };
}

type ToolRun = { ok: true; result: CallToolResult } | { ok: false; outcome: ToolOutcome };

const PARAMETER_PREFLIGHT_TOOL = "update_td_node_parameters";
const PARAMETER_PREFLIGHT_MAX_KEYS = 16;
const PARAMETER_PREFLIGHT_MAX_MENUS = 4;

type ParameterPreflightIssue = { path: string; code: string; message: string };

function parameterPreflightFailure(
  name: string,
  issues: ParameterPreflightIssue[],
  evidence: Record<string, unknown> = {},
  affectedPath?: string,
): ToolRun {
  return {
    ok: false,
    outcome: {
      ok: false,
      summary: `parameter preflight rejected for ${name}`,
      payload: `Error: parameter preflight rejected: ${JSON.stringify({ issues, ...evidence })}`,
      structuredContent: { preflight: { status: "blocked", issues, ...evidence } },
      failure: classifyFailure({
        phase: "validate",
        mutates: true,
        code: "build_parameter_preflight",
      }),
      validationIssues: issues,
      ...(affectedPath ? { affectedPaths: [affectedPath] } : {}),
    },
  };
}

async function preflightPreparedTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
  execution: LlmToolExecution,
): Promise<ToolRun | undefined> {
  if (name !== PARAMETER_PREFLIGHT_TOOL) return undefined;
  const input = objectValue(args);
  const path = boundedTdPath(input?.path);
  const parameters = objectValue(input?.parameters);
  if (!path || !parameters) return undefined;
  const keys = Object.keys(parameters);
  if (keys.length > PARAMETER_PREFLIGHT_MAX_KEYS) {
    return parameterPreflightFailure(
      name,
      [
        {
          path: "parameters",
          code: "too_many_parameters",
          message: `Parameter preflight accepts at most ${PARAMETER_PREFLIGHT_MAX_KEYS} keys.`,
        },
      ],
      { max_parameters: PARAMETER_PREFLIGHT_MAX_KEYS },
      path,
    );
  }
  if (execution.signal?.aborted) {
    return parameterPreflightFailure(
      name,
      [{ path: "arguments", code: "cancelled", message: "Parameter preflight was cancelled." }],
      {},
      path,
    );
  }

  let node: Awaited<ReturnType<ToolContext["client"]["getNode"]>>;
  try {
    node = await ctx.client.getNode(path, {
      timeoutMs: 1000,
      retryGet: false,
      signal: execution.signal,
    });
  } catch (error) {
    const failure = classifyFailure({ phase: "dispatch", mutates: true, error });
    if (failure.category !== "path_missing") return undefined;
    return {
      ok: false,
      outcome: {
        ok: false,
        summary: `parameter preflight could not resolve the target for ${name}`,
        payload: `Error: parameter preflight could not resolve the target node.`,
        failure,
        affectedPaths: [path],
        validationIssues: [
          { path: "path", code: "path_missing", message: "Target node was not found." },
        ],
      },
    };
  }

  const available = new Set(Object.keys(node.parameters));
  const unknown = keys.filter((key) => !available.has(key)).sort();
  if (unknown.length > 0) {
    return parameterPreflightFailure(
      name,
      unknown.map((key) => ({
        path: `parameters.${key}`,
        code: "unknown_parameter",
        message: "Parameter is unavailable on the connected TouchDesigner build.",
      })),
      { operator_type: node.type, invalid_parameters: unknown },
      path,
    );
  }

  const menuChoices: Record<string, string[]> = {};
  for (const key of keys
    .filter((key) => typeof parameters[key] === "string")
    .slice(0, PARAMETER_PREFLIGHT_MAX_MENUS)) {
    if (execution.signal?.aborted) {
      return parameterPreflightFailure(
        name,
        [{ path: "arguments", code: "cancelled", message: "Parameter preflight was cancelled." }],
        {},
        path,
      );
    }
    try {
      const menu = await ctx.client.getParameterMenu(path, key, {
        timeoutMs: 1000,
        retryGet: false,
        signal: execution.signal,
      });
      if (menu.names.length > 0 && !menu.names.includes(parameters[key] as string)) {
        menuChoices[key] = menu.names.slice(0, 32);
      }
    } catch {
      // A non-menu parameter, older bridge, or unavailable optional probe is not authoritative.
    }
  }
  const invalidMenus = Object.keys(menuChoices).sort();
  if (invalidMenus.length > 0) {
    return parameterPreflightFailure(
      name,
      invalidMenus.map((key) => ({
        path: `parameters.${key}`,
        code: "invalid_menu_value",
        message: "Value is not one of the live menu choices.",
      })),
      { menu_choices: menuChoices },
      path,
    );
  }
  return undefined;
}

async function runPreparedTool(
  ctx: ToolContext,
  tool: LlmTool,
  name: string,
  args: unknown,
  execution: LlmToolExecution,
): Promise<ToolRun> {
  try {
    return { ok: true, result: await tool.run(ctx, args, execution) };
  } catch (error) {
    const failure = classifyFailure({ phase: "dispatch", mutates: tool.mutates, error });
    const paths = affectedPaths(args);
    const metadata = recoveryMetadata(args);
    return {
      ok: false,
      outcome: {
        ok: false,
        summary: `tool failed: ${name}`,
        payload: `Error: ${failure.safeMessage}`,
        failure,
        ...(paths.length > 0 ? { affectedPaths: paths } : {}),
        ...(metadata ? { recoveryMetadata: metadata } : {}),
      },
    };
  }
}

function resultPayload(
  text: string,
  structuredContent: Record<string, unknown> | undefined,
): string {
  if (!structuredContent) return text;
  const separator = text ? "\n\n" : "";
  return `${text}${separator}${JSON.stringify(structuredContent)}`;
}

function resultMutationPlan(
  tool: LlmTool,
  args: unknown,
  structuredContent: Record<string, unknown> | undefined,
  ok: boolean,
): MutationVerificationPlan | undefined {
  if (!ok || !tool.mutates || !tool.mutation) return undefined;
  return tool.mutation.plan(args, structuredContent);
}

function attachOutcomeEvidence(
  outcome: ToolOutcome,
  tool: LlmTool,
  args: unknown,
  result: CallToolResult,
  structuredContent: Record<string, unknown> | undefined,
): void {
  const mutationPlan = resultMutationPlan(tool, args, structuredContent, outcome.ok);
  const paths = affectedPaths(args);
  const metadata = recoveryMetadata(args);
  if (structuredContent) outcome.structuredContent = structuredContent;
  if (mutationPlan) outcome.mutationPlan = mutationPlan;
  if (!outcome.ok) outcome.failure = failureFromResult(result, tool.mutates);
  if (paths.length > 0) outcome.affectedPaths = paths;
  if (metadata) outcome.recoveryMetadata = metadata;
}

function completedToolOutcome(
  tool: LlmTool,
  name: string,
  args: unknown,
  result: CallToolResult,
): ToolOutcome {
  const text = textOf(result);
  const structuredContent = objectValue(result.structuredContent);
  const ok = !result.isError;
  const outcome: ToolOutcome = {
    ok,
    summary: text.split("\n")[0] || name,
    payload: resultPayload(text, structuredContent),
  };
  attachOutcomeEvidence(outcome, tool, args, result, structuredContent);
  return outcome;
}

/** Validate args against the tool's schema, run it, and package the result for the model. */
export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  rawArgs: string,
  tools: LlmTool[] = LLM_TOOLS,
  execution: LlmToolExecution = {},
): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool)
    return {
      ok: false,
      summary: `unknown tool: ${name}`,
      payload: `Error: no tool named "${name}".`,
      failure: classifyFailure({ phase: "dispatch", mutates: false }),
    };
  const prepared = prepareToolArgs(tool, name, rawArgs);
  if (!prepared.ok) return prepared.outcome;
  const preflight = await preflightPreparedTool(ctx, name, prepared.data, execution);
  if (preflight && !preflight.ok) return preflight.outcome;
  const run = await runPreparedTool(ctx, tool, name, prepared.data, execution);
  if (!run.ok) return run.outcome;
  return completedToolOutcome(tool, name, prepared.data, run.result);
}
