import { z } from "zod";
import { normalize, parseSetlist } from "../../automation/setlistSchema.js";
import { friendlyTdError } from "../../td-client/types.js";
import type { Vault } from "../../vault/index.js";
import { buildFromRecipe, finalize } from "../layer2/orchestration.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const importSetlistSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe(
      "Setlist note: a vault-relative path, or a name resolved against the Setlists/ folder.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to build each track's recipe inside."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("Only resolve and report what would be built; do not touch TouchDesigner."),
});
type ImportSetlistArgs = z.infer<typeof importSetlistSchema>;

function resolveNotePath(vault: Vault, note: string): string | undefined {
  const candidates = note.endsWith(".md")
    ? [note, `Setlists/${note}`]
    : [`${note}.md`, `Setlists/${note}.md`, note, `Setlists/${note}`];
  for (const candidate of candidates) {
    try {
      if (vault.exists(candidate)) return candidate;
    } catch {
      // candidate escapes the vault root — skip it
    }
  }
  return undefined;
}

export async function importSetlistImpl(ctx: ToolContext, args: ImportSetlistArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const rel = resolveNotePath(vault, args.note);
  if (!rel) {
    return errorResult(`Setlist note not found: ${args.note} (looked under Setlists/ too).`);
  }

  const note = readNoteSafe(vault, rel);
  if ("error" in note) return note.error;
  const { data } = note;
  // Use the shared schema — accepts both legacy `tracks[]` and new `scenes[]`.
  const parsed = parseSetlist(data);
  if (!parsed.success) {
    return errorResult(
      `Setlist note "${rel}" has no valid \`tracks\` or \`scenes\` list in its frontmatter (expected an array of recipe ids, or {title, recipe, preset, bpm, notes} track objects, or {id, cue, recipe, preset, …} scene objects).`,
    );
  }
  // Canonicalise both shapes onto a single scene list.
  const canonical = normalize(data);

  const built: Array<{ track?: string; recipe: string; container?: string; warnings?: string[] }> =
    [];
  const skipped: Array<{ track?: string; reason: string }> = [];

  for (const scene of canonical.scenes) {
    const label = scene.title ?? scene.id ?? scene.recipe ?? scene.preset;
    if (!scene.recipe) {
      skipped.push({
        track: label,
        reason: scene.preset
          ? "preset track — recall it live, not buildable"
          : scene.cue || scene.steps
            ? "cue/scene step — recall live via setlist_runner, not buildable"
            : "no recipe id",
      });
      continue;
    }
    const recipe = ctx.recipes.get(scene.recipe);
    if (!recipe) {
      skipped.push({ track: label, reason: `recipe "${scene.recipe}" not found` });
      continue;
    }
    if (args.dry_run) {
      built.push({ track: label, recipe: recipe.id });
      continue;
    }
    try {
      const result = await buildFromRecipe(ctx, recipe, args.parent_path);
      await finalize(ctx, {
        summary: "",
        builder: result.builder,
        outputPath: result.outputPath,
        controls: result.controls,
        recipeId: recipe.id,
        capturePreviewImage: false,
      });
      built.push({
        track: label,
        recipe: recipe.id,
        container: result.builder.containerPath,
        warnings: result.builder.warnings,
      });
    } catch (err) {
      skipped.push({ track: label, reason: friendlyTdError(err) });
    }
  }

  const verb = args.dry_run ? "would build" : "built";
  return jsonResult(
    `Setlist ${rel}: ${verb} ${built.length} track(s), skipped ${skipped.length}.`,
    { path: rel, dry_run: args.dry_run, built, skipped },
  );
}

export const registerImportSetlist: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "import_setlist",
    {
      title: "Import a setlist from the vault",
      description:
        "READ a setlist note (frontmatter `tracks`: an array of recipe ids or {title, recipe, preset, bpm, notes} objects, OR the newer `scenes`: an array of {id, cue, recipe, preset, steps, …} scene objects) and build each scene's recipe — CREATING the operators in TouchDesigner under parent_path — to pre-stage a show's visuals. Recipe ids resolve against both built-in and vault recipes; preset-only and cue-only scenes are skipped (recall them live via setlist_runner instead). Use dry_run:true to validate the note without touching TD. Returns the resolved note path and the lists of built vs skipped tracks. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: importSetlistSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => importSetlistImpl(ctx, args),
  );
};
