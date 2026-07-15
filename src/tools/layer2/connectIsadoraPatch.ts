import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectIsadoraPatchSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Isadora scaffold."),
  name: z.string().default("isadora_patch").describe("Generated baseCOMP name."),
  isadora_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(1234),
  receive_port: z.coerce.number().int().min(1).max(65535).default(1235),
  namespace: z.string().default("/tdmcp"),
  scene_count: z.coerce.number().int().min(1).max(128).default(4),
  actor_count: z.coerce.number().int().min(1).max(256).default(8),
  watcher_count: z.coerce.number().int().min(0).max(128).default(4),
  active: z.boolean().default(false),
});

type ConnectIsadoraPatchArgs = z.infer<typeof connectIsadoraPatchSchema>;

function normalizeNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/\/+$/g, "");
  if (!trimmed) return "/tdmcp";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function actorRows(args: ConnectIsadoraPatchArgs, namespace: string): string[][] {
  const rows = [["label", "address", "value_hint"]];
  for (let scene = 1; scene <= args.scene_count; scene += 1) {
    rows.push([`scene ${scene} activate`, `${namespace}/scene/${scene}/activate`, "pulse"]);
  }
  for (let actor = 1; actor <= args.actor_count; actor += 1) {
    rows.push([`actor ${actor} value`, `${namespace}/actor/${actor}/value`, "0..1"]);
  }
  return rows;
}

function watcherRows(args: ConnectIsadoraPatchArgs, namespace: string): string[][] {
  const rows = [["watcher", "address", "direction"]];
  for (let watcher = 1; watcher <= args.watcher_count; watcher += 1) {
    rows.push([`watcher_${watcher}`, `${namespace}/watcher/${watcher}`, "isadora_to_td"]);
  }
  return rows;
}

export async function connectIsadoraPatchImpl(ctx: ToolContext, args: ConnectIsadoraPatchArgs) {
  const namespace = normalizeNamespace(args.namespace);

  return runExternalShowScaffold(
    ctx,
    {
      kind: "isadora_patch",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        isadora_host: args.isadora_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        namespace,
        scene_count: args.scene_count,
        actor_count: args.actor_count,
        watcher_count: args.watcher_count,
        active: args.active,
      },
      warnings: [
        "This scaffold does not launch Isadora or validate actor/watcher addresses live.",
        "Keep the namespace stable and confirm scene/actor numbering in the target patch.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.isadora_host,
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
          name: "actor_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: actorRows(args, namespace),
        },
        {
          name: "watcher_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: watcherRows(args, namespace),
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.isadora_host],
            ["namespace", namespace],
            ["scene_count", String(args.scene_count)],
            ["actor_count", String(args.actor_count)],
            ["watcher_count", String(args.watcher_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Create matching OSC Listener/Broadcaster actors in Isadora. Use actor_map and watcher_map as the stable TouchDesigner/Isadora contract.",
        },
      ],
    },
    "connect_isadora_patch failed",
    (report) =>
      `Created Isadora patch scaffold ${report.container_path}; namespace ${namespace}; actors ${args.actor_count}.`,
  );
}

export const registerConnectIsadoraPatch: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_isadora_patch",
    {
      title: "Connect Isadora patch",
      description:
        "Create an Isadora OSC actor, watcher, and scene exchange scaffold with stable namespace mapping.",
      inputSchema: connectIsadoraPatchSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectIsadoraPatchImpl(ctx, args),
  );
};
