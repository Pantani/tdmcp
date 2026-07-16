import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { significantTerms } from "./intent.js";
import {
  PLAN_VISUAL_LLM_TIMEOUT_MS,
  type PlanVisualCandidate,
  PlanVisualCandidateSchema,
  type PlanVisualGroundedResult,
  PlanVisualGroundedResultSchema,
  PlanVisualGroundingInputSchema,
  runGroundedPlanVisual,
} from "./planVisualGrounding.js";

export const describeProjectSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .max(2_000)
      .describe("Natural-language description of the visual you want."),
    planner: z
      .enum(["deterministic", "llm"])
      .default("deterministic")
      .describe(
        "Use the deterministic keyword planner (default), or explicitly request one bounded, grounded LLM completion with deterministic fallback.",
      ),
    root_path: PlanVisualGroundingInputSchema.shape.root_path.describe(
      "Optional TouchDesigner root used only for bounded read-only grounding in planner='llm'.",
    ),
    llm_timeout_ms: PlanVisualGroundingInputSchema.shape.llm_timeout_ms
      .default(PLAN_VISUAL_LLM_TIMEOUT_MS)
      .describe("Bound the single LLM completion to 1000-10000 ms."),
  })
  .strict();
type DescribeProjectArgs = z.input<typeof describeProjectSchema>;
type DeterministicDescribeProjectArgs = Omit<DescribeProjectArgs, "planner"> & {
  planner?: "deterministic";
};
type LlmDescribeProjectArgs = Omit<DescribeProjectArgs, "planner"> & { planner: "llm" };

export const describeProjectOutputSchema = PlanVisualCandidateSchema.extend({
  schema_version: z.literal(1),
  planner_requested: z.enum(["deterministic", "llm"]),
  planner_used: z.enum(["deterministic", "llm"]),
  fallback_reason: PlanVisualGroundedResultSchema.shape.fallback_reason,
  grounding: PlanVisualGroundedResultSchema.shape.grounding,
}).strict();
type DescribeProjectOutput = z.infer<typeof describeProjectOutputSchema>;

interface DeterministicPlan {
  candidate: PlanVisualCandidate;
  recipeName?: string;
}

function deterministicPlanVisual(ctx: ToolContext, description: string): DeterministicPlan {
  const normalized = description.toLowerCase();
  const has = (...words: string[]) => words.some((word) => normalized.includes(word));

  let recommendedTool: string;
  let interpretation: string;
  let recipeId: string | undefined;

  if (has("audio", "sound", "music", "beat", "frequenc", "spectrum", "reactive")) {
    recommendedTool = "create_audio_reactive";
    interpretation = "audio-reactive visual";
  } else if (has("particle", "swarm", "galaxy", "sparkle", "emitter")) {
    recommendedTool = "create_particle_system";
    interpretation = "particle system";
  } else if (has("reaction", "diffusion", "gray-scott", "gray scott")) {
    recommendedTool = "create_generative_art";
    interpretation = "reaction-diffusion simulation";
    recipeId = "reaction_diffusion";
  } else if (has("landscape", "terrain", "mountain", "heightfield")) {
    recommendedTool = "create_generative_art";
    interpretation = "3D noise landscape";
    recipeId = "noise_landscape";
  } else if (has("feedback", "tunnel", "echo", "trail", "kaleido")) {
    recommendedTool = "create_feedback_network";
    interpretation = "feedback network";
  } else {
    recommendedTool = "create_visual_system";
    interpretation = "generative visual";
    recipeId = ctx.recipes.findByTags(significantTerms(normalized))?.id;
  }

  const recipe = recipeId ? ctx.recipes.get(recipeId) : undefined;
  return {
    candidate: PlanVisualCandidateSchema.parse({
      interpretation,
      recommended_tool: recommendedTool,
      recipe_id: recipeId ?? null,
      operators:
        recipe?.nodes.slice(0, 12).map((node) => ({
          type: node.type,
          purpose: node.comment || `Create ${node.name}.`,
        })) ?? [],
      steps: [
        { tool: recommendedTool, goal: `Build the ${interpretation}.` },
        { tool: "get_td_node_errors", goal: "Verify the generated network has no TD errors." },
        { tool: "get_preview", goal: "Inspect the resulting visual output." },
      ],
      warnings: [],
    }),
    ...(recipe ? { recipeName: recipe.name } : {}),
  };
}

function deterministicOutput(plan: DeterministicPlan): DescribeProjectOutput {
  return describeProjectOutputSchema.parse({
    ...plan.candidate,
    schema_version: 1,
    planner_requested: "deterministic",
    planner_used: "deterministic",
    fallback_reason: null,
    grounding: {
      editor: "unavailable",
      project_brief: "unavailable",
      graph_digest: "unavailable",
      recipes_considered: plan.candidate.recipe_id ? 1 : 0,
      operators_considered: plan.candidate.operators.length,
    },
  });
}

function renderPlan(
  description: string,
  output: DescribeProjectOutput,
  recipeName?: string,
): string {
  const lines = [
    `Plan for: "${description}"`,
    "",
    `Interpreted as: ${output.interpretation}.`,
    `Recommended tool: ${output.recommended_tool}${output.recipe_id ? ` (recipe: ${output.recipe_id})` : ""}.`,
  ];

  if (output.operators.length > 0) {
    lines.push(
      "",
      output.recipe_id
        ? `Recipe "${recipeName ?? output.recipe_id}" would create:`
        : "Grounded operator outline:",
    );
    for (const operator of output.operators) {
      lines.push(`  - ${operator.type} — ${operator.purpose}`);
    }
  }

  lines.push("", "Steps:");
  for (const step of output.steps) lines.push(`  - ${step.tool}: ${step.goal}`);
  lines.push(
    "",
    `Planner: ${output.planner_used}${output.fallback_reason ? ` (fallback: ${output.fallback_reason})` : ""}.`,
    "Next: call the recommended tool, then check get_td_node_errors and get_preview.",
  );
  return lines.join("\n");
}

export function describeProjectImpl(
  ctx: ToolContext,
  rawArgs: DeterministicDescribeProjectArgs,
): CallToolResult;
export function describeProjectImpl(
  ctx: ToolContext,
  rawArgs: LlmDescribeProjectArgs,
): Promise<CallToolResult>;
export function describeProjectImpl(
  ctx: ToolContext,
  rawArgs: DescribeProjectArgs,
): CallToolResult | Promise<CallToolResult>;
export function describeProjectImpl(ctx: ToolContext, rawArgs: DescribeProjectArgs) {
  const args = describeProjectSchema.parse(rawArgs);
  const deterministic = deterministicPlanVisual(ctx, args.description);
  if (args.planner === "deterministic") {
    const output = deterministicOutput(deterministic);
    return structuredResult(renderPlan(args.description, output, deterministic.recipeName), output);
  }

  return runGroundedPlanVisual(
    ctx,
    {
      description: args.description,
      ...(args.root_path === undefined ? {} : { root_path: args.root_path }),
      llm_timeout_ms: args.llm_timeout_ms,
    },
    deterministic.candidate,
  ).then((grounded: PlanVisualGroundedResult) => {
    const output = describeProjectOutputSchema.parse(grounded);
    return structuredResult(renderPlan(args.description, output), output);
  });
}

export const registerDescribeProject: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "plan_visual",
    {
      title: "Plan a visual from a description",
      description:
        "Turn a visual description into a read-only build plan. The deterministic planner remains the default and creates nothing. Set planner='llm' to opt into one bounded completion grounded in compact editor/project/recipe/operator evidence; every suggested tool, recipe and operator is validated, and any unavailable or invalid LLM path falls back deterministically without mutating TouchDesigner.",
      inputSchema: describeProjectSchema.shape,
      outputSchema: describeProjectOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => describeProjectImpl(ctx, args),
  );
};
