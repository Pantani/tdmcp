import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { type OscRouterMatrixArgs, oscRouterMatrixImpl } from "./oscRouterMatrix.js";

export const qlabOscBridgeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to build the QLab OSC bridge in."),
  name: z.string().default("qlab_osc_bridge").describe("Name of the bridge container COMP."),
  host: z.string().default("127.0.0.1").describe("QLab machine IP or hostname."),
  port: z.coerce.number().int().min(1).max(65535).default(53000).describe("QLab OSC receive port."),
  active: z.boolean().default(false).describe("Start OSC sending immediately."),
  cue_numbers: z
    .array(z.string())
    .default([])
    .describe("Optional QLab cue numbers to expose as /cue/{number}/start routes."),
});
type QlabOscBridgeArgs = z.infer<typeof qlabOscBridgeSchema>;

function qlabRoutes(cues: string[]): OscRouterMatrixArgs["routes"] {
  return [
    { address: "/go", label: "Go", default: 0 },
    { address: "/stop", label: "Stop", default: 0 },
    { address: "/panic", label: "Panic", default: 0 },
    { address: "/pause", label: "Pause", default: 0 },
    { address: "/resume", label: "Resume", default: 0 },
    { address: "/reset", label: "Reset", default: 0 },
    ...cues.map((cue) => ({
      address: `/cue/${cue}/start`,
      channel: `cue_${cue.replace(/[^A-Za-z0-9_]/g, "_")}_start`,
      label: `Cue ${cue} start`,
      default: 0,
    })),
  ];
}

export async function qlabOscBridgeImpl(ctx: ToolContext, args: QlabOscBridgeArgs) {
  return oscRouterMatrixImpl(ctx, {
    parent_path: args.parent_path,
    name: args.name,
    routes: qlabRoutes(args.cue_numbers),
    targets: [
      {
        name: "qlab",
        host: args.host,
        port: args.port,
        prefix: "",
        active: args.active,
      },
    ],
  });
}

export const registerQlabOscBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "qlab_osc_bridge",
    {
      title: "QLab OSC bridge",
      description:
        "Create a QLab OSC control bridge using the OSC router matrix primitive. It exposes /go, /stop, /panic, /pause, /resume, /reset and optional /cue/{number}/start routes to QLab's configurable OSC receive port, without requiring QLab to be running during build.",
      inputSchema: qlabOscBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => qlabOscBridgeImpl(ctx, args),
  );
};
