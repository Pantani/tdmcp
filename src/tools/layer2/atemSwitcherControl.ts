import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { type OscRouterMatrixArgs, oscRouterMatrixImpl } from "./oscRouterMatrix.js";

export const atemSwitcherControlSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to build the ATEM control preset in."),
  name: z
    .string()
    .default("atem_switcher_control")
    .describe("Name of the ATEM control container COMP."),
  host: z.string().default("127.0.0.1").describe("atemOSC, Companion, or OSC relay host/IP."),
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3333)
    .describe("OSC receive port for atemOSC/Companion/relay."),
  inputs: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(4)
    .describe("Switcher input count to expose."),
  active: z.boolean().default(false).describe("Start OSC sending immediately."),
});
type AtemSwitcherControlArgs = z.infer<typeof atemSwitcherControlSchema>;

function atemRoutes(inputs: number): OscRouterMatrixArgs["routes"] {
  const inputRoutes = Array.from({ length: inputs }, (_, index) => {
    const input = index + 1;
    return [
      {
        address: `/atem/program/${input}`,
        channel: `program_${input}`,
        label: `Program ${input}`,
        default: 0,
      },
      {
        address: `/atem/preview/${input}`,
        channel: `preview_${input}`,
        label: `Preview ${input}`,
        default: 0,
      },
    ];
  }).flat();
  return [
    { address: "/atem/cut", channel: "cut", label: "Cut", default: 0 },
    { address: "/atem/auto", channel: "auto", label: "Auto", default: 0 },
    { address: "/atem/ftb", channel: "fade_to_black", label: "Fade to black", default: 0 },
    ...inputRoutes,
  ];
}

export async function atemSwitcherControlImpl(ctx: ToolContext, args: AtemSwitcherControlArgs) {
  return oscRouterMatrixImpl(ctx, {
    parent_path: args.parent_path,
    name: args.name,
    routes: atemRoutes(args.inputs),
    targets: [
      {
        name: "atem",
        host: args.host,
        port: args.port,
        prefix: "",
        active: args.active,
      },
    ],
  });
}

export const registerAtemSwitcherControl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "atem_switcher_control",
    {
      title: "ATEM switcher control",
      description:
        "Create an OSC control preset for an ATEM switcher routed through atemOSC, Bitfocus Companion, or another OSC relay. This does not use the Blackmagic SDK directly; it builds an offline-safe TouchDesigner OSC matrix for cut/auto/FTB and program/preview input selection.",
      inputSchema: atemSwitcherControlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => atemSwitcherControlImpl(ctx, args),
  );
};
