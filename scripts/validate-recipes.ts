/**
 * Validates every recipe JSON file against RecipeSchema.
 *
 *   npm run validate:recipes
 *   tsx scripts/validate-recipes.ts recipes/custom.json /path/to/recipes/
 *
 * Exits non-zero if any recipe is invalid.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RecipeSchema } from "../src/recipes/schema.js";
import { recipesDir } from "../src/utils/paths.js";

interface RecipeFileTarget {
  path: string;
  label: string;
}

function main(): void {
  const targets = process.argv.slice(2);
  const files = targets.length > 0 ? recipeFilesForTargets(targets) : recipeFilesForDefaultDir();
  if (files === undefined) {
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.warn("No recipe files found.");
    return;
  }

  let invalid = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(file.path, "utf8"));
      const result = RecipeSchema.safeParse(raw);
      if (result.success) {
        console.log(
          `✓ ${file.label} — ${result.data.nodes.length} nodes, ${result.data.connections.length} connections`,
        );
      } else {
        invalid++;
        console.error(`✗ ${file.label}`);
        for (const issue of result.error.issues) {
          console.error(`    ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
      }
    } catch (err) {
      invalid++;
      console.error(`✗ ${file.label}: ${String(err)}`);
    }
  }

  console.log(`\n${files.length - invalid}/${files.length} recipes valid.`);
  if (invalid > 0) process.exitCode = 1;
}

function recipeFilesForDefaultDir(): RecipeFileTarget[] | undefined {
  const dir = recipesDir();
  if (!existsSync(dir)) {
    console.error(`No recipes directory found at ${dir}`);
    return undefined;
  }
  return recipeFilesInDir(dir, false);
}

function recipeFilesForTargets(targets: string[]): RecipeFileTarget[] | undefined {
  const files: RecipeFileTarget[] = [];
  let invalidTarget = false;
  for (const target of targets) {
    if (!existsSync(target)) {
      invalidTarget = true;
      console.error(`No recipe file or directory found at ${target}`);
      continue;
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      files.push(...recipeFilesInDir(target, true));
      continue;
    }
    if (stat.isFile() && target.endsWith(".json")) {
      files.push({ path: target, label: target });
      continue;
    }
    invalidTarget = true;
    console.error(`Recipe target is not a JSON file or directory: ${target}`);
  }
  return invalidTarget ? undefined : files;
}

function recipeFilesInDir(dir: string, prefixDirectory: boolean): RecipeFileTarget[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      path: join(dir, file),
      label: prefixDirectory ? join(basename(dir), file) : file,
    }));
}

main();
