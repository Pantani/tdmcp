import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

// NOTE: we deliberately expose lift/gamma/gain as three separate float controls
// per channel (LiftR/LiftG/LiftB, …) instead of a single `rgb` swatch. The shared
// control-panel builder ignores `bind_to` on `rgb`-typed controls (see
// createControlPanel.ts — "bind_to ignored for '%s' (a %s control cannot drive a
// single parameter)"), so an RGB swatch would be display-only and changing it
// would not move the underlying Level TOP's R/G/B multipliers. Three floats per
// channel are individually bindable and drive the grade live.

// A 0..1 RGB triple, used for each colour-wheel tint. We model lift/gamma/gain
// (shadows / midtones / highlights) as three separately-tinted Level TOPs run
// in series: each stage shifts its target tonal range toward the chosen colour
// by multiplying R/G/B individually. `[1,1,1]` is neutral (no tint).
const rgb01 = (r: number, g: number, b: number) =>
  z
    .tuple([
      z.coerce.number().min(0).max(2),
      z.coerce.number().min(0).max(2),
      z.coerce.number().min(0).max(2),
    ])
    .default([r, g, b]);

export const createColorWheelsSchema = z.object({
  source_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of the source TOP to grade. Pulled in via a Select TOP (TD wires don't cross containers). If omitted, a Ramp TOP test gradient is graded so the chain still builds and previews without any external source.",
    ),
  lift: rgb01(1, 1, 1).describe(
    "Shadow tint (lift wheel) as [r,g,b] in 0..2. Multiplies R/G/B on a Level TOP whose `gamma1` is biased high (~1.4) so the multiply lands in the darker tonal range. [1,1,1] = neutral.",
  ),
  gamma: rgb01(1, 1, 1).describe(
    "Midtone tint (gamma wheel) as [r,g,b] in 0..2. Multiplies R/G/B on a mid-biased Level TOP. [1,1,1] = neutral.",
  ),
  gain: rgb01(1, 1, 1).describe(
    "Highlight tint (gain wheel) as [r,g,b] in 0..2. Multiplies R/G/B on a Level TOP biased into highlights via `brightness1`. [1,1,1] = neutral.",
  ),
  offset: z.coerce
    .number()
    .min(-1)
    .max(1)
    .default(0)
    .describe(
      "Global black-level offset (-1..1). Positive lifts the black point (faded/filmic look); negative crushes. Drives the master Level TOP's `blacklevel`.",
    ),
  saturation: z.coerce
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "Master saturation multiplier (1 = unchanged, 0 = greyscale). Drives the trailing HSV Adjust TOP's `saturationmult`.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live per-channel float knobs LiftR/G/B, GammaR/G/B, GainR/G/B (0..2, 1 = neutral) plus Offset and Saturation. Three floats per wheel — instead of a single RGB swatch — because the shared control-panel builder cannot bind an `rgb` control to a parameter, so the swatch would be display-only.",
    ),
  base_name: z
    .string()
    .optional()
    .describe(
      "Optional base name for the container (defaults to 'color_wheels'). Final container path is `<parent_path>/<base_name>` with TD's auto-suffix.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the colour-wheels container is created (default '/project1')."),
});
export type CreateColorWheelsArgs = z.infer<typeof createColorWheelsSchema>;

// Helper: build three bindable float controls (R/G/B channel multipliers) for a
// given wheel stage. Each control drives one of the Level TOP's redmult1 /
// greenmult1 / bluemult1 params, in 0..2 (1 = neutral). Replaces the previous
// single `rgb` swatch, which was display-only (bind_to ignored on rgb controls).
const wheelChannelControls = (
  prefix: string,
  rgb: readonly [number, number, number],
  nodePath: string,
): ControlSpec[] => {
  const channels: Array<["R" | "G" | "B", number, "redmult1" | "greenmult1" | "bluemult1"]> = [
    ["R", rgb[0], "redmult1"],
    ["G", rgb[1], "greenmult1"],
    ["B", rgb[2], "bluemult1"],
  ];
  return channels.map(([letter, value, par]) => ({
    name: `${prefix}${letter}`,
    type: "float" as const,
    min: 0,
    max: 2,
    default: value,
    bind_to: [`${nodePath}.${par}`],
  }));
};

export async function createColorWheelsImpl(ctx: ToolContext, args: CreateColorWheelsArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(
      ctx,
      args.parent_path,
      args.base_name ?? "color_wheels",
    );

    // Source: external TOP via Select, or a test ramp.
    let source: string;
    if (args.source_path) {
      source = await builder.add("selectTOP", "source", { top: args.source_path });
    } else {
      source = await builder.add("rampTOP", "source", { type: "horizontal" });
    }

    // Lift wheel — biased toward shadows via a high gamma1 (>1 darkens mids, so
    // the R/G/B multiplies act mostly in the shadow range without crushing highlights).
    const [lr, lg, lb] = args.lift;
    const lift = await builder.add("levelTOP", "lift_wheel", {
      gamma1: 1.4,
      redmult1: lr,
      greenmult1: lg,
      bluemult1: lb,
    });
    await builder.connect(source, lift);

    // Gamma (midtone) wheel — neutral gamma, just channel multipliers landing on mids.
    const [gr, gg, gb] = args.gamma;
    const gammaW = await builder.add("levelTOP", "gamma_wheel", {
      redmult1: gr,
      greenmult1: gg,
      bluemult1: gb,
    });
    await builder.connect(lift, gammaW);

    // Gain wheel — biased toward highlights via a slight brightness1 boost on the
    // chained colour, so the channel multipliers act mostly on the brighter pixels.
    const [hr, hg, hb] = args.gain;
    const gain = await builder.add("levelTOP", "gain_wheel", {
      brightness1: 1.1,
      redmult1: hr,
      greenmult1: hg,
      bluemult1: hb,
    });
    await builder.connect(gammaW, gain);

    // Master Level TOP: global offset (blacklevel) + safety brightness pass-through.
    const master = await builder.add("levelTOP", "master_level", {
      blacklevel: args.offset,
    });
    await builder.connect(gain, master);

    // Saturation via HSV Adjust TOP.
    const hsv = await builder.add("hsvadjustTOP", "saturation", {
      saturationmult: args.saturation,
    });
    await builder.connect(master, hsv);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(hsv, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          ...wheelChannelControls("Lift", [lr, lg, lb], lift),
          ...wheelChannelControls("Gamma", [gr, gg, gb], gammaW),
          ...wheelChannelControls("Gain", [hr, hg, hb], gain),
          {
            name: "Offset",
            type: "float",
            min: -1,
            max: 1,
            default: args.offset,
            bind_to: [`${master}.blacklevel`],
          },
          {
            name: "Saturation",
            type: "float",
            min: 0,
            max: 4,
            default: args.saturation,
            bind_to: [`${hsv}.saturationmult`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built colour wheels (lift/gamma/gain) over ${
        args.source_path ?? "a test ramp"
      } → ${out}. Offset ${args.offset}, saturation ${args.saturation}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        lift: args.lift,
        gamma: args.gamma,
        gain: args.gain,
        offset: args.offset,
        saturation: args.saturation,
        lift_path: lift,
        gamma_path: gammaW,
        gain_path: gain,
        master_path: master,
        hsv_path: hsv,
        output_path: out,
        exposed_params: args.expose_controls
          ? [
              "LiftR",
              "LiftG",
              "LiftB",
              "GammaR",
              "GammaG",
              "GammaB",
              "GainR",
              "GainG",
              "GainB",
              "Offset",
              "Saturation",
            ]
          : [],
      },
    });
  });
}

export const registerCreateColorWheels: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_color_wheels",
    {
      title: "Create colour wheels (lift/gamma/gain)",
      description:
        "Classic colour-grading wheels — three tinted Level TOPs run in series for shadows (lift, gamma-biased), midtones (gamma) and highlights (gain, brightness-biased), then a master Level TOP for global offset (blacklevel), then an HSV Adjust TOP for saturation. Each wheel is an [r,g,b] multiplier in 0..2 (1,1,1 = neutral). Builds a new baseCOMP under `parent_path` holding the chain; with `source_path` the upstream TOP is pulled in via a Select TOP, without one a Ramp TOP test gradient is graded so the chain previews standalone. Exposes per-channel LiftR/G/B, GammaR/G/B, GainR/G/B float knobs plus Offset and Saturation (live-bound to the underlying Level/HSV pars). Output is a Null TOP. Use create_color_grade for a simpler single-Level + HSV chain, or apply_post_processing to chain several distinct effects.",
      inputSchema: createColorWheelsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createColorWheelsImpl(ctx, args),
  );
};
