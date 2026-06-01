import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Recipe } from "../../recipes/schema.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `generative_classics_pack` — the first canonical technique recipe pack. A
 * curated subset of built-in recipes that recreate well-known generative looks
 * (feedback tunnel, audio-reactive spectrum, noise landscape, particle field,
 * reaction-diffusion, webcam glitch). Each entry is a *technique* card — recipes
 * are pulled live from the recipe library so the pack always reflects the
 * authoritative validated copies (no duplication / no drift).
 *
 * - `list_only:true` (default) — return the technique cards + which ones the
 *   active recipe library can satisfy.
 * - `list_only:false` — also emit a portable bundle JSON at `install_path`
 *   (default: `recipes/generative_classics.pack.json`) in the same shape
 *   `import_recipe_bundle` consumes.
 *
 * Pure Node — no TouchDesigner bridge required.
 */

interface TechniqueCard {
  technique_id: string;
  title: string;
  recipe_id: string;
  category:
    | "feedback"
    | "audio-reactive"
    | "generative"
    | "particles"
    | "simulation"
    | "live-input";
  blurb: string;
  credit: string;
}

const TECHNIQUES: TechniqueCard[] = [
  {
    technique_id: "feedback_tunnel",
    title: "Feedback Tunnel",
    recipe_id: "feedback_tunnel",
    category: "feedback",
    blurb:
      "Hypnotic zoom-rotate feedback loop fed by a noise seed — the canonical TouchDesigner first patch.",
    credit: "Canonical TouchDesigner workshop pattern.",
  },
  {
    technique_id: "audio_spectrum_bars",
    title: "Audio Spectrum Bars",
    recipe_id: "audio_spectrum_bars",
    category: "audio-reactive",
    blurb:
      "Bar-graph spectrum visualizer driven by Audio Spectrum CHOP — the canonical VJ primitive.",
    credit: "Standard TouchDesigner audio-reactive starter.",
  },
  {
    technique_id: "noise_landscape",
    title: "Noise Landscape",
    recipe_id: "noise_landscape",
    category: "generative",
    blurb:
      "3D heightfield from a noise TOP — animated terrain that reads as endless evolving generative art.",
    credit: "Classic procedural-terrain pattern.",
  },
  {
    technique_id: "particle_galaxy",
    title: "Particle Galaxy",
    recipe_id: "particle_galaxy",
    category: "particles",
    blurb: "Rotating particle swarm driven by noise force fields — iconic ambient-VJ look.",
    credit: "Canonical particle-system VJ pattern.",
  },
  {
    technique_id: "reaction_diffusion",
    title: "Reaction–Diffusion",
    recipe_id: "reaction_diffusion",
    category: "simulation",
    blurb:
      "Gray–Scott reaction–diffusion in a GLSL feedback loop — organic spots/stripes that grow over time.",
    credit: "Karl Sims / Gray–Scott canonical simulation.",
  },
  {
    technique_id: "webcam_glitch",
    title: "Webcam Glitch",
    recipe_id: "webcam_glitch",
    category: "live-input",
    blurb:
      "Camera feed × displacement + level-crush + feedback — the canonical live-input glitch look.",
    credit: "Standard glitch-art pattern.",
  },
];

export const generativeClassicsPackSchema = z.object({
  list_only: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), just list the technique cards + which are available; when false, also emit the portable bundle JSON.",
    ),
  install_path: z
    .string()
    .optional()
    .describe(
      "Where to write the bundle JSON when list_only=false. Defaults to 'recipes/generative_classics.pack.json' inside the cwd.",
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe("When list_only=false: overwrite an existing bundle file at install_path."),
});
export type GenerativeClassicsPackArgs = z.infer<typeof generativeClassicsPackSchema>;

export const registerGenerativeClassicsPack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "generative_classics_pack",
    {
      title: "Generative classics recipe pack",
      description:
        "Curated technique pack of canonical generative looks (feedback tunnel, audio spectrum, noise landscape, " +
        "particle galaxy, reaction-diffusion, webcam glitch). list_only=true returns the technique cards plus the " +
        "list of recipes the active library can satisfy; list_only=false also writes a portable bundle JSON " +
        "(import_recipe_bundle-compatible) at install_path. Pure Node — no TouchDesigner bridge required.",
      inputSchema: generativeClassicsPackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => generativeClassicsPackImpl(ctx, args),
  );
};

export async function generativeClassicsPackImpl(
  ctx: ToolContext,
  args: GenerativeClassicsPackArgs,
) {
  const resolved: Array<{ card: TechniqueCard; recipe?: Recipe }> = TECHNIQUES.map((card) => ({
    card,
    recipe: ctx.recipes.get(card.recipe_id),
  }));
  const available = resolved.filter((r) => r.recipe);
  const missing = resolved.filter((r) => !r.recipe).map((r) => r.card.recipe_id);

  const techniqueSummaries = resolved.map((r) => ({
    technique_id: r.card.technique_id,
    title: r.card.title,
    recipe_id: r.card.recipe_id,
    category: r.card.category,
    blurb: r.card.blurb,
    credit: r.card.credit,
    available: Boolean(r.recipe),
  }));

  if (args.list_only) {
    return jsonResult(
      `Generative classics pack: ${available.length}/${TECHNIQUES.length} technique(s) available.`,
      {
        pack_id: "generative_classics",
        version: 1,
        total: TECHNIQUES.length,
        available: available.length,
        missing,
        techniques: techniqueSummaries,
      },
    );
  }

  // Emit bundle.
  if (available.length === 0) {
    return errorResult(
      "No generative-classics recipes are available in this library — nothing to install.",
    );
  }
  const outPath = resolve(args.install_path ?? "recipes/generative_classics.pack.json");
  if (existsSync(outPath) && !args.overwrite) {
    return errorResult(`Pack already exists at ${outPath}. Pass overwrite:true to replace it.`);
  }
  const bundle = {
    kind: "tdmcp-recipe-bundle",
    pack_id: "generative_classics",
    version: 1,
    title: "Generative Classics",
    description:
      "Canonical generative TouchDesigner looks bundled as a single technique pack: feedback tunnel, " +
      "audio spectrum, noise landscape, particle galaxy, reaction-diffusion, webcam glitch.",
    exported_at: new Date().toISOString(),
    techniques: techniqueSummaries,
    recipes: available.map((r) => r.recipe as Recipe),
    missing,
  };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Could not write pack to ${outPath}: ${reason}`);
  }
  return jsonResult(`Wrote ${available.length}-recipe generative classics pack to ${outPath}.`, {
    pack_id: "generative_classics",
    out_file: outPath,
    installed: available.length,
    missing,
    techniques: techniqueSummaries,
  });
}
