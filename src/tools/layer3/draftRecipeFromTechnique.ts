import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TouchDesignerTechnique, TouchDesignerTechniquePack } from "../../knowledge/types.js";
import type { Recipe, RecipeGlslUniform } from "../../recipes/schema.js";
import { RecipeSchema } from "../../recipes/schema.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const difficultySchema = z.enum(["beginner", "intermediate", "advanced"]);

export const draftRecipeFromTechniqueSchema = z.object({
  category: z.string().min(1).describe("Technique pack category id or display name."),
  technique_id: z.string().min(1).describe("Technique id or name inside the selected category."),
  id: z.string().min(1).optional().describe("Optional recipe id override."),
  name: z.string().min(1).optional().describe("Optional recipe display name override."),
  description: z.string().optional().describe("Optional recipe description override."),
  tags: z.array(z.string().min(1)).default([]).describe("Extra recipe tags to append."),
  difficulty: difficultySchema.optional().describe("Optional recipe difficulty override."),
  td_version_min: z.string().min(1).default("2023").describe("Minimum TouchDesigner version."),
  include_glsl_code: z
    .boolean()
    .default(true)
    .describe("Include technique GLSL source in the draft recipe's glsl_code block."),
  strict: z
    .boolean()
    .default(true)
    .describe("Return an error when the technique cannot be converted to a valid draft."),
});

const validationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.string()),
});

export const draftRecipeFromTechniqueOutputSchema = z.object({
  valid: z.boolean(),
  recipe: z.unknown().optional(),
  validation: validationSchema,
  source: z.object({
    category: z.string(),
    techniqueId: z.string(),
  }),
  warnings: z.array(z.string()),
  nextToolHints: z.array(z.string()),
});

type DraftRecipeFromTechniqueInput = z.input<typeof draftRecipeFromTechniqueSchema>;
type DraftRecipeFromTechniqueArgs = z.output<typeof draftRecipeFromTechniqueSchema>;

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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

function availableTechniqueIds(pack: TouchDesignerTechniquePack | undefined): string[] {
  return pack?.techniques.map((technique) => technique.id) ?? [];
}

function normalizeDifficulty(value: string | undefined): Recipe["difficulty"] {
  const key = compactKey(value ?? "");
  if (key === "beginner" || key === "basic" || key === "intro") return "beginner";
  if (key === "advanced" || key === "expert") return "advanced";
  return "intermediate";
}

function codeSnippet(technique: TouchDesignerTechnique): string | undefined {
  const snippet = technique.code?.snippet?.trim();
  if (!snippet) return undefined;
  const language = compactKey(technique.code?.language ?? "");
  const filename = compactKey(technique.code?.filename ?? "");
  const looksLikeGlsl =
    language.includes("glsl") ||
    filename.endsWith("frag") ||
    filename.endsWith("vert") ||
    /\buniform\s+(float|vec[234]|int|bool|sampler2D)\s+[A-Za-z_]/.test(snippet) ||
    /\bvoid\s+main\s*\(/.test(snippet);
  return looksLikeGlsl ? snippet : undefined;
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
      if (inferred) {
        uniforms.push({
          node: "glsl1",
          name,
          ...inferred,
        });
      }
    }
    match = re.exec(snippet);
  }
  return uniforms;
}

function buildRecipe(
  pack: TouchDesignerTechniquePack,
  technique: TouchDesignerTechnique,
  snippet: string,
  args: DraftRecipeFromTechniqueArgs,
): Recipe {
  const recipeId = args.id ?? slugify(`${pack.category}_${technique.id}_draft`);
  const recipeName = args.name ?? `${technique.name} Draft`;
  const tags = uniqueStrings([
    ...(technique.tags ?? []),
    pack.category,
    ...args.tags,
    "draft",
    "technique",
  ]);
  return {
    id: recipeId,
    name: recipeName,
    description:
      args.description ??
      technique.description ??
      `Draft recipe generated from the ${technique.name} TouchDesigner technique.`,
    tags,
    difficulty: args.difficulty ?? normalizeDifficulty(technique.difficulty),
    td_version_min: args.td_version_min,
    nodes: [
      {
        name: "glsl1",
        type: "glslTOP",
        parameters: {
          outputresolution: "custom",
          resolutionw: 1280,
          resolutionh: 720,
        },
        comment: `Drafted from technique ${pack.category}/${technique.id}.`,
      },
      {
        name: "out1",
        type: "nullTOP",
        parameters: {},
        comment: "Stable output endpoint for the drafted GLSL TOP.",
      },
    ],
    connections: [{ from: "glsl1", to: "out1", from_output: 0, to_input: 0 }],
    parameters: [],
    glsl_uniforms: inferGlslUniforms(snippet),
    ...(args.include_glsl_code ? { glsl_code: { glsl1: snippet } } : {}),
    controls: [],
    preview_description: technique.description ?? `GLSL draft based on ${technique.name}.`,
  };
}

function sourceDescriptor(
  category: string,
  technique: TouchDesignerTechnique | undefined,
): { category: string; techniqueId: string } {
  return {
    category,
    techniqueId: technique?.id ?? "",
  };
}

function unknownTechniqueResult(
  args: DraftRecipeFromTechniqueArgs,
  pack: TouchDesignerTechniquePack | undefined,
): CallToolResult {
  const suggestions = availableTechniqueIds(pack);
  return errorResult("Cannot draft recipe from unknown technique.", {
    category: args.category,
    technique_id: args.technique_id,
    suggestions,
    availableTechniqueIds: suggestions,
  });
}

function undraftableResult(
  args: DraftRecipeFromTechniqueArgs,
  pack: TouchDesignerTechniquePack,
  technique: TouchDesignerTechnique,
  message: string,
): CallToolResult {
  const payload = {
    valid: false,
    validation: { valid: false, issues: [message] },
    source: sourceDescriptor(pack.category, technique),
    warnings: [message],
    nextToolHints: ["get_technique_detail", "search_touchdesigner_knowledge"],
  };
  if (args.strict) {
    return errorResult(message, {
      category: pack.category,
      technique_id: technique.id,
      suggestions: availableTechniqueIds(pack),
    });
  }
  return structuredResult(message, payload);
}

export function draftRecipeFromTechniqueImpl(
  ctx: ToolContext,
  rawArgs: DraftRecipeFromTechniqueInput,
): CallToolResult {
  const parsed = draftRecipeFromTechniqueSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid draft_recipe_from_technique input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const pack = ctx.knowledge.getTechniquePack(args.category);
    const technique = pack
      ? ctx.knowledge.getTechnique(pack.category, args.technique_id)
      : undefined;
    if (!pack || !technique) return unknownTechniqueResult(args, pack);

    const snippet = codeSnippet(technique);
    if (!snippet) {
      return undraftableResult(
        args,
        pack,
        technique,
        `Technique ${pack.category}/${technique.id} has no recipe-draftable GLSL snippet.`,
      );
    }

    const recipe = buildRecipe(pack, technique, snippet, args);
    const validation = RecipeSchema.safeParse(recipe);
    const issues = validation.success
      ? []
      : validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    const output = {
      valid: validation.success,
      recipe,
      validation: { valid: validation.success, issues },
      source: sourceDescriptor(pack.category, technique),
      warnings: issues,
      nextToolHints: ["apply_recipe", "save_recipe_to_vault", "get_technique_detail"],
    };

    if (!validation.success && args.strict) {
      return errorResult("Drafted recipe is not RecipeSchema-valid.", output);
    }

    return structuredResult(
      validation.success
        ? `Drafted RecipeSchema-valid recipe ${recipe.id} from ${pack.category}/${technique.id}.`
        : `Drafted recipe ${recipe.id} from ${pack.category}/${technique.id}, but validation failed.`,
      output,
    );
  } catch (err) {
    return errorResult("Failed to draft recipe from technique.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerDraftRecipeFromTechnique: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "draft_recipe_from_technique",
    {
      title: "Draft recipe from technique",
      description:
        "Read-only: convert an embedded TouchDesigner technique with GLSL source into a RecipeSchema draft without writing files or touching the TD bridge.",
      inputSchema: draftRecipeFromTechniqueSchema.shape,
      outputSchema: draftRecipeFromTechniqueOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => draftRecipeFromTechniqueImpl(ctx, args),
  );
};
