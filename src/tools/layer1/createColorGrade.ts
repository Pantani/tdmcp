import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const createColorGradeSchema = z.object({
  brightness: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe(
      "Overall brightness / gain multiplier (1 = unchanged). Drives the Level TOP's `brightness1` (this is the gain control — the param is `brightness1`, NOT `gain`).",
    ),
  gamma: z.coerce
    .number()
    .positive()
    .default(1)
    .describe(
      "Gamma / mid-tone curve (1 = linear, <1 brightens mids, >1 darkens mids). Drives the Level TOP's `gamma1`.",
    ),
  contrast: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe("Contrast around mid-grey (1 = unchanged). Drives the Level TOP's `contrast`."),
  black_level: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Lift the black point (0 = unchanged); raises the darkest pixels for a faded / filmic 'lift'. Drives the Level TOP's `blacklevel`.",
    ),
  saturation: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe(
      "Colour saturation multiplier (0 = greyscale, 1 = unchanged, >1 = punchier). Drives the HSV Adjust TOP's `saturationmult`.",
    ),
  hue: z.coerce
    .number()
    .default(0)
    .describe(
      "Hue rotation in degrees (0 = unchanged, 0..360 wraps the colour wheel). Drives the HSV Adjust TOP's `hueoffset`.",
    ),
  lut_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path to a LUT image file (e.g. a 256x1 / 512x512 colour ramp). When given, a Movie File In TOP loads it and feeds the SECOND input of a Lookup TOP; the graded image is the first input, so each pixel is remapped through the LUT. Omit to skip LUT remapping.",
    ),
  input_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path of the source TOP to grade. Pulled in via a Select TOP (TD wires don't cross containers). If omitted, a Ramp TOP test gradient is graded so the chain still builds and previews without any device or external source.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live Brightness / Gamma / Contrast / Saturation / Hue knobs bound to the right node parameters.",
    ),
  parent_path: z.string().default("/project1"),
});
type CreateColorGradeArgs = z.infer<typeof createColorGradeSchema>;

export async function createColorGradeImpl(ctx: ToolContext, args: CreateColorGradeArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "color_grade");

    // Source: pull an external TOP in via a Select TOP (wires can't cross COMPs, so the
    // `top` param references it by ABSOLUTE path). With no input, grade a Ramp TOP test
    // gradient so the chain builds and previews standalone (no device / external source).
    let source: string;
    if (args.input_path) {
      source = await builder.add("selectTOP", "source", { top: args.input_path });
    } else {
      // A horizontal gradient spans the full tonal/colour range, so brightness/gamma/
      // contrast/saturation/hue changes are all immediately visible in the preview.
      source = await builder.add("rampTOP", "source", { type: "horizontal" });
    }

    // Lift / gamma / gain via the Level TOP. NOTE the TD param tokens: brightness is
    // `brightness1` (NOT `gain`), gamma is `gamma1`, plus `contrast` and `blacklevel`.
    const level = await builder.add("levelTOP", "grade_level", {
      brightness1: args.brightness,
      gamma1: args.gamma,
      contrast: args.contrast,
      blacklevel: args.black_level,
    });
    await builder.connect(source, level);

    // Saturation + hue via the HSV Adjust TOP: `saturationmult` (Saturation Multiplier)
    // and `hueoffset` (Hue Offset, in degrees).
    const hsv = await builder.add("hsvadjustTOP", "grade_hsv", {
      saturationmult: args.saturation,
      hueoffset: args.hue,
    });
    await builder.connect(level, hsv);

    // Optional LUT remap. The Lookup TOP recolours its FIRST input (the graded image)
    // through a lookup table built from its SECOND input. So load the LUT file with a
    // Movie File In TOP and wire it into input 1 (the 2nd input); the graded HSV output
    // is input 0. `lookup` selects the 2nd-input method (vs building the table from a CHOP).
    let output = hsv;
    if (args.lut_path) {
      const lut = await builder.add("moviefileinTOP", "lut_file", { file: args.lut_path });
      const lookup = await builder.add("lookupTOP", "grade_lookup", { lookup: "input" });
      await builder.connect(hsv, lookup, 0, 0);
      await builder.connect(lut, lookup, 0, 1);
      output = lookup;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Brightness",
            type: "float",
            min: 0,
            max: 4,
            default: args.brightness,
            bind_to: [`${level}.brightness1`],
          },
          {
            name: "Gamma",
            type: "float",
            min: 0.1,
            max: 4,
            default: args.gamma,
            bind_to: [`${level}.gamma1`],
          },
          {
            name: "Contrast",
            type: "float",
            min: 0,
            max: 4,
            default: args.contrast,
            bind_to: [`${level}.contrast`],
          },
          {
            name: "Saturation",
            type: "float",
            min: 0,
            max: 4,
            default: args.saturation,
            bind_to: [`${hsv}.saturationmult`],
          },
          {
            name: "Hue",
            type: "float",
            min: 0,
            max: 360,
            default: args.hue,
            bind_to: [`${hsv}.hueoffset`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a colour grade (brightness ${args.brightness}, gamma ${args.gamma}, contrast ${args.contrast}, saturation ${args.saturation}, hue ${args.hue}deg)${
        args.lut_path ? ` with LUT ${args.lut_path}` : ""
      }${args.input_path ? ` over ${args.input_path}` : " over a test ramp"} → ${out}.`,
      builder,
      outputPath: out,
      // Output is a TOP (the Null), so a preview image is captured.
      capturePreviewImage: true,
      controls,
      extra: {
        brightness: args.brightness,
        gamma: args.gamma,
        contrast: args.contrast,
        black_level: args.black_level,
        saturation: args.saturation,
        hue: args.hue,
        lut_path: args.lut_path,
        input_path: args.input_path,
        level_path: level,
        hsv_path: hsv,
        output_path: out,
      },
    });
  });
}

export const registerCreateColorGrade: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_color_grade",
    {
      title: "Create color grade",
      description:
        "Build a colour-grading / LUT finishing stage over a source — the 'make the final output look graded' tool for VJ sets. A Level TOP applies lift/gamma/gain (brightness1 / gamma1 / contrast + black level), then an HSV Adjust TOP applies saturation + hue rotation; an optional LUT image file is loaded via a Movie File In TOP and fed into a Lookup TOP's second input to remap every colour. With an input_path the source is pulled in via a Select TOP (so it can live in another container); without one, a Ramp TOP test gradient is graded so it builds and previews standalone. Live Brightness / Gamma / Contrast / Saturation / Hue knobs are exposed. Output is a Null TOP.",
      inputSchema: createColorGradeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createColorGradeImpl(ctx, args),
  );
};
