import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { type OscRouterMatrixArgs, oscRouterMatrixImpl } from "./oscRouterMatrix.js";

export const resolumeVdmxOutputChainSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to build the Resolume/VDMX control chain in."),
  name: z
    .string()
    .default("resolume_vdmx_output_chain")
    .describe("Name of the output-control container COMP."),
  target: z
    .enum(["resolume", "vdmx", "both"])
    .default("resolume")
    .describe("Which OSC target preset(s) to create."),
  host: z.string().default("127.0.0.1").describe("Destination host for Resolume/VDMX OSC."),
  resolume_port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(7000)
    .describe("Resolume OSC input port."),
  vdmx_port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8000)
    .describe("VDMX OSC input port."),
  active: z.boolean().default(false).describe("Start OSC sending immediately."),
});
type ResolumeVdmxOutputChainArgs = z.infer<typeof resolumeVdmxOutputChainSchema>;

const ROUTES: OscRouterMatrixArgs["routes"] = [
  { address: "/layer/1/opacity", channel: "layer_1_opacity", label: "Layer 1 opacity", default: 1 },
  { address: "/layer/2/opacity", channel: "layer_2_opacity", label: "Layer 2 opacity", default: 1 },
  { address: "/crossfader", channel: "crossfader", label: "Crossfader", default: 0.5 },
  { address: "/speed", channel: "speed", label: "Speed", default: 1 },
  { address: "/clip/trigger", channel: "clip_trigger", label: "Clip trigger", default: 0 },
  { address: "/blackout", channel: "blackout", label: "Blackout", default: 0 },
];

function targets(args: ResolumeVdmxOutputChainArgs): OscRouterMatrixArgs["targets"] {
  const list: OscRouterMatrixArgs["targets"] = [];
  if (args.target === "resolume" || args.target === "both") {
    list.push({
      name: "resolume",
      host: args.host,
      port: args.resolume_port,
      prefix: "/composition",
      active: args.active,
    });
  }
  if (args.target === "vdmx" || args.target === "both") {
    list.push({
      name: "vdmx",
      host: args.host,
      port: args.vdmx_port,
      prefix: "/tdmcp",
      active: args.active,
    });
  }
  return list;
}

export async function resolumeVdmxOutputChainImpl(
  ctx: ToolContext,
  args: ResolumeVdmxOutputChainArgs,
) {
  return oscRouterMatrixImpl(ctx, {
    parent_path: args.parent_path,
    name: args.name,
    routes: ROUTES,
    targets: targets(args),
  });
}

export const registerResolumeVdmxOutputChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "resolume_vdmx_output_chain",
    {
      title: "Resolume / VDMX output-control chain",
      description:
        "Create an OSC control chain for driving Resolume, VDMX, or both from TouchDesigner. It builds target-specific OSC Out lanes with layer opacity, crossfader, speed, clip trigger, and blackout channels; use it beside video/NDI/Syphon output tools when an external VJ app handles playback or final compositing.",
      inputSchema: resolumeVdmxOutputChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => resolumeVdmxOutputChainImpl(ctx, args),
  );
};
