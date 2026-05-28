import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { connectNodesViaBridge } from "../layer2/connectHelper.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const OUTPUT_MAP = {
  window: "windowCOMP",
  ndi: "ndioutTOP",
  syphon_spout: "syphonspoutoutTOP",
  record: "moviefileoutTOP",
  touch_out: "touchoutTOP",
} as const;

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

export const setupOutputSchema = z.object({
  source_path: z.string().describe("Path of the final TOP to output."),
  output_type: z
    .enum(["window", "ndi", "syphon_spout", "record", "touch_out"])
    .default("window")
    .describe(
      "Destination: 'window' (a Window COMP display), 'ndi' (NDI Out TOP network stream), 'syphon_spout' (Syphon/Spout Out TOP for other apps), 'record' (Movie File Out TOP to disk), or 'touch_out' (Touch Out TOP to another TD instance).",
    ),
  resolution: z
    .enum(["720p", "1080p", "4K"])
    .default("1080p")
    .describe(
      "Window size for output_type='window' (720p=1280×720, 1080p=1920×1080, 4K=3840×2160); ignored by the other output types.",
    ),
  record_format: z
    .enum(["mp4", "mov", "image_sequence"])
    .optional()
    .describe(
      "File format for output_type='record' (sets the Movie File Out TOP's type); ignored otherwise.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the output node (and any bridging Select TOP) is created inside."),
});
type SetupOutputArgs = z.infer<typeof setupOutputSchema>;

export async function setupOutputImpl(ctx: ToolContext, args: SetupOutputArgs) {
  return runBuild(async () => {
    const warnings: string[] = [];
    const node = await ctx.client.createNode({
      parent_path: args.parent_path,
      type: OUTPUT_MAP[args.output_type],
      name: `${args.output_type}_out`,
    });

    if (args.output_type === "window") {
      // windowCOMP references its source via the `winop` path parameter, which
      // works across COMP boundaries — no wire needed.
      const [width, height] = RESOLUTIONS[args.resolution];
      try {
        await ctx.client.executePythonScript(
          `w = op(${q(node.path)})\nw.par.winop = ${q(args.source_path)}\nw.par.winw = ${width}\nw.par.winh = ${height}`,
          false,
        );
      } catch (err) {
        warnings.push(`Could not configure window: ${friendlyTdError(err)}`);
      }
    } else {
      // The other outputs need a real wired input. A direct wire fails when the
      // source lives in a different COMP (TD wires can't cross COMP boundaries),
      // so bridge it through a Select TOP that references the source by path.
      try {
        const select = await ctx.client.createNode({
          parent_path: args.parent_path,
          type: "selectTOP",
          name: `${args.output_type}_src`,
        });
        await ctx.client.updateNodeParameters(select.path, { top: args.source_path });
        await connectNodesViaBridge(ctx.client, select.path, node.path);
      } catch (err) {
        warnings.push(`Could not connect source to output: ${friendlyTdError(err)}`);
      }
    }

    if (args.output_type === "record" && args.record_format) {
      try {
        await ctx.client.updateNodeParameters(node.path, { type: args.record_format });
      } catch (err) {
        warnings.push(`Could not set record format: ${friendlyTdError(err)}`);
      }
    }

    return jsonResult(`Configured ${args.output_type} output for ${args.source_path}.`, {
      output: node.path,
      output_type: args.output_type,
      source_path: args.source_path,
      resolution: args.resolution,
      warnings,
    });
  });
}

export const registerSetupOutput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_output",
    {
      title: "Set up output",
      description:
        "Route a finished TOP to an output destination: a display window, NDI stream, Syphon/Spout, a recording, or Touch Out. Creates the matching output node ('<output_type>_out') under parent_path; for a window it points the Window COMP's winop at the source and sets its size, and for the other types it bridges the source in through a Select TOP (TD wires can't cross COMP boundaries). Typically the LAST step after building a visual — feed it the output Null from a create_* tool or a create_layer_mixer. Returns the created output node path, the output type, the source path, and any non-fatal warnings (e.g. if wiring or window config failed).",
      inputSchema: setupOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupOutputImpl(ctx, args),
  );
};
