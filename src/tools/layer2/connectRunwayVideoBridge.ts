import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectRunwayVideoBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Runway scaffold."),
  name: z.string().default("runway_video_bridge").describe("Generated baseCOMP name."),
  endpoint_url: z.string().default("https://api.runway.example/v1/jobs"),
  project_id: z.string().default("show_project"),
  generation_mode: z
    .enum(["text_to_video", "image_to_video", "video_to_video", "manual_export"])
    .default("text_to_video"),
  input_clip_path: z.string().default(""),
  output_folder: z.string().default("./generated/runway"),
  prompt_count: z.coerce.number().int().min(1).max(64).default(4),
  active: z.boolean().default(false),
});

type ConnectRunwayVideoBridgeArgs = z.infer<typeof connectRunwayVideoBridgeSchema>;

function sourceNode(args: ConnectRunwayVideoBridgeArgs): ExternalShowNodeSpec {
  if (args.generation_mode === "manual_export") {
    return {
      name: "manual_export_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual export selected. Drop rendered files into output_folder and update result_map.",
    };
  }
  if (args.generation_mode === "video_to_video" && args.input_clip_path) {
    return {
      name: "input_clip",
      optype: "moviefileinTOP",
      x: 0,
      y: 120,
      params: { file: args.input_clip_path, play: args.active ? 1 : 0 },
    };
  }
  return {
    name: "runway_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.endpoint_url, reqmethod: "POST", active: args.active ? 1 : 0 },
  };
}

function promptRows(args: ConnectRunwayVideoBridgeArgs): string[][] {
  const rows = [["prompt", "mode", "input_reference", "duration_hint"]];
  for (let index = 1; index <= args.prompt_count; index += 1) {
    rows.push([
      `prompt_${index}`,
      args.generation_mode,
      args.input_clip_path || "none",
      "operator_defined",
    ]);
  }
  return rows;
}

export async function connectRunwayVideoBridgeImpl(
  ctx: ToolContext,
  args: ConnectRunwayVideoBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "runway_video_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        project_id: args.project_id,
        generation_mode: args.generation_mode,
        input_clip_path: args.input_clip_path,
        output_folder: args.output_folder,
        prompt_count: args.prompt_count,
        active: args.active,
      },
      warnings: [
        "This scaffold does not authenticate, submit generation jobs, or download generated videos.",
        "Runway-style service endpoints and response schemas must be isolated in an adapter and validated live.",
      ],
      nodes: [
        sourceNode(args),
        { name: "prompt_map", optype: "tableDAT", x: 300, y: 120, table: promptRows(args) },
        {
          name: "result_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["result", "role", "path_hint"],
            ["latest_video", "generated media", `${args.output_folder}/latest.mp4`],
            ["job_status", "adapter status", "queued|running|succeeded|failed"],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["project_id", args.project_id],
            ["generation_mode", args.generation_mode],
            ["endpoint_url", args.endpoint_url],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use prompt_map/result_map as the TD-side contract. Keep upload, auth, polling, downloads, and content review in the external adapter.",
        },
      ],
    },
    "connect_runway_video_bridge failed",
    (report) =>
      `Created Runway video bridge ${report.container_path}; mode ${args.generation_mode}; prompts ${args.prompt_count}.`,
  );
}

export const registerConnectRunwayVideoBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_runway_video_bridge",
    {
      title: "Connect Runway video bridge",
      description:
        "Create a Runway-style video generation handoff scaffold with prompt maps, input/result contracts, polling status, and adapter notes.",
      inputSchema: connectRunwayVideoBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectRunwayVideoBridgeImpl(ctx, args),
  );
};
