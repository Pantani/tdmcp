import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectUnityOscBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Unity bridge."),
  name: z.string().default("unity_osc_bridge").describe("Generated baseCOMP name."),
  unity_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(9000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9001),
  namespace: z.string().default("/tdmcp"),
  object_count: z.coerce.number().int().min(1).max(256).default(8),
  event_count: z.coerce.number().int().min(1).max(128).default(8),
  preview_mode: z.enum(["none", "ndi", "syphon_spout"]).default("none"),
  active: z.boolean().default(false),
});

type ConnectUnityOscBridgeArgs = z.infer<typeof connectUnityOscBridgeSchema>;

function normalizeNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/\/+$/g, "");
  if (!trimmed) return "/tdmcp";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function objectRows(args: ConnectUnityOscBridgeArgs, namespace: string): string[][] {
  const rows = [["object", "address", "channels"]];
  for (let object = 1; object <= args.object_count; object += 1) {
    rows.push([
      `object_${object}`,
      `${namespace}/object/${object}/transform`,
      "tx ty tz rx ry rz sx sy sz",
    ]);
  }
  return rows;
}

function eventRows(args: ConnectUnityOscBridgeArgs, namespace: string): string[][] {
  const rows = [["event", "address", "value_hint"]];
  for (let event = 1; event <= args.event_count; event += 1) {
    rows.push([`event_${event}`, `${namespace}/event/${event}`, "pulse or json"]);
  }
  return rows;
}

export async function connectUnityOscBridgeImpl(ctx: ToolContext, args: ConnectUnityOscBridgeArgs) {
  const namespace = normalizeNamespace(args.namespace);

  return runExternalShowScaffold(
    ctx,
    {
      kind: "unity_osc_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        unity_host: args.unity_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        namespace,
        object_count: args.object_count,
        event_count: args.event_count,
        preview_mode: args.preview_mode,
        active: args.active,
      },
      warnings: [
        "This scaffold does not validate a Unity OSC/NDI plugin live.",
        "Coordinate units, handedness, and preview transport must be rehearsed in the Unity project.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.unity_host,
            port: args.send_port,
            active: args.active ? 1 : 0,
          },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        {
          name: "object_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: objectRows(args, namespace),
        },
        {
          name: "event_queue",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: eventRows(args, namespace),
        },
        {
          name: "preview_config",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: `Preview mode: ${args.preview_mode}. Configure Unity output and TouchDesigner receive separately.`,
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.unity_host],
            ["namespace", namespace],
            ["object_count", String(args.object_count)],
            ["event_count", String(args.event_count)],
            ["preview_mode", args.preview_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an OSC package in Unity and map object_map/event_queue rows. Validate frame rate, coordinate scale, and preview latency before show use.",
        },
      ],
    },
    "connect_unity_osc_bridge failed",
    (report) =>
      `Created Unity OSC bridge ${report.container_path}; namespace ${namespace}; objects ${args.object_count}.`,
  );
}

export const registerConnectUnityOscBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_unity_osc_bridge",
    {
      title: "Connect Unity OSC bridge",
      description:
        "Create a Unity OSC and preview handoff scaffold for object transforms, events, and NDI/Syphon notes.",
      inputSchema: connectUnityOscBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectUnityOscBridgeImpl(ctx, args),
  );
};
