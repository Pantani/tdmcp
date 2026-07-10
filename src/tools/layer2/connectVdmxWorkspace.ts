import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectVdmxWorkspaceSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the VDMX scaffold."),
  name: z.string().default("vdmx_workspace").describe("Generated baseCOMP name."),
  vdmx_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(12345),
  receive_port: z.coerce.number().int().min(1).max(65535).default(12346),
  layer_count: z.coerce.number().int().min(1).max(64).default(4),
  clip_count: z.coerce.number().int().min(1).max(256).default(16),
  preview_mode: z.enum(["none", "syphon_spout", "ndi"]).default("syphon_spout"),
  active: z.boolean().default(false),
});

type ConnectVdmxWorkspaceArgs = z.infer<typeof connectVdmxWorkspaceSchema>;

function layerRows(args: ConnectVdmxWorkspaceArgs): string[][] {
  const rows = [["layer", "opacity_address", "trigger_address"]];
  for (let layer = 1; layer <= args.layer_count; layer += 1) {
    rows.push([`layer_${layer}`, `/vdmx/layer/${layer}/opacity`, `/vdmx/layer/${layer}/trigger`]);
  }
  return rows;
}

function clipRows(args: ConnectVdmxWorkspaceArgs): string[][] {
  const rows = [["clip", "address", "value_hint"]];
  for (let clip = 1; clip <= args.clip_count; clip += 1) {
    rows.push([`clip_${clip}`, `/vdmx/clip/${clip}/launch`, "pulse"]);
  }
  return rows;
}

export async function connectVdmxWorkspaceImpl(ctx: ToolContext, args: ConnectVdmxWorkspaceArgs) {
  const previewNode =
    args.preview_mode === "ndi"
      ? { name: "preview_in", optype: "ndiinTOP", x: 900, y: 120 }
      : args.preview_mode === "syphon_spout"
        ? { name: "preview_in", optype: "syphonspoutinTOP", x: 900, y: 120 }
        : null;
  return runExternalShowScaffold(
    ctx,
    {
      kind: "vdmx_workspace",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        vdmx_host: args.vdmx_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        layer_count: args.layer_count,
        clip_count: args.clip_count,
        preview_mode: args.preview_mode,
        active: args.active,
      },
      warnings: [
        "VDMX OSC address mappings are workspace-specific; verify every row against the live VDMX file.",
        "Syphon/Spout preview is macOS/Windows dependent and is not live-validated by this scaffold.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: { netaddress: args.vdmx_host, port: args.send_port, active: args.active ? 1 : 0 },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "layer_map", optype: "tableDAT", x: 300, y: 120, table: layerRows(args) },
        { name: "clip_map", optype: "tableDAT", x: 600, y: 120, table: clipRows(args) },
        ...(previewNode ? [previewNode] : []),
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.vdmx_host],
            ["layer_count", String(args.layer_count)],
            ["clip_count", String(args.clip_count)],
            ["preview_mode", args.preview_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Enable OSC in VDMX, expose Syphon/Spout or NDI preview if needed, then align layer_map and clip_map with the workspace controls.",
        },
      ],
    },
    "connect_vdmx_workspace failed",
    (report) =>
      `Created VDMX workspace scaffold ${report.container_path}; layers ${args.layer_count}; clips ${args.clip_count}.`,
  );
}

export const registerConnectVdmxWorkspace: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_vdmx_workspace",
    {
      title: "Connect VDMX workspace",
      description:
        "Create a VDMX OSC/Syphon workspace scaffold with layer, clip, preview, and setup maps.",
      inputSchema: connectVdmxWorkspaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectVdmxWorkspaceImpl(ctx, args),
  );
};
