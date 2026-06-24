import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OperatorSummary, Tutorial, TutorialSummary } from "../../knowledge/types.js";
import type { Recipe, RecipeGlslUniform } from "../../recipes/schema.js";
import { RecipeSchema } from "../../recipes/schema.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  flattenTutorialContent,
  tutorialCodeBlocks,
  tutorialTextFields,
} from "./tutorialContent.js";
import { validateOperatorChainImpl } from "./validateOperatorChain.js";

const difficultySchema = z.enum(["beginner", "intermediate", "advanced"]);

export const draftRecipeFromTutorialSchema = z.object({
  name: z.string().trim().min(1).describe("Tutorial id or display name to draft from."),
  id: z.string().trim().min(1).optional().describe("Optional recipe id override."),
  recipe_name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional recipe display name override."),
  description: z.string().optional().describe("Optional recipe description override."),
  family: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional operator family/category constraint, e.g. TOP, CHOP, SOP, DAT."),
  max_steps: z.coerce
    .number()
    .int()
    .positive()
    .max(8)
    .default(5)
    .describe("Maximum operator references to keep from the tutorial."),
  tags: z.array(z.string().trim().min(1)).default([]).describe("Extra recipe tags to append."),
  difficulty: difficultySchema.default("intermediate"),
  td_version_min: z.string().trim().min(1).default("2023"),
  strict: z
    .boolean()
    .default(true)
    .describe("Return an isError result when no RecipeSchema-valid draft can be produced."),
  include_glsl_code: z
    .boolean()
    .default(true)
    .describe(
      "Include a complete GLSL pixel-shader code block when a GLSL TOP tutorial provides one.",
    ),
});

type DraftRecipeFromTutorialInput = z.input<typeof draftRecipeFromTutorialSchema>;
type DraftRecipeFromTutorialArgs = z.output<typeof draftRecipeFromTutorialSchema>;

const chainIssueSchema = z.object({
  type: z.string(),
  severity: z.string().optional(),
  message: z.string(),
});

export const draftRecipeFromTutorialOutputSchema = z.object({
  valid: z.boolean(),
  draftable: z.boolean(),
  recipe: z.unknown().optional(),
  validation: z.object({
    valid: z.boolean(),
    issues: z.array(z.string()),
  }),
  tutorial: z.object({
    id: z.string(),
    name: z.string(),
  }),
  extractedOperators: z.array(z.string()),
  chainReport: z
    .object({
      valid: z.boolean(),
      issues: z.array(chainIssueSchema).optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
  warnings: z.array(z.string()),
  unsupportedReasons: z.array(z.string()),
  nextToolHints: z.array(z.string()),
});

type DraftRecipeFromTutorialOutput = z.output<typeof draftRecipeFromTutorialOutputSchema>;

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function summaryMatches(summary: TutorialSummary, name: string): boolean {
  const key = compactKey(name);
  return compactKey(summary.id) === key || compactKey(summary.name) === key;
}

function resolveTutorial(
  ctx: ToolContext,
  summaries: TutorialSummary[],
  name: string,
): Tutorial | undefined {
  const direct = ctx.knowledge.getTutorial(name);
  if (direct) return direct;
  const summary = summaries.find((entry) => summaryMatches(entry, name));
  return summary ? ctx.knowledge.getTutorial(summary.id) : undefined;
}

function operatorAliases(summary: OperatorSummary): string[] {
  return uniqueStrings([summary.displayName, summary.name, summary.slug]);
}

function extractOperators(
  ctx: ToolContext,
  tutorial: Tutorial,
  args: DraftRecipeFromTutorialArgs,
): string[] {
  const text = tutorialTextFields(tutorial);
  const textKey = compactKey(text);
  const matches = ctx.knowledge
    .listOperators(args.family)
    .flatMap((operator) =>
      operatorAliases(operator).map((alias) => ({
        alias,
        displayName: operator.displayName,
        index: textKey.indexOf(compactKey(alias)),
      })),
    )
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index || b.alias.length - a.alias.length);

  const operators: string[] = [];
  for (const match of matches) {
    if (operators.some((operator) => compactKey(operator) === compactKey(match.displayName))) {
      continue;
    }
    operators.push(match.displayName);
    if (operators.length >= args.max_steps) break;
  }
  return operators;
}

function looksLikeCompletePixelShader(code: string): boolean {
  return (
    /\bvoid\s+main\s*\(/.test(code) &&
    /\bout\s+vec4\s+[A-Za-z_][A-Za-z0-9_]*/.test(code) &&
    /\bTDOutputSwizzle\s*\(/.test(code)
  );
}

function bestGlslSnippet(tutorial: Tutorial): string | undefined {
  return tutorialCodeBlocks(tutorial.content).find((block) => {
    const language = compactKey(block.language);
    return (
      (language.includes("glsl") || looksLikeCompletePixelShader(block.text)) &&
      looksLikeCompletePixelShader(block.text)
    );
  })?.text;
}

function inferUniformValue(type: string): Pick<RecipeGlslUniform, "kind" | "value"> | undefined {
  switch (type) {
    case "float":
    case "int":
    case "bool":
      return { kind: "float", value: 0 };
    case "vec2":
      return { kind: "vec", value: [0, 0] };
    case "vec3":
      return { kind: "vec", value: [0, 0, 0] };
    case "vec4":
      return { kind: "vec", value: [0, 0, 0, 1] };
    default:
      return undefined;
  }
}

function inferGlslUniforms(snippet: string): RecipeGlslUniform[] {
  const uniforms: RecipeGlslUniform[] = [];
  const seen = new Set<string>();
  const re = /\buniform\s+(float|vec2|vec3|vec4|int|bool|sampler2D)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match = re.exec(snippet);
  while (match !== null) {
    const [, rawType, name] = match;
    if (rawType && name && !seen.has(name)) {
      seen.add(name);
      const inferred = inferUniformValue(rawType);
      if (inferred) uniforms.push({ node: "glsl1", name, ...inferred });
    }
    match = re.exec(snippet);
  }
  return uniforms;
}

function operatorType(operator: string): string {
  const family = operator.match(/\b(TOP|CHOP|SOP|DAT|COMP|MAT|POP)\b/i)?.[1]?.toUpperCase() ?? "";
  const base = operator
    .replace(new RegExp(`\\s+${family}$`, "i"), "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
  return `${base || "node"}${family}`;
}

function nodeNameFor(operator: string, counts: Map<string, number>): string {
  const type = operatorType(operator);
  const family = type.match(/(TOP|CHOP|SOP|DAT|COMP|MAT|POP)$/)?.[1] ?? "";
  const base = type.slice(0, family ? -family.length : undefined) || "node";
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return `${base}${count}`;
}

function buildRecipe(
  tutorial: Tutorial,
  operators: string[],
  args: DraftRecipeFromTutorialArgs,
  glslSnippet: string | undefined,
): Recipe {
  const counts = new Map<string, number>();
  const nodes = operators.map((operator) => ({
    name: nodeNameFor(operator, counts),
    type: operatorType(operator),
    parameters: {},
    comment: `Drafted from tutorial ${tutorial.id}.`,
  }));
  const tags = uniqueStrings([...(tutorial.tags ?? []), ...args.tags, "draft", "tutorial"]);
  const recipe: Recipe = {
    id: args.id ?? slugify(`${tutorial.id}_draft`),
    name: args.recipe_name ?? `${tutorial.name} Draft`,
    description:
      args.description ??
      tutorial.summary ??
      tutorial.description ??
      `Draft recipe generated from ${tutorial.name}.`,
    tags,
    difficulty: args.difficulty,
    td_version_min: args.td_version_min,
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      from: nodes[index]?.name ?? "",
      to: node.name,
      from_output: 0,
      to_input: 0,
    })),
    parameters: [],
    glsl_uniforms: glslSnippet ? inferGlslUniforms(glslSnippet) : [],
    controls: [],
    preview_description: tutorial.summary ?? tutorial.description ?? `Draft from ${tutorial.name}.`,
  };
  if (args.include_glsl_code && glslSnippet && nodes.some((node) => node.type === "glslTOP")) {
    recipe.glsl_code = { glsl1: glslSnippet };
  }
  return recipe;
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function notDraftable(
  args: DraftRecipeFromTutorialArgs,
  tutorial: Tutorial,
  operators: string[],
  reasons: string[],
  warnings: string[] = [],
): CallToolResult {
  const output: DraftRecipeFromTutorialOutput = {
    valid: false,
    draftable: false,
    validation: { valid: false, issues: reasons },
    tutorial: { id: tutorial.id, name: tutorial.name },
    extractedOperators: operators,
    warnings,
    unsupportedReasons: reasons,
    nextToolHints: [
      "get_tutorial",
      "search_touchdesigner_knowledge",
      "draft_recipe_from_operator_chain",
    ],
  };
  const summary = `Tutorial ${tutorial.id} does not contain enough operator references for a RecipeSchema draft.`;
  if (args.strict) return errorResult(summary, output);
  return structuredResult(summary, output);
}

export function draftRecipeFromTutorialImpl(
  ctx: ToolContext,
  rawArgs: DraftRecipeFromTutorialInput,
): CallToolResult {
  const parsed = draftRecipeFromTutorialSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid draft_recipe_from_tutorial input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const summaries = ctx.knowledge.listTutorials();
    const tutorial = resolveTutorial(ctx, summaries, args.name);
    if (!tutorial) {
      return errorResult(`Unknown tutorial "${args.name}".`, {
        name: args.name,
        suggestions: summaries.flatMap((entry) => [entry.id, entry.name]).slice(0, 20),
      });
    }

    const operators = extractOperators(ctx, tutorial, args);
    if (operators.length < 2) {
      return notDraftable(args, tutorial, operators, [
        "Tutorial does not contain enough operator references for a conservative chain.",
      ]);
    }

    const chainValidation = validateOperatorChainImpl(ctx, {
      chain: operators,
      family: args.family,
      target_version: args.td_version_min,
    });
    const chainReport = chainValidation.structuredContent as
      | {
          valid?: boolean;
          issues?: Array<{ type: string; severity?: string; message: string }>;
          warnings?: string[];
        }
      | undefined;
    if (!chainReport?.valid) {
      const reasons = chainReport?.issues?.map((issue) => issue.message) ?? [
        "Extracted operator chain did not validate.",
      ];
      return notDraftable(args, tutorial, operators, reasons, [textOf(chainValidation)]);
    }

    const flattened = flattenTutorialContent(tutorial.content) ?? "";
    const glslSnippet = args.include_glsl_code ? bestGlslSnippet(tutorial) : undefined;
    const warnings: string[] = [];
    if (operators.some((operator) => compactKey(operator) === "glsltop") && !glslSnippet) {
      warnings.push("Tutorial mentions GLSL TOP but no complete pixel-shader block was extracted.");
    }
    if (glslSnippet && /\bsTD2DInputs\s*\[/.test(glslSnippet) && !/input\s+TOP/i.test(flattened)) {
      warnings.push(
        "Extracted GLSL samples sTD2DInputs, but no input TOP source was inferred; validate manually before applying.",
      );
    }

    const recipeCandidate = buildRecipe(tutorial, operators, args, glslSnippet);
    const validation = RecipeSchema.safeParse(recipeCandidate);
    const issues = validation.success ? [] : validationIssues(validation.error);
    const output: DraftRecipeFromTutorialOutput = {
      valid: validation.success,
      draftable: validation.success,
      ...(validation.success ? { recipe: validation.data } : {}),
      validation: { valid: validation.success, issues },
      tutorial: { id: tutorial.id, name: tutorial.name },
      extractedOperators: operators,
      chainReport: {
        valid: Boolean(chainReport.valid),
        issues: chainReport.issues,
        warnings: chainReport.warnings,
      },
      warnings,
      unsupportedReasons: validation.success ? [] : issues,
      nextToolHints: [
        "get_tutorial",
        "draft_recipe_from_operator_chain",
        ...(validation.success ? ["apply_recipe", "save_recipe_to_vault"] : []),
      ],
    };

    if (!validation.success && args.strict) {
      return errorResult("Drafted tutorial recipe is not RecipeSchema-valid.", output);
    }

    return structuredResult(
      validation.success
        ? `Drafted RecipeSchema-valid recipe "${validation.data.id}" from tutorial ${tutorial.id}.`
        : `Drafted tutorial recipe from ${tutorial.id}, but validation failed.`,
      output,
    );
  } catch (err) {
    return errorResult("Failed to draft recipe from tutorial.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerDraftRecipeFromTutorial: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "draft_recipe_from_tutorial",
    {
      title: "Draft recipe from tutorial",
      description:
        "Read-only: extract a conservative operator chain from an embedded TouchDesigner tutorial and draft a RecipeSchema JSON without writing files or touching the TD bridge.",
      inputSchema: draftRecipeFromTutorialSchema.shape,
      outputSchema: draftRecipeFromTutorialOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => draftRecipeFromTutorialImpl(ctx, args),
  );
};
