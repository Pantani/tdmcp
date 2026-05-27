import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

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
  parent_path: z.string().default("/project1"),
});
type CreateMultiOutputArgs = z.infer<typeof createMultiOutputSchema>;

export async function createMultiOutputImpl(ctx: ToolContext, args: CreateMultiOutputArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "multi_output");
    const [tw, th] = RESOLUTIONS[args.resolution];
    const horizontal = args.layout === "horizontal";

    // Pull the master in once through a Select TOP (works across COMP boundaries).
    const src = await builder.add("selectTOP", "src", { top: args.source_path });

    const outputs: string[] = [];
    const windows: string[] = [];
    for (let i = 0; i < args.count; i++) {
      const lo = i / args.count;
      const hi = (i + 1) / args.count;
      // Crop the master to tile i's region (fractions, origin bottom-left), then resize the slice
      // up to the full projector resolution.
      const cropParams: Record<string, unknown> = {
        cropleftunit: "fraction",
        croprightunit: "fraction",
        cropbottomunit: "fraction",
        croptopunit: "fraction",
        cropleft: horizontal ? lo : 0,
        cropright: horizontal ? hi : 1,
        cropbottom: horizontal ? 0 : lo,
        croptop: horizontal ? 1 : hi,
        outputresolution: "custom",
        resolutionw: tw,
        resolutionh: th,
      };
      const tile = await builder.add("cropTOP", `tile${i + 1}`, cropParams);
      await builder.connect(src, tile);
      const out = await builder.add("nullTOP", `out${i + 1}`);
      await builder.connect(tile, out);
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
      summary: `Split ${args.source_path} into ${args.count} ${args.layout} output(s) at ${args.resolution} → ${outputs.join(", ")}${
        args.as_windows ? ` (+${windows.length} window(s), left closed)` : ""
      }.`,
      builder,
      outputPath: outputs[0] as string,
      controls: [],
      extra: {
        source_path: args.source_path,
        count: args.count,
        layout: args.layout,
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
        "Fan a master TOP across N projectors/displays: each output is a cropped slice (horizontal or vertical) resized to full projector resolution and ended on a Null, ready for setup_output. With as_windows, each tile also gets a borderless Window COMP offset across the desktop so it lands on its own display (left closed — open in Perform mode). The multi-projector counterpart to setup_output's single window. (Edge-blend for overlapping projectors is not yet applied — tiles abut.)",
      inputSchema: createMultiOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMultiOutputImpl(ctx, args),
  );
};
