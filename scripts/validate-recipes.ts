/**
 * Validates every recipe JSON file against RecipeSchema.
 *
 *   npm run validate:recipes
 *
 * Exits non-zero if any recipe is invalid.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecipeSchema } from "../src/recipes/schema.js";
import { recipesDir } from "../src/utils/paths.js";

function main(): void {
  const dir = recipesDir();
  if (!existsSync(dir)) {
    console.error(`No recipes directory found at ${dir}`);
    process.exitCode = 1;
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.warn(`No recipe files found in ${dir}`);
    return;
  }

  let invalid = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const result = RecipeSchema.safeParse(raw);
      if (result.success) {
        console.log(
          `✓ ${file} — ${result.data.nodes.length} nodes, ${result.data.connections.length} connections`,
        );
      } else {
        invalid++;
        console.error(`✗ ${file}`);
        for (const issue of result.error.issues) {
          console.error(`    ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
      }
    } catch (err) {
      invalid++;
      console.error(`✗ ${file}: ${String(err)}`);
    }
  }

  console.log(`\n${files.length - invalid}/${files.length} recipes valid.`);
  if (invalid > 0) process.exitCode = 1;
}

main();
