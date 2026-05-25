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
  output_type: z.enum(["window", "ndi", "syphon_spout", "record", "touch_out"]).default("window"),
  resolution: z.enum(["720p", "1080p", "4K"]).default("1080p"),
  record_format: z.enum(["mp4", "mov", "image_sequence"]).optional(),
  parent_path: z.string().default("/project1"),
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
      const [width, height] = RESOLUTIONS[args.resolution];
      try {
        await ctx.client.executePythonScript(
          `w = op(${q(node.path)})\nw.par.op = ${q(args.source_path)}\nw.par.winw = ${width}\nw.par.winh = ${height}`,
          false,
        );
      } catch (err) {
        warnings.push(`Could not configure window: ${friendlyTdError(err)}`);
      }
    } else {
      try {
        await connectNodesViaBridge(ctx.client, args.source_path, node.path);
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
        "Route a TOP to an output: a display window, NDI stream, Syphon/Spout, a recording, or Touch Out.",
      inputSchema: setupOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupOutputImpl(ctx, args),
  );
};
