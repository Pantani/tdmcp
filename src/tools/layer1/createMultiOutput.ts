import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

export const createMultiOutputSchema = z.object({
  source_path: z.string().describe("The master TOP to fan out across the projectors/displays."),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .default(2)
    .describe("How many outputs to split the master into (one per projector/display)."),
  layout: z
    .enum(["horizontal", "vertical"])
    .default("horizontal")
    .describe("Slice the master side-by-side (horizontal) or stacked (vertical)."),
  overlap: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Edge-blend: overlap each tile into its neighbor by this fraction of a tile's width, with a linear feather at the shared seams so physically-overlapping projectors blend smoothly (0 = abutting tiles, no blend). Try 0.1–0.3.",
    ),
  resolution: z
    .enum(["720p", "1080p", "4K"])
    .default("1080p")
    .describe("Per-output (per-projector) resolution."),
  as_windows: z
    .boolean()
    .default(false)
    .describe(
      "Also create a borderless Window COMP per tile, offset across the desktop so each lands on its own display. Left closed — open them in Perform mode when ready.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the multi-output container is created (default '/project1')."),
});
type CreateMultiOutputArgs = z.infer<typeof createMultiOutputSchema>;

/** A GLSL fragment shader that multiplies the input tile by a linear edge feather: it fades in
 * over the first `wLow` of the axis (if > 0) and out over the last `wHigh` (if > 0). `axis` is
 * "s" for horizontal seams, "t" for vertical. */
function featherShader(axis: "s" | "t", wLow: number, wHigh: number): string {
  const lines = [
    "out vec4 fragColor;",
    "void main() {",
    "    vec4 c = texture(sTD2DInputs[0], vUV.st);",
    `    float p = vUV.${axis};`,
    "    float a = 1.0;",
  ];
  if (wLow > 0) lines.push(`    a *= clamp(p / ${wLow.toFixed(5)}, 0.0, 1.0);`);
  if (wHigh > 0) lines.push(`    a *= clamp((1.0 - p) / ${wHigh.toFixed(5)}, 0.0, 1.0);`);
  lines.push("    fragColor = c * a;", "}");
  return lines.join("\n");
}

export async function createMultiOutputImpl(ctx: ToolContext, args: CreateMultiOutputArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "multi_output");
    const [tw, th] = RESOLUTIONS[args.resolution];
    const horizontal = args.layout === "horizontal";
    const base = 1 / args.count;
    const ov = args.overlap * base; // overlap width per seam, in source fraction

    // Pull the master in once through a Select TOP (works across COMP boundaries).
    const src = await builder.add("selectTOP", "src", { top: args.source_path });

    const outputs: string[] = [];
    const windows: string[] = [];
    let blended = false;
    for (let i = 0; i < args.count; i++) {
      const hasLow = i > 0; // a neighbor on the low side (left/bottom)
      const hasHigh = i < args.count - 1; // a neighbor on the high side (right/top)
      // Widen the tile into its neighbours by the overlap, clamped to the canvas edges.
      const loSrc = Math.max(0, i * base - (hasLow ? ov : 0));
      const hiSrc = Math.min(1, (i + 1) * base + (hasHigh ? ov : 0));
      const span = hiSrc - loSrc;
      // Feather widths in the tile's own UV space (only on edges that touch a neighbour).
      const wLow = hasLow && ov > 0 && span > 0 ? ov / span : 0;
      const wHigh = hasHigh && ov > 0 && span > 0 ? ov / span : 0;

      // Crop the master to this tile's region (fractions, origin bottom-left), resized to the full
      // projector resolution.
      const tile = await builder.add("cropTOP", `tile${i + 1}`, {
        cropleftunit: "fraction",
        croprightunit: "fraction",
        cropbottomunit: "fraction",
        croptopunit: "fraction",
        cropleft: horizontal ? loSrc : 0,
        cropright: horizontal ? hiSrc : 1,
        cropbottom: horizontal ? 0 : loSrc,
        croptop: horizontal ? 1 : hiSrc,
        outputresolution: "custom",
        resolutionw: tw,
        resolutionh: th,
      });
      await builder.connect(src, tile);

      // Edge-blend: a GLSL TOP multiplies the tile by a linear feather at the shared seams, so two
      // overlapping projectors sum to full brightness across the blend.
      let tileOut = tile;
      if (wLow > 0 || wHigh > 0) {
        const frag = await builder.add("textDAT", `feather${i + 1}`);
        const glsl = await builder.add("glslTOP", `blend${i + 1}`);
        await builder.connect(tile, glsl);
        const shader = featherShader(horizontal ? "s" : "t", wLow, wHigh);
        await builder.python(
          `op(${q(frag)}).text = ${q(shader)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
        );
        tileOut = glsl;
        blended = true;
      }

      const out = await builder.add("nullTOP", `out${i + 1}`);
      await builder.connect(tileOut, out);
      outputs.push(out);

      if (args.as_windows) {
        const win = await builder.add("windowCOMP", `win${i + 1}`, {
          winop: out,
          winw: tw,
          winh: th,
          winoffsetx: horizontal ? i * tw : 0,
          winoffsety: horizontal ? 0 : i * th,
          borders: 0,
          winopen: 0,
        });
        windows.push(win);
      }
    }

    return finalize(ctx, {
      summary: `Split ${args.source_path} into ${args.count} ${args.layout} output(s) at ${args.resolution}${
        blended ? ` with edge-blend (overlap ${args.overlap})` : ""
      } → ${outputs.join(", ")}${args.as_windows ? ` (+${windows.length} window(s), left closed)` : ""}.`,
      builder,
      outputPath: outputs[0] as string,
      controls: [],
      extra: {
        source_path: args.source_path,
        count: args.count,
        layout: args.layout,
        overlap: args.overlap,
        blended,
        outputs,
        windows,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateMultiOutput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_multi_output",
    {
      title: "Create multi-output",
      description:
        "Fan a master TOP across N projectors/displays: each output is a cropped slice (horizontal or vertical) resized to full projector resolution and ended on a Null, ready for setup_output. Set `overlap` for edge-blending — tiles widen into their neighbours and a GLSL feather fades the shared seams so physically-overlapping projectors blend smoothly. Creates a new baseCOMP under `parent_path` holding the Select TOP, per-tile Crop (+ optional GLSL feather) and Null outputs, and optional Window COMPs. With as_windows, each tile also gets a borderless Window COMP offset across the desktop so it lands on its own display (left closed — open in Perform mode). Use setup_output instead for a single-window output; create_dome_output/create_cubemap_dome for curved/fulldome instead of flat tiling. Returns a summary plus a JSON block with the container path, created node paths, the first output path, the full list of output and window paths, and any node errors/warnings, with an inline preview image of the first tile.",
      inputSchema: createMultiOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMultiOutputImpl(ctx, args),
  );
};
