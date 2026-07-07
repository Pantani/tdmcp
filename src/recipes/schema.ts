import { z } from "zod";
import { controlSchema } from "../tools/layer2/createControlPanel.js";

export const RecipeNodeSchema = z.object({
  name: z.string().describe("Unique node name within the recipe (used for wiring)."),
  type: z.string().describe("Operator type, e.g. 'noiseTOP'."),
  parameters: z.record(z.string(), z.unknown()).default({}),
  parent: z
    .string()
    .optional()
    .describe(
      "Name of another recipe node (a COMP, e.g. a geometryCOMP) to nest this node inside of. " +
        "The parent must appear earlier in `nodes`. Used to place SOPs inside a Geometry COMP.",
    ),
  render: z
    .boolean()
    .optional()
    .describe(
      "For a SOP nested in a geometryCOMP: make this the rendered geometry. Sets the render/display " +
        "flags on it and clears its siblings, so the COMP renders this instead of its default torus.",
    ),
  comment: z.string().optional(),
});

export const RecipeConnectionSchema = z.object({
  from: z.string().describe("Source node name."),
  to: z.string().describe("Target node name."),
  from_output: z.number().int().nonnegative().default(0),
  to_input: z.number().int().nonnegative().default(0),
});

export const RecipeParameterSchema = z.object({
  name: z.string().describe("Friendly name of the exposed control."),
  node: z.string().describe("Recipe node name the parameter belongs to."),
  param: z.string().describe("TD parameter name on that node."),
  value: z.unknown().optional(),
  expr: z
    .string()
    .optional()
    .describe(
      "Python expression to drive the parameter (sets the param to expression mode). " +
        "`op('<recipeNodeName>')` references are rewritten to the real created paths at " +
        "build time. Takes precedence over `value`.",
    ),
  label: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  description: z.string().optional(),
});

/**
 * A uniform exposed by a GLSL TOP. On the GLSL TOP these live in *parameter
 * sequences*, not normal parameters, so they cannot be set the usual way: the block
 * count (`op.seq.<seq>.numBlocks`) has to be raised first, after which the per-block
 * name/value sub-parameters exist. `float`/`vec` uniforms bind through the "Vectors"
 * page (the `vec` sequence); `color` binds through the "Colors" page (the `color`
 * sequence). The "Constants" page does NOT feed a runtime `uniform float`, so it is
 * not used here. `buildFromRecipe` handles the translation; authors just declare the
 * uniform.
 */
export const RecipeGlslUniformSchema = z.object({
  node: z.string().describe("Recipe node name of the GLSL TOP that declares the uniform."),
  name: z.string().describe("Uniform name as referenced in the shader, e.g. 'uFeed'."),
  kind: z
    .enum(["float", "vec", "color"])
    .default("float")
    .describe(
      "Uniform kind: float (uniform float), vec (uniform vec2/3/4), color (rgba). " +
        "float/vec use the Vectors page; color uses the Colors page.",
    ),
  value: z
    .union([z.number(), z.array(z.number())])
    .optional()
    .describe("Initial value: a number for float, or an array of components for vec/color."),
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
  /**
   * Live controls to auto-expose on the system container: custom parameters (knobs/
   * sliders/toggles) bound to node parameters so the built system is immediately
   * playable. Each control's `bind_to` uses recipe node *names* ("nodeName.parName");
   * buildFromRecipe rewrites them to the real created paths.
   */
  controls: z.array(controlSchema).default([]),
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
