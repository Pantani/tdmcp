import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectHomeassistantStateBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Home Assistant scaffold."),
  name: z.string().default("homeassistant_state_bus").describe("Generated baseCOMP name."),
  base_url: z.string().default("http://homeassistant.local:8123"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("websocket_json"),
  entity_domain: z.enum(["sensor", "light", "switch", "media_player", "climate"]).default("sensor"),
  entity_count: z.coerce.number().int().min(1).max(256).default(12),
  service_count: z.coerce.number().int().min(0).max(128).default(4),
  area_count: z.coerce.number().int().min(0).max(64).default(3),
  active: z.boolean().default(false),
});

type ConnectHomeassistantStateBusArgs = z.infer<typeof connectHomeassistantStateBusSchema>;

function sourceNode(args: ConnectHomeassistantStateBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "rest_json") {
    return {
      name: "ha_rest_client",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.base_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_state_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste Home Assistant state snapshots into entity_map.",
    };
  }
  return {
    name: "ha_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: websocketDatParams(args.base_url, args.active),
  };
}

function entityRows(args: ConnectHomeassistantStateBusArgs): string[][] {
  const rows = [["entity_id", "domain", "state_binding", "area"]];
  const areaModulo = Math.max(1, args.area_count);
  for (let index = 1; index <= args.entity_count; index += 1) {
    rows.push([
      `${args.entity_domain}.tdmcp_${index}`,
      args.entity_domain,
      `ha_state_${index}`,
      args.area_count > 0 ? `area_${((index - 1) % areaModulo) + 1}` : "unassigned",
    ]);
  }
  return rows;
}

function serviceRows(args: ConnectHomeassistantStateBusArgs): string[][] {
  const rows = [["service", "domain", "policy"]];
  for (let index = 1; index <= args.service_count; index += 1) {
    rows.push([`service_${index}`, args.entity_domain, "approval_required"]);
  }
  if (args.service_count === 0) {
    rows.push(["none", args.entity_domain, "read_only"]);
  }
  return rows;
}

export async function connectHomeassistantStateBusImpl(
  ctx: ToolContext,
  args: ConnectHomeassistantStateBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "homeassistant_state_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        base_url: args.base_url,
        adapter_mode: args.adapter_mode,
        entity_domain: args.entity_domain,
        entity_count: args.entity_count,
        service_count: args.service_count,
        area_count: args.area_count,
        active: args.active,
      },
      warnings: [
        "Home Assistant tokens are intentionally not stored in this scaffold.",
        "Service calls may affect physical devices; keep them approval-gated and disabled until venue policy allows them.",
      ],
      nodes: [
        sourceNode(args),
        { name: "entity_map", optype: "tableDAT", x: 300, y: 120, table: entityRows(args) },
        { name: "service_map", optype: "tableDAT", x: 600, y: 120, table: serviceRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["base_url", args.base_url],
            ["adapter_mode", args.adapter_mode],
            ["entity_domain", args.entity_domain],
            ["active", String(args.active)],
          ],
        },
        {
          name: "safety_policy",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Default policy: read entity state only. Any service call that touches lights, switches, HVAC, media, or venue devices requires explicit operator approval.",
        },
      ],
    },
    "connect_homeassistant_state_bus failed",
    (report) =>
      `Created Home Assistant state bus ${report.container_path}; entities ${args.entity_count}; services ${args.service_count}.`,
  );
}

export const registerConnectHomeassistantStateBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_homeassistant_state_bus",
    {
      title: "Connect Home Assistant state bus",
      description:
        "Create a Home Assistant state/service scaffold with REST/WebSocket adapter nodes, entity maps, service maps, and physical-action safety notes.",
      inputSchema: connectHomeassistantStateBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectHomeassistantStateBusImpl(ctx, args),
  );
};
