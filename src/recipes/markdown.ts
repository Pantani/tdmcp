import { buildNote, extractFencedBlock, parseNote } from "../vault/frontmatter.js";
import { type Recipe, RecipeSchema } from "./schema.js";

/**
 * Recipes round-trip to Obsidian notes as: searchable YAML frontmatter (so the
 * vault's search and graph view see the id/name/tags) + an authoritative fenced
 * `json tdmcp-recipe` block holding the full recipe. The block is the source of
 * truth; the frontmatter is for the human and Obsidian.
 */
const RECIPE_FENCE = "json tdmcp-recipe";

/** Serializes a recipe to an Obsidian note. */
export function recipeToMarkdown(recipe: Recipe): string {
  const data = {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    tags: recipe.tags,
    difficulty: recipe.difficulty,
    type: "tdmcp-recipe",
  };
  const intro = recipe.preview_description || recipe.description || recipe.name;
  const body = `${intro}\n\n\`\`\`${RECIPE_FENCE}\n${JSON.stringify(recipe, null, 2)}\n\`\`\`\n`;
  return buildNote(data, body);
}

/** Parses a recipe note. Throws if the JSON block is missing or invalid. */
export function recipeFromMarkdown(raw: string): Recipe {
  const { body } = parseNote(raw);
  const json = extractFencedBlock(body, "json");
  if (!json) {
    throw new Error("recipe note has no ```json tdmcp-recipe code block");
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`recipe note has invalid JSON: ${String(err)}`);
  }
  const parsed = RecipeSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`recipe note failed validation (${parsed.error.issues.length} issue(s))`);
  }
  return parsed.data;
}
