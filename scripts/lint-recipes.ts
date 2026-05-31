/**
 * Lints every recipe JSON file against the semantic rules in
 * src/tools/layer3/lintRecipeLibrary.ts. Goes beyond `validate-recipes`
 * (which only runs RecipeSchema.safeParse) by checking cross-references,
 * unknown operator types, dangling connections, and library hygiene.
 *
 *   npm run lint:recipes
 *   npm run lint:recipes -- --recipe foo
 *   npm run lint:recipes -- --rules unknown_operator,dangling_connection
 *   npm run lint:recipes -- --fail-on warn
 *
 * Exits non-zero when findings at-or-above the --fail-on severity are present.
 */
import { KnowledgeBase } from "../src/knowledge/index.js";
import {
  type LintRecipeLibraryArgs,
  loadRecipesForLint,
  runLint,
} from "../src/tools/layer3/lintRecipeLibrary.js";

function parseArgs(argv: string[]): LintRecipeLibraryArgs {
  const out: LintRecipeLibraryArgs = {
    severity: "warn",
    fail_on: "error",
  } as LintRecipeLibraryArgs;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--recipe" && argv[i + 1]) {
      out.recipe_id = argv[++i];
    } else if (a === "--rules" && argv[i + 1]) {
      const list = argv[++i] ?? "";
      out.rules = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as LintRecipeLibraryArgs["rules"];
    } else if (a === "--severity" && argv[i + 1]) {
      out.severity = argv[++i] as LintRecipeLibraryArgs["severity"];
    } else if (a === "--fail-on" && argv[i + 1]) {
      out.fail_on = argv[++i] as LintRecipeLibraryArgs["fail_on"];
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadRecipesForLint({});
  if (sources.length === 0) {
    console.warn("No recipe files found.");
    return;
  }
  const knowledge = new KnowledgeBase();
  const report = runLint(sources, knowledge, args);

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const rec of report.recipes) {
    const all = [
      ...rec.errors.map((f) => ({ sev: "error", f })),
      ...rec.warnings.map((f) => ({ sev: "warn ", f })),
      ...rec.info.map((f) => ({ sev: "info ", f })),
    ];
    if (all.length === 0) {
      console.log(`${rec.file}  ✓`);
      continue;
    }
    console.log(rec.file);
    for (const item of all) {
      console.log(`  ${item.sev}  ${item.f.rule.padEnd(22)} ${item.f.path}: ${item.f.message}`);
    }
    totalErrors += rec.errors.length;
    totalWarnings += rec.warnings.length;
  }
  console.log("─".repeat(45));
  console.log(
    `${report.summary.totalRecipes} recipes · ${totalErrors} error(s) · ${totalWarnings} warning(s)`,
  );

  const hasError = totalErrors > 0;
  const hasWarn = totalWarnings > 0;
  const shouldFail =
    args.fail_on === "never" ? false : args.fail_on === "warn" ? hasError || hasWarn : hasError;
  if (shouldFail) process.exitCode = 1;
}

main();
