import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectOscqueryNamespaceSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the OSCQuery scaffold."),
  name: z.string().default("oscquery_namespace").describe("Generated baseCOMP name."),
  service_host: z.string().default("127.0.0.1").describe("OSCQuery HTTP service host."),
  http_port: z.coerce.number().int().min(1).max(65535).default(5678),
  osc_send_port: z.coerce.number().int().min(1).max(65535).default(9000),
  osc_receive_port: z.coerce.number().int().min(1).max(65535).default(9001),
  namespace_root: z.string().default("/").describe("OSCQuery namespace root path."),
  action_count: z.coerce.number().int().min(1).max(128).default(8),
  active: z.boolean().default(false),
});

type ConnectOscqueryNamespaceArgs = z.infer<typeof connectOscqueryNamespaceSchema>;

function actionRows(args: ConnectOscqueryNamespaceArgs): string[][] {
  const root = args.namespace_root === "/" ? "" : args.namespace_root.replace(/\/$/, "");
  const rows = [["label", "osc_address", "value_hint"]];
  for (let index = 1; index <= args.action_count; index += 1) {
    rows.push([`control_${index}`, `${root}/control/${index}`, "0..1"]);
  }
  return rows;
}

export async function connectOscqueryNamespaceImpl(
  ctx: ToolContext,
  args: ConnectOscqueryNamespaceArgs,
) {
  const namespaceUrl = `http://${args.service_host}:${args.http_port}${args.namespace_root}`;
  return runExternalShowScaffold(
    ctx,
    {
      kind: "oscquery_namespace",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        service_host: args.service_host,
        http_port: args.http_port,
        osc_send_port: args.osc_send_port,
        osc_receive_port: args.osc_receive_port,
        namespace_root: args.namespace_root,
        action_count: args.action_count,
        active: args.active,
      },
      warnings: [
        "OSCQuery schemas vary by host application; refresh namespace_map against the live HTTP endpoint before binding.",
        "This scaffold queries the namespace and prepares OSC send/receive nodes, but does not validate the remote service live.",
      ],
      nodes: [
        {
          name: "namespace_http",
          optype: "webclientDAT",
          x: 0,
          y: 120,
          params: { url: namespaceUrl, reqmethod: "GET", active: args.active ? 1 : 0 },
        },
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: -40,
          params: {
            netaddress: args.service_host,
            port: args.osc_send_port,
            active: args.active ? 1 : 0,
          },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 300,
          y: -40,
          params: { port: args.osc_receive_port, active: args.active ? 1 : 0 },
        },
        { name: "action_map", optype: "tableDAT", x: 300, y: 120, table: actionRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["namespace_url", namespaceUrl],
            ["osc_send_port", String(args.osc_send_port)],
            ["osc_receive_port", String(args.osc_receive_port)],
            ["action_count", String(args.action_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Fetch the OSCQuery namespace, copy supported addresses into action_map, then bind CHOP channels to the OSC Out CHOP with the target app running.",
        },
      ],
    },
    "connect_oscquery_namespace failed",
    (report) =>
      `Created OSCQuery namespace scaffold ${report.container_path}; namespace ${namespaceUrl}; actions ${args.action_count}.`,
  );
}

export const registerConnectOscqueryNamespace: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_oscquery_namespace",
    {
      title: "Connect OSCQuery namespace",
      description:
        "Create an OSCQuery HTTP namespace and OSC send/receive scaffold with action maps for live-control apps.",
      inputSchema: connectOscqueryNamespaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectOscqueryNamespaceImpl(ctx, args),
  );
};
