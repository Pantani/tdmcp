import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerTextToRecipe: PromptRegistrar = (server) => {
  server.registerPrompt(
    "text_to_recipe",
    {
      title: "Text to recipe",
      description:
        "Author a schema-valid recipe JSON (matching RecipeSchema) from a plain-language description, ready to save under recipes/ and instantiate with apply_recipe.",
      argsSchema: {
        description: z
          .string()
          .describe(
            "The look/network to capture as a recipe, e.g. 'a hypnotic feedback tunnel over noise', 'an audio-reactive particle field', 'a kaleidoscope of warped video'.",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "A human-readable name/id hint for the recipe (default: derived from the description).",
          ),
        difficulty: z
          .string()
          .optional()
          .describe(
            "Target difficulty: beginner, intermediate, or advanced (default: intermediate).",
          ),
      },
    },
    ({ description, name, difficulty }) =>
      userPrompt(
        [
          `Author a TouchDesigner recipe JSON for: "${description}". Build it up node by node, then validate it against the schema before you finalize.`,
          "",
          "A recipe is a validated network template (see RecipeSchema in src/recipes/schema.ts). The goal is a single JSON object that can be saved to recipes/<id>.json and instantiated with apply_recipe.",
          "",
          "1. Discover real operators first: use search_operators (and the tdmcp://operators/... knowledge-base resources) to pick the operator types you need. NEVER invent operator types — every node `type` must be a real TD optype (e.g. 'noiseTOP', 'feedbackTOP', 'levelTOP', 'geometryCOMP').",
          "2. Emit a JSON object with exactly these RecipeSchema fields:",
          "   - `id` (required, a slug like 'feedback_tunnel'), `name` (required, human-readable" +
            (name ? `, suggested: "${name}"` : "") +
            "), `description`, `tags` (string array), `difficulty` (one of beginner | intermediate | advanced" +
            (difficulty ? `, requested: "${difficulty}"` : "") +
            "), `td_version_min` (e.g. '2023').",
          "   - `nodes` (REQUIRED, at least one): each `{ name, type, parameters, parent?, render?, comment? }`. `name` is unique within the recipe and is what wiring refers to. `type` is the real optype. `parameters` is an object of TD parameter name → value — set the parameter that actually exists (a Level TOP has no `gain`; use `brightness1`). Use `parent` (the name of an EARLIER COMP node, e.g. a geometryCOMP) to nest a node, and `render: true` to make a nested SOP the rendered geometry.",
          "   - `connections`: each `{ from, to, from_output?, to_input? }` referencing node NAMES (from_output/to_input default to 0). Do not wire across containers directly — route a signal out through a Select TOP/CHOP.",
          "   - `parameters` (recipe-level exposed params): each `{ name, node, param, value?, label?, min?, max?, description? }`, where `node` is a recipe node name and `param` is a TD parameter on it.",
          "   - `controls` (the live auto-exposed UI on the system container so the built system is immediately playable): each `{ name, type, label?, min?, max?, default?, menu_items?, bind_to? }`. `type` is one of float | int | toggle | menu | rgb | pulse | string. `bind_to` is an array of 'nodeName.parName' strings using recipe node NAMES (buildFromRecipe rewrites them to the real created paths). `bind_to` is not supported for rgb/pulse.",
          "   - Optional: `glsl_uniforms`, `glsl_code`, `python_code`, `preview_description`.",
          "3. Node-name → path value resolution (from CLAUDE.md): in `parameters`, a `value` that equals another node's `name` resolves to that node's real created path at build time. Use this for references like a feedbackTOP's `top` parameter pointing at the loop output node, or a Select TOP's `top`/`chop` source — set the value to the target node's NAME, not a path.",
          "4. Validate before finalizing: the JSON must satisfy RecipeSchema (the same check npm run validate:recipes runs). Confirm every node `type` is real, every connection/parameter/control references an existing node name, and `nodes` is non-empty. Then output the recipe as a single fenced ```json block.",
          "5. Finish by telling the user the file path to save it to (recipes/<id>.json) and that they can build it live with apply_recipe — and which controls are exposed for playing it.",
        ].join("\n"),
      ),
  );
};
