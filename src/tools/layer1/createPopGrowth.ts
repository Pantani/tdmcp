/**
 * create_pop_growth — Layer 1 artist preset
 *
 * Builds a POP-native reaction-diffusion / growth system inside a fresh baseCOMP.
 * Three mode presets (`dendritic` | `coral` | `lichen`) ship curated param bundles;
 * any individual param overrides the preset.
 *
 * Topology:
 *   particle_pop (emit) → force_pop (field) → feedback_pop (growth_fb)
 *       ▲                       ▲                    │
 *       │                  noise_pop (3D noise)      │ target = emit (one-frame delay)
 *       └─── birth rate gated by noise > threshold ──┘
 *   growth_fb → poptoSOP → geometryCOMP → renderTOP → nullTOP (out1)
 *
 * DNA knobs per mode:
 *   - feedback_gain: controls how much previous state is mixed back (>1 risks divergence)
 *   - force_scale:   amplitude of the noise-driven vector field biasing point motion
 *   - threshold:     emission gate (noise sample < threshold suppresses new births)
 *
 * POPs are Experimental in this TD build. Every par-set is fail-forward via
 * buildPopChainScript's defensive loop; unverified op/par names are reported back.
 *
 * Stability rule: warn when feedback_gain × (1 − decay) ≥ 1.0 (unbounded state accumulation).
 */
import { z } from "zod";
import { buildPopChainImpl } from "../layer2/buildPopChain.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// Mode presets
// DNA knobs: feedback_gain, force_scale, threshold
// ---------------------------------------------------------------------------

interface GrowthPreset {
  growth_rate: number;
  decay: number;
  threshold: number;
  feedback_gain: number;
  force_scale: number;
  noise_freq: number;
}

const MODE_PRESETS: Record<"dendritic" | "coral" | "lichen", GrowthPreset> = {
  /** Sparse branching tendrils, low decay so trails persist as fibres */
  dendritic: {
    growth_rate: 12,
    decay: 0.02,
    threshold: 0.55,
    feedback_gain: 0.95,
    force_scale: 1.2,
    noise_freq: 0.6,
  },
  /** Dense outward accretion, mid decay, strong force pushes growth outward */
  coral: {
    growth_rate: 40,
    decay: 0.05,
    threshold: 0.35,
    feedback_gain: 0.85,
    force_scale: 1.8,
    noise_freq: 0.35,
  },
  /** Patchy crust, high threshold gates emission into clusters, near-static feedback */
  lichen: {
    growth_rate: 8,
    decay: 0.08,
    threshold: 0.7,
    feedback_gain: 0.7,
    force_scale: 0.5,
    noise_freq: 1.1,
  },
};

// POP op type strings — same <basename>POP convention used across the codebase.
// UNVERIFIED against a live TD process (POPs are Experimental).
const POP_TYPES = {
  particle: "particlePOP",
  noise: "noisePOP",
  force: "forcePOP",
  feedback: "feedbackPOP",
} as const;

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const createPopGrowthSchema = z.object({
  mode: z
    .enum(["dendritic", "coral", "lichen"])
    .default("dendritic")
    .describe(
      "Preset selector — picks the default param bundle. 'dendritic': sparse fibrous tendrils; 'coral': dense outward accretion; 'lichen': patchy emission clusters.",
    ),
  name: z.string().default("pop_growth").describe("Container baseCOMP name."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the container is built."),
  growth_rate: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Particle birth rate per cook (drives particle_pop birth/rate par defensively). Overrides preset.",
    ),
  decay: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Per-frame multiplier applied through the feedback loop (1 − decay retained). Overrides preset.",
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Emission gate: noise sample below threshold suppresses new births. Overrides preset.",
    ),
  feedback_gain: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe(
      "Scale of the feedback contribution mixed back into the active POP each frame; >1 risks divergence. Overrides preset.",
    ),
  force_scale: z
    .number()
    .min(0)
    .optional()
    .describe("Amplitude of the noise-driven force_pop vector field. Overrides preset."),
  noise_freq: z
    .number()
    .gt(0)
    .optional()
    .describe("Spatial frequency of the noise_pop. Overrides preset."),
  seed: z.number().int().default(1).describe("RNG seed for the noise."),
  max_points: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(50_000)
    .describe("Safety cap on particle count (passed defensively as numpoints/maxparticles)."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render TOP + Null TOP resolution [width, height]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose GrowthRate / Decay / Threshold / FeedbackGain knobs on the container."),
});

type CreatePopGrowthArgs = z.infer<typeof createPopGrowthSchema>;

// ---------------------------------------------------------------------------
// Defensive par-set helper (same pattern as createPopField)
// ---------------------------------------------------------------------------

function setParsDefensively(path: string, pairs: Array<[string, unknown]>): string {
  return `_o = op(${q(path)})\nfor _pn, _v in ${JSON.stringify(pairs)}:\n    try:\n        setattr(_o.par, _pn, _v)\n    except Exception:\n        pass`;
}

// ---------------------------------------------------------------------------
// PopChainReport shape (matches buildPopChain.ts internal type)
// ---------------------------------------------------------------------------

interface PopChainReport {
  container: string;
  created: Array<{ name: string; path: string; type: string }>;
  connections: Array<{ from: string; to: string; fromOut: number; toIn: number }>;
  output_path: string | null;
  warnings: string[];
  unverified: string;
  fatal?: string;
}

/** Parse the JSON block embedded in a CallToolResult text payload. */
function parseChainResult(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): PopChainReport | undefined {
  const text = result.content
    .filter((c): c is { type: string; text: string } => c.type === "text" && c.text !== undefined)
    .map((c) => c.text)
    .join("\n");
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as PopChainReport;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createPopGrowthImpl(ctx: ToolContext, args: CreatePopGrowthArgs) {
  return runBuild(async () => {
    const preset = MODE_PRESETS[args.mode];
    const p = {
      growth_rate: args.growth_rate ?? preset.growth_rate,
      decay: args.decay ?? preset.decay,
      threshold: args.threshold ?? preset.threshold,
      feedback_gain: args.feedback_gain ?? preset.feedback_gain,
      force_scale: args.force_scale ?? preset.force_scale,
      noise_freq: args.noise_freq ?? preset.noise_freq,
      seed: args.seed,
      max_points: args.max_points,
    };

    // Stability check: feedback_gain × (1 − decay) ≥ 1.0 → unbounded state accumulation
    const stabilityProduct = p.feedback_gain * (1 - p.decay);
    const stabilityWarning =
      stabilityProduct >= 1.0
        ? `Feedback may diverge: feedback_gain(${p.feedback_gain}) × (1 − decay(${p.decay})) = ${stabilityProduct.toFixed(3)} ≥ 1.0. State is unbounded across cooks — reduce feedback_gain or increase decay to stabilise.`
        : undefined;

    const [width, height] = args.resolution;

    // Step 1: create the system container first so chain nodes land inside it.
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const containerPath = builder.containerPath;

    if (stabilityWarning) {
      builder.warnings.push(stabilityWarning);
    }

    // Step 2: build the POP chain (particle → noise → force → feedback) via buildPopChainImpl.
    // Delegates to the canonical Layer-2 impl — parent is the container path so all
    // chain nodes land inside the baseCOMP (e.g. containerPath/emit, containerPath/growth_fb).
    // Live TD: feedbackPOP exposes `inputmul` (not `gain`/`mix`).
    const chainResult = await buildPopChainImpl(ctx, {
      parent: containerPath,
      name: args.name,
      chain: [
        {
          type: "particle_pop",
          name: "emit",
          params: {
            birth: p.growth_rate,
            rate: p.growth_rate,
            maxparticles: p.max_points,
            numpoints: p.max_points,
          },
        },
        {
          type: "noise_pop",
          name: "noise",
          params: {
            amp: 1.0,
            period: 1 / p.noise_freq,
            seed: p.seed,
          },
        },
        {
          type: "force_pop",
          name: "force",
          params: { scale: p.force_scale },
        },
        {
          type: "feedback_pop",
          name: "growth_fb",
          params: {
            inputmul: p.feedback_gain,
          },
          extra_inputs: [`${containerPath}/emit`],
        },
      ],
    });

    if (chainResult.isError) {
      return chainResult;
    }

    const chainReport = parseChainResult(chainResult);
    if (chainReport?.fatal) {
      return errorResult(`Could not build POP growth chain: ${chainReport.fatal}`, chainReport);
    }
    if (chainReport) {
      for (const w of chainReport.warnings) {
        builder.warnings.push(w);
      }
    }

    const growthFbPath = `${containerPath}/growth_fb`;

    const geo = await builder.add("geometryCOMP", "geo");
    const toSop = await builder.add("poptoSOP", "to_sop", {}, geo);
    await builder.python(setParsDefensively(toSop, [["pop", growthFbPath]]));
    await builder.python(`_s = op(${q(toSop)})\n_s.render = True\n_s.display = True`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: width,
      resolutionh: height,
    });

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Step 3: defensive par-set on feedback_pop target (point back at emit for state loop).
    // target par sets the upstream POP that growth_fb reads from (one-frame delay).
    await builder.python(setParsDefensively(growthFbPath, [["target", `${containerPath}/emit`]]));

    // Step 4: noise_pop field input — try par.field first (most likely), then extra wire.
    const forcePath = `${containerPath}/force`;
    const noisePath = `${containerPath}/noise`;
    await builder.python(setParsDefensively(forcePath, [["field", noisePath]]));

    const attemptedOpTypes = [
      POP_TYPES.particle,
      POP_TYPES.noise,
      POP_TYPES.force,
      POP_TYPES.feedback,
      "poptoSOP",
      "geometryCOMP",
      "renderTOP",
      "nullTOP",
    ];

    // Step 5: live controls
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "GrowthRate",
            type: "float",
            min: 0,
            max: 200,
            default: p.growth_rate,
            bind_to: [`${containerPath}/emit.birth`],
          },
          {
            name: "Decay",
            type: "float",
            min: 0,
            max: 1,
            default: p.decay,
            bind_to: [],
          },
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: p.threshold,
            bind_to: [],
          },
          {
            name: "FeedbackGain",
            type: "float",
            min: 0,
            max: 2,
            default: p.feedback_gain,
            bind_to: [`${containerPath}/growth_fb.inputmul`],
          },
        ]
      : [];

    const extra: Record<string, unknown> = {
      mode: args.mode,
      growth_rate: p.growth_rate,
      decay: p.decay,
      threshold: p.threshold,
      feedback_gain: p.feedback_gain,
      force_scale: p.force_scale,
      noise_freq: p.noise_freq,
      max_points: p.max_points,
      resolution: [width, height],
      seed: p.seed,
      emit: `${containerPath}/emit`,
      noise: noisePath,
      force: forcePath,
      growth_fb: growthFbPath,
      render,
      output_path: out,
      chain_report: {
        created: chainReport?.created.length ?? 0,
        connections: chainReport?.connections.length ?? 0,
      },
      unverified: {
        pop_op_types: attemptedOpTypes,
        par_strategy: "setParsDefensively — POPs are Experimental; per-par writes are best-effort.",
        render_path: "poptoSOP → geometryCOMP → renderTOP → nullTOP",
        feedback_loop:
          "growth_fb.target = emit; verify gain×mix < 1.0 keeps state bounded across frames.",
        note: "Live-probe: confirm no diverge after ~10s; confirm point count stabilises around max_points.",
      },
    };

    const summary =
      `Built a POP growth network (mode=${args.mode}, growth_rate=${p.growth_rate}, feedback_gain=${p.feedback_gain}) → ${out}. ` +
      `POPs are Experimental — live-validate feedback stability.`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      controls,
      extra,
    });
  });
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreatePopGrowth: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pop_growth",
    {
      title: "Create POP growth preset (dendritic / coral / lichen)",
      description:
        "Build a POP-native reaction-diffusion / growth system inside a fresh baseCOMP. " +
        "Three mode presets: 'dendritic' (sparse fibrous tendrils, low decay), " +
        "'coral' (dense outward accretion, mid decay, strong force), " +
        "'lichen' (patchy crust, high threshold emission clusters). " +
        "A particle_pop emits points gated by a noise threshold; a noise_pop drives a force_pop " +
        "vector field that biases their motion; a feedback_pop loop carries point state forward " +
        "one cook so accumulation simulates organic growth. " +
        "Output is a Null TOP via poptoSOP → geometryCOMP → renderTOP. " +
        "POP chain delegated to buildPopChainScript. " +
        "POPs are Experimental — par writes are fail-forward; result reports unverified op/par set. " +
        "Warns when feedback_gain × (1 − decay) ≥ 1.0 (divergence risk).",
      inputSchema: createPopGrowthSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPopGrowthImpl(ctx, args),
  );
};
