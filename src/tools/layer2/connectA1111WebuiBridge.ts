import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectA1111WebuiBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the WebUI scaffold."),
  name: z.string().default("a1111_webui_bridge").describe("Generated baseCOMP name."),
  server_url: z.string().default("http://127.0.0.1:7860").describe("WebUI or adapter base URL."),
  endpoint_kind: z.enum(["txt2img", "img2img", "extras", "controlnet"]).default("txt2img"),
  output_folder: z.string().default("./generated/a1111"),
  prompt_slot_count: z.coerce.number().int().min(1).max(64).default(6),
  include_controlnet: z.boolean().default(false),
  active: z.boolean().default(false),
});

type ConnectA1111WebuiBridgeArgs = z.infer<typeof connectA1111WebuiBridgeSchema>;

function promptRows(args: ConnectA1111WebuiBridgeArgs): string[][] {
  const rows = [["slot", "prompt", "negative_prompt", "seed_hint"]];
  for (let index = 1; index <= args.prompt_slot_count; index += 1) {
    rows.push([`prompt_${index}`, "describe visual target", "artifact, low quality", "operator"]);
  }
  return rows;
}

function resultRows(args: ConnectA1111WebuiBridgeArgs): string[][] {
  const rows = [
    ["route", "role", "path_hint"],
    ["latest_image", "generated still", `${args.output_folder}/latest.png`],
    ["metadata_json", "generation parameters", `${args.output_folder}/latest.json`],
  ];
  if (args.include_controlnet || args.endpoint_kind === "controlnet") {
    rows.push(["control_image", "conditioning image", "route from TOP/export adapter"]);
  }
  return rows;
}

export async function connectA1111WebuiBridgeImpl(
  ctx: ToolContext,
  args: ConnectA1111WebuiBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "a1111_webui_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        server_url: args.server_url,
        endpoint_kind: args.endpoint_kind,
        output_folder: args.output_folder,
        prompt_slot_count: args.prompt_slot_count,
        include_controlnet: args.include_controlnet,
        active: args.active,
      },
      warnings: [
        "This scaffold does not launch WebUI, inspect installed models, or submit prompts.",
        "Keep API auth, extension-specific payloads, and generated-file import in an explicit adapter.",
      ],
      nodes: [
        {
          name: "webui_client",
          optype: "webclientDAT",
          x: 0,
          y: 120,
          params: { url: args.server_url, reqmethod: "POST", active: args.active ? 1 : 0 },
        },
        { name: "prompt_slots", optype: "tableDAT", x: 300, y: 120, table: promptRows(args) },
        { name: "result_map", optype: "tableDAT", x: 600, y: 120, table: resultRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["server_url", args.server_url],
            ["endpoint_kind", args.endpoint_kind],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use prompt_slots and result_map as a stable handoff. An adapter should translate these tables into the exact WebUI extension payload for the installed build.",
        },
      ],
    },
    "connect_a1111_webui_bridge failed",
    (report) =>
      `Created A1111 WebUI bridge ${report.container_path}; endpoint ${args.endpoint_kind}; prompts ${args.prompt_slot_count}.`,
  );
}

export const registerConnectA1111WebuiBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_a1111_webui_bridge",
    {
      title: "Connect A1111 WebUI bridge",
      description:
        "Create an AUTOMATIC1111/Forge Stable Diffusion WebUI handoff scaffold with prompt slots, result maps, ControlNet hints, and adapter notes.",
      inputSchema: connectA1111WebuiBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectA1111WebuiBridgeImpl(ctx, args),
  );
};
