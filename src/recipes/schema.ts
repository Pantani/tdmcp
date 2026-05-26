import { z } from "zod";

export const RecipeNodeSchema = z.object({
  name: z.string().describe("Unique node name within the recipe (used for wiring)."),
  type: z.string().describe("Operator type, e.g. 'noiseTOP'."),
  parameters: z.record(z.string(), z.unknown()).default({}),
  comment: z.string().optional(),
});
export type RecipeNode = z.infer<typeof RecipeNodeSchema>;

export const RecipeConnectionSchema = z.object({
  from: z.string().describe("Source node name."),
  to: z.string().describe("Target node name."),
  from_output: z.number().int().nonnegative().default(0),
  to_input: z.number().int().nonnegative().default(0),
});
export type RecipeConnection = z.infer<typeof RecipeConnectionSchema>;

export const RecipeParameterSchema = z.object({
  name: z.string().describe("Friendly name of the exposed control."),
  node: z.string().describe("Recipe node name the parameter belongs to."),
  param: z.string().describe("TD parameter name on that node."),
  value: z.unknown().optional(),
  label: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  description: z.string().optional(),
});
export type RecipeParameter = z.infer<typeof RecipeParameterSchema>;

/**
 * A uniform exposed by a GLSL TOP. On the GLSL TOP these live in *parameter
 * sequences* (the "Vectors" page), so they cannot be set like a normal parameter —
 * the block count (`op.seq.<kind>.numBlocks`) has to be raised first, after which the
 * per-block `<kind><i>name`/value sub-parameters exist. `buildFromRecipe` handles
 * that translation; recipe authors just declare the uniform here.
 */
export const RecipeGlslUniformSchema = z.object({
  node: z.string().describe("Recipe node name of the GLSL TOP that declares the uniform."),
  name: z.string().describe("Uniform name as referenced in the shader, e.g. 'uFeed'."),
  kind: z
    .enum(["const", "vec", "color"])
    .default("const")
    .describe("GLSL TOP uniform kind: const (float), vec (vec4), color (rgba)."),
  value: z
    .union([z.number(), z.array(z.number())])
    .optional()
    .describe("Initial value: a number for const, or an array for vec/color components."),
  label: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  description: z.string().optional(),
});
export type RecipeGlslUniform = z.infer<typeof RecipeGlslUniformSchema>;

export const RecipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  td_version_min: z.string().default("2023"),
  nodes: z.array(RecipeNodeSchema).min(1),
  connections: z.array(RecipeConnectionSchema).default([]),
  parameters: z.array(RecipeParameterSchema).default([]),
  glsl_uniforms: z.array(RecipeGlslUniformSchema).default([]),
  glsl_code: z.record(z.string(), z.string()).optional(),
  python_code: z.record(z.string(), z.string()).optional(),
  preview_description: z.string().default(""),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export interface RecipeSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  difficulty: Recipe["difficulty"];
}
