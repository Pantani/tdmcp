import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

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
      "When true (default), expose live LiftRGB / GammaRGB / GainRGB swatches plus Offset and Saturation knobs.",
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

// Helper: format a 0..1 RGB triple as a "#rrggbb" hex string for the control
// panel's rgb swatch (the BaseColor convention used elsewhere in Layer 1).
const toHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

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
          { name: "LiftRGB", type: "rgb", default: toHex([lr / 2, lg / 2, lb / 2]) },
          { name: "GammaRGB", type: "rgb", default: toHex([gr / 2, gg / 2, gb / 2]) },
          { name: "GainRGB", type: "rgb", default: toHex([hr / 2, hg / 2, hb / 2]) },
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
          ? ["LiftRGB", "GammaRGB", "GainRGB", "Offset", "Saturation"]
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
        "Classic colour-grading wheels — three tinted Level TOPs run in series for shadows (lift, gamma-biased), midtones (gamma) and highlights (gain, brightness-biased), then a master Level TOP for global offset (blacklevel), then an HSV Adjust TOP for saturation. Each wheel is an [r,g,b] multiplier in 0..2 (1,1,1 = neutral). Builds a new baseCOMP under `parent_path` holding the chain; with `source_path` the upstream TOP is pulled in via a Select TOP, without one a Ramp TOP test gradient is graded so the chain previews standalone. Exposes LiftRGB / GammaRGB / GainRGB swatches plus Offset and Saturation knobs. Output is a Null TOP. Use create_color_grade for a simpler single-Level + HSV chain, or apply_post_processing to chain several distinct effects.",
      inputSchema: createColorWheelsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createColorWheelsImpl(ctx, args),
  );
};
