import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { downloadToFile } from "../../packages/github.js";
import { type Recipe, RecipeSchema } from "../../recipes/schema.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// import_recipe_from_url
//
// URL-fetch front door for recipe import. A sibling of `import_recipe_bundle`
// (which reads a local file); this fetches the JSON from a URL/git-raw link
// first, then validates + writes it exactly like the local importer (same
// RecipeSchema validation, filename derivation, overwrite + duplicate-target
// guards).
//
// Security: the fetch is delegated to the hardened downloader `downloadToFile`
// (src/packages/github.ts), which enforces HTTPS-only, a host allowlist
// (github.com / api.github.com / codeload.github.com / *.githubusercontent.com,
// which covers raw.githubusercontent.com and gist's raw host), per-hop redirect
// re-validation, and a byte cap. We do NOT hand-roll fetch, so this tool
// inherits those SSRF/host/size protections. We also reject non-HTTPS URLs up
// front (before any network call) as defense in depth.
// ---------------------------------------------------------------------------

export const importRecipeFromUrlSchema = z.object({
  url: z
    .string()
    .url()
    .describe("HTTPS URL of a recipe or recipe-bundle JSON (e.g. a git-raw link)."),
  out_dir: z.string().describe("Recipe directory to write imported recipes into."),
  overwrite: z.boolean().default(false).describe("Overwrite existing recipe files."),
  max_bytes: z.coerce
    .number()
    .int()
    .positive()
    .default(1048576)
    .describe("Maximum download size in bytes (default 1 MiB)."),
});

export type ImportRecipeFromUrlArgs = z.infer<typeof importRecipeFromUrlSchema>;

interface ImportRecipeFromUrlResult {
  url: string;
  written: string[];
  skipped: string[];
  count: number;
}

/**
 * Indirection so the network hop can be overridden in offline tests. Production
 * always routes through the hardened {@link downloadToFile}; the byte cap is
 * enforced both by the limit we pass here and by the downloader itself.
 */
export const downloaders = {
  download: (url: string, dest: string, maxBytes: number): Promise<void> =>
    downloadToFile(url, dest, { maxBytes }),
};

/** Same filename derivation as importRecipeBundleImpl: sanitize the recipe id. */
function recipeFileName(recipe: Recipe): string {
  return `${recipe.id.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`;
}

/** Write pretty JSON, creating parent dirs (mirrors index.ts writeJson). */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function importRecipeFromUrlImpl(_ctx: ToolContext, args: ImportRecipeFromUrlArgs) {
  const parsed = importRecipeFromUrlSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { url, out_dir, overwrite, max_bytes } = parsed.data;

  // Defense in depth: refuse non-HTTPS before any network call. The hardened
  // downloader also enforces this, but we fail fast and never touch the network.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errorResult(`Invalid URL: ${url}`);
  }
  if (parsedUrl.protocol !== "https:") {
    return errorResult(`Refusing non-HTTPS URL: ${url}`);
  }

  // Download to a temp file (size-capped). Any host/size/redirect violation
  // surfaces here as a thrown error, which we convert to a friendly result.
  const workDir = mkdtempSync(join(tmpdir(), "tdmcp-recipe-url-"));
  const tempFile = join(workDir, "recipe.json");
  let raw: string;
  try {
    await downloaders.download(url, tempFile, max_bytes);
    raw = readFileSync(tempFile, "utf8");
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    return errorResult(
      `Failed to download recipe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  rmSync(workDir, { recursive: true, force: true });

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return errorResult(
      `Downloaded content is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Accept either a single recipe or a bundle { recipes: [...] }.
  let candidates: unknown[];
  if (data && typeof data === "object" && "recipes" in (data as Record<string, unknown>)) {
    const bundleRecipes = (data as Record<string, unknown>).recipes;
    if (!Array.isArray(bundleRecipes)) {
      return errorResult("Bundle.recipes must be an array.");
    }
    candidates = bundleRecipes;
  } else {
    candidates = [data];
  }

  if (candidates.length === 0) {
    return errorResult("No recipes found in downloaded content.");
  }

  // Validate every recipe before writing anything.
  const recipes: Recipe[] = [];
  for (const candidate of candidates) {
    const recipeParsed = RecipeSchema.safeParse(candidate);
    if (!recipeParsed.success) {
      return errorResult(`Invalid recipe in download: ${recipeParsed.error.message}`);
    }
    recipes.push(recipeParsed.data);
  }

  // Duplicate-target guard (mirrors importRecipeBundleImpl).
  const targets = recipes.map((recipe) => ({ recipe, out: join(out_dir, recipeFileName(recipe)) }));
  const seenTargets = new Map<string, string>();
  for (const { recipe, out } of targets) {
    const existingId = seenTargets.get(out);
    if (existingId) {
      return errorResult(`Duplicate recipe target path: ${out} (${existingId} and ${recipe.id}).`);
    }
    seenTargets.set(out, recipe.id);
  }

  // Overwrite guard (mirrors importRecipeBundleImpl): refuse to clobber any
  // existing recipe unless overwrite is set, before writing a single file.
  const skipped: string[] = [];
  if (!overwrite) {
    for (const { out } of targets) {
      if (existsSync(out)) {
        return errorResult(`Recipe already exists: ${out}. Pass overwrite:true to replace it.`);
      }
    }
  }

  const written: string[] = [];
  for (const { recipe, out } of targets) {
    writeJson(out, recipe);
    written.push(out);
  }

  return jsonResult(`Imported ${written.length} recipe(s) into ${out_dir} from ${url}.`, {
    url,
    written,
    skipped,
    count: written.length,
  } satisfies ImportRecipeFromUrlResult);
}

export const registerImportRecipeFromUrl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "import_recipe_from_url",
    {
      title: "Import recipe from URL",
      description:
        "Fetch, validate, and import a recipe or recipe-bundle JSON from an HTTPS URL into a local recipes directory (host-allowlisted, size-capped).",
      inputSchema: importRecipeFromUrlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => importRecipeFromUrlImpl(ctx, args),
  );
};
