import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { decodePngStats } from "../../feedback/frameStats.js";
import { capturePreview } from "../../feedback/previewCapture.js";
import { topMotion } from "../../feedback/topMotion.js";
import type { Recipe } from "../../recipes/schema.js";
import {
  buildFromRecipe,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import { buildNodeStateRuntimeScript } from "../layer3/getNodeStateRuntime.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type GaOptions,
  type Genome,
  initPopulation,
  makeRng,
  nextGeneration,
  type Scored,
} from "./geneticAlgorithm.js";

const HARD_CAP = 300;

export const evolveParametersSchema = z.object({
  genes: z
    .record(z.string(), z.array(z.string()).min(1))
    .describe(
      "Categorical search space. Key = '<recipeNodeName>.<param>'; value = allowed string values (numeric params pass numeric strings, coerced at apply time).",
    ),
  build_target: z
    .string()
    .describe(
      "Recipe id (see list_recipes) each candidate is instantiated from via buildFromRecipe.",
    ),
  fitness: z
    .enum(["audio_energy", "top_luma", "top_motion"])
    .default("audio_energy")
    .describe(
      "audio_energy = Info-CHOP channel energy (default, cheapest); top_luma = mean preview luma; top_motion = frame-delta luma.",
    ),
  fitness_target_path: z
    .string()
    .describe(
      "The recipe NODE NAME (not an absolute path) whose read-back scores each candidate; resolved per candidate via builder.pathOf. CHOP for audio_energy; TOP for top_luma/top_motion.",
    ),
  population: z.coerce.number().int().min(2).max(50).default(20),
  generations: z.coerce.number().int().min(1).max(20).default(6),
  elite_fraction: z.coerce.number().min(0).max(1).default(0.3),
  crossover_rate: z.coerce.number().min(0).max(1).default(0.5),
  mutation_rate: z.coerce.number().min(0).max(1).default(0.2),
  frame_gap: z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe("top_motion only: frames between the two captures used for the delta."),
  seed: z.coerce.number().int().optional().describe("Seeds the GA RNG for reproducible runs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP the WINNING genome is rebuilt under."),
});
export type EvolveParametersArgs = z.infer<typeof evolveParametersSchema>;

const q = (value: string): string => JSON.stringify(value);

/** Numeric-looking strings become numbers; everything else passes through. */
function coerce(value: string): string | number {
  if (value.trim() === "") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/** Applies a decoded genome to a freshly built candidate (fail-forward warnings). */
async function applyGenome(
  builder: NetworkBuilder,
  genome: Genome,
  warnings: string[],
): Promise<void> {
  for (const [key, value] of Object.entries(genome)) {
    const dot = key.lastIndexOf(".");
    if (dot <= 0) {
      warnings.push(`Gene "${key}" is not '<node>.<param>'; skipped.`);
      continue;
    }
    const node = key.slice(0, dot);
    const path = builder.pathOf(node);
    if (!path) {
      warnings.push(`Gene "${key}": node "${node}" not found in the recipe; skipped.`);
      continue;
    }
    await builder.setParams(path, { [key.slice(dot + 1)]: coerce(value) });
  }
}

async function forceCook(
  ctx: ToolContext,
  outputPath: string | undefined,
  warnings: string[],
): Promise<void> {
  if (!outputPath) return;
  try {
    await ctx.client.executePythonScript(`op(${q(outputPath)}).cook(force=True)`, false);
  } catch (err) {
    warnings.push(
      `Cook-settle skipped for ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Mean of |channel value| over the target's Info CHOP channels; empty → 0. */
async function scoreAudioEnergy(ctx: ToolContext, scorePath: string): Promise<number> {
  const script = buildNodeStateRuntimeScript({ path: scorePath, include_info_chop: true });
  const exec = await ctx.client.executePythonScript(script, true);
  const report = parsePythonReport<{ info_chop?: { channels: Record<string, number> } }>(
    exec.stdout,
  );
  const values = Object.values(report.info_chop?.channels ?? {});
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += Math.abs(v);
  return sum / values.length;
}

/** Single I/O boundary for fitness; any failure folds to -Infinity + a warning. */
async function scoreCandidate(
  ctx: ToolContext,
  args: EvolveParametersArgs,
  scorePath: string,
  warnings: string[],
): Promise<number> {
  try {
    if (args.fitness === "top_luma") {
      const preview = await capturePreview(ctx.client, scorePath);
      return decodePngStats(Buffer.from(preview.base64, "base64")).meanLuma;
    }
    if (args.fitness === "top_motion") {
      const motion = await topMotion(ctx.client, scorePath, args.frame_gap);
      warnings.push(...motion.warnings);
      return motion.delta;
    }
    return await scoreAudioEnergy(ctx, scorePath);
  } catch (err) {
    warnings.push(
      `Scoring failed for ${scorePath}: ${err instanceof Error ? err.message : String(err)}; scored -Infinity.`,
    );
    return Number.NEGATIVE_INFINITY;
  }
}

async function safeDelete(ctx: ToolContext, path: string): Promise<void> {
  try {
    await ctx.client.deleteNode(path);
  } catch {
    // best-effort cleanup; a failed delete must never abort the search
  }
}

/** Build → apply genome → cook → score → delete this candidate immediately. */
async function evaluateCandidate(
  ctx: ToolContext,
  args: EvolveParametersArgs,
  recipe: Recipe,
  scratchPath: string,
  genome: Genome,
  name: string,
  warnings: string[],
): Promise<number> {
  const { builder, outputPath } = await buildFromRecipe(ctx, recipe, scratchPath, name);
  try {
    await applyGenome(builder, genome, warnings);
    await forceCook(ctx, outputPath, warnings);
    const scorePath = builder.pathOf(args.fitness_target_path);
    if (!scorePath) {
      warnings.push(
        `Candidate ${name}: fitness_target_path "${args.fitness_target_path}" did not resolve; scored -Infinity.`,
      );
      return Number.NEGATIVE_INFINITY;
    }
    return await scoreCandidate(ctx, args, scorePath, warnings);
  } finally {
    await safeDelete(ctx, builder.containerPath);
  }
}

async function rebuildWinner(
  ctx: ToolContext,
  args: EvolveParametersArgs,
  recipe: Recipe,
  best: Scored,
  evaluated: number,
  warnings: string[],
): Promise<CallToolResult> {
  const { builder, outputPath } = await buildFromRecipe(
    ctx,
    recipe,
    args.parent_path,
    "evolve_winner",
  );
  await applyGenome(builder, best.genome, warnings);
  builder.warnings.push(...warnings);
  return finalize(ctx, {
    summary: `evolve_parameters: rebuilt the winning genome (fitness ${best.fitness}) after ${evaluated} evaluations. Offline/design-time search — not a real-time controller.`,
    builder,
    outputPath,
    extra: {
      best_genome: best.genome,
      best_fitness: best.fitness,
      generations: args.generations,
      population: args.population,
      evaluated,
      fitness_mode: args.fitness,
    },
  });
}

/** Build, cook and score every candidate in one generation (kept separate to bound nesting). */
async function scoreGeneration(
  ctx: ToolContext,
  args: EvolveParametersArgs,
  recipe: Recipe,
  scratchPath: string,
  population: Genome[],
  gen: number,
  warnings: string[],
): Promise<Scored[]> {
  const scored: Scored[] = [];
  for (let i = 0; i < population.length; i++) {
    const genome = population[i];
    if (!genome) continue;
    const fitness = await evaluateCandidate(
      ctx,
      args,
      recipe,
      scratchPath,
      genome,
      `c_${gen}_${i}`,
      warnings,
    );
    scored.push({ genome, fitness });
  }
  return scored;
}

async function runEvolution(
  ctx: ToolContext,
  args: EvolveParametersArgs,
  recipe: Recipe,
): Promise<CallToolResult> {
  const rng = makeRng(args.seed);
  const opts: GaOptions = {
    population: args.population,
    eliteCount: Math.max(1, Math.round(args.population * args.elite_fraction)),
    crossoverRate: args.crossover_rate,
    mutationRate: args.mutation_rate,
  };
  const scratch = await ctx.client.createNode({
    parent_path: "/project1",
    type: "baseCOMP",
    name: "_evolve_scratch",
  });
  const warnings: string[] = [];
  let best: Scored | undefined;
  let evaluated = 0;
  try {
    let population = initPopulation(args.genes, args.population, rng);
    for (let gen = 0; gen < args.generations; gen++) {
      const scored = await scoreGeneration(
        ctx,
        args,
        recipe,
        scratch.path,
        population,
        gen,
        warnings,
      );
      evaluated += scored.length;
      for (const s of scored) if (!best || s.fitness > best.fitness) best = s;
      population = nextGeneration(scored, args.genes, opts, rng);
    }
    if (!best) {
      return errorResult("evolve_parameters: no candidate could be scored; nothing to rebuild.", {
        evaluated,
        warnings,
      });
    }
    return await rebuildWinner(ctx, args, recipe, best, evaluated, warnings);
  } finally {
    await safeDelete(ctx, scratch.path);
  }
}

export async function evolveParametersImpl(
  ctx: ToolContext,
  args: EvolveParametersArgs,
): Promise<CallToolResult> {
  if (Object.keys(args.genes).length === 0) {
    return errorResult(
      "evolve_parameters: `genes` is empty; provide at least one '<node>.<param>' search dimension.",
    );
  }
  const recipe = ctx.recipes.get(args.build_target);
  if (!recipe) {
    const ids = ctx.recipes.list().map((r) => r.id);
    return errorResult(
      `evolve_parameters: unknown build_target "${args.build_target}". Available recipe ids: ${ids.join(", ")}.`,
    );
  }
  const budget = args.population * args.generations;
  if (budget > HARD_CAP) {
    return errorResult(
      `evolve_parameters: population*generations (${budget}) exceeds the hard cap of ${HARD_CAP}. Reduce population or generations — this is an offline, minutes-long search that mutates a scratch graph.`,
    );
  }
  return runBuild(() => runEvolution(ctx, args, recipe));
}

export const registerEvolveParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "evolve_parameters",
    {
      title: "Evolve parameters (experimental, offline)",
      description:
        "EXPERIMENTAL, OFFLINE / DESIGN-TIME: search a categorical parameter genome over a recipe with a genetic algorithm, scored by a tdmcp-measurable fitness (audio_energy Info-CHOP energy / top_luma / top_motion). Each candidate is built from `build_target`, has its genome-selected params applied, cooked, scored, then its scratch subtree is deleted; across `generations` of μ+λ elitism only genomes+scores are kept, and at the end the single winning genome is rebuilt under `parent_path` with a finalize preview. A full run is minutes and mutates a scratch graph while running — it is NOT a real-time controller. Hard cap: population*generations ≤ 300. Method adopted from NEvo (arXiv 2607.02317, CC BY 4.0).",
      inputSchema: evolveParametersSchema.shape,
    },
    (args) => evolveParametersImpl(ctx, args),
  );
};
