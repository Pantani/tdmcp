import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectPangolinBeyondSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Pangolin scaffold."),
  name: z.string().default("pangolin_beyond").describe("Generated baseCOMP name."),
  source_mode: z.enum(["sop", "chop"]).default("chop"),
  zone: z.string().default("zone_1"),
  zone_count: z.coerce.number().int().min(1).max(64).default(4),
  cue_count: z.coerce.number().int().min(1).max(256).default(8),
  output_rate: z.coerce.number().min(1).max(100).default(30),
  safety_blackout: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectPangolinBeyondArgs = z.infer<typeof connectPangolinBeyondSchema>;

function zoneRows(args: ConnectPangolinBeyondArgs): string[][] {
  const rows = [["zone", "purpose", "approval"]];
  for (let zone = 1; zone <= args.zone_count; zone += 1) {
    rows.push([`zone_${zone}`, zone === 1 ? "safe preview" : `projector zone ${zone}`, "operator"]);
  }
  return rows;
}

function cueRows(args: ConnectPangolinBeyondArgs): string[][] {
  const rows = [["cue", "command", "approval"]];
  for (let cue = 1; cue <= args.cue_count; cue += 1) {
    rows.push([`cue_${cue}`, `beyond:cue:${cue}`, "operator"]);
  }
  rows.push(["blackout", "beyond:blackout", "required"]);
  return rows;
}

export async function connectPangolinBeyondImpl(ctx: ToolContext, args: ConnectPangolinBeyondArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "pangolin_beyond",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        zone: args.zone,
        zone_count: args.zone_count,
        cue_count: args.cue_count,
        output_rate: args.output_rate,
        safety_blackout: args.safety_blackout,
        active: args.active,
      },
      warnings: [
        "Laser output is hazardous; keep active=false until a trained operator verifies zones, scan rate, and blackout behavior.",
        "This scaffold does not bypass Pangolin Beyond safety controls or send live projector output.",
      ],
      nodes: [
        {
          name: "pangolin",
          optype: "pangolinCHOP",
          x: 0,
          y: 120,
          params: {
            source: args.source_mode,
            zone: args.zone,
            rate: args.output_rate,
            blackout: args.safety_blackout ? 1 : 0,
            active: args.active ? 1 : 0,
          },
        },
        { name: "zone_map", optype: "tableDAT", x: 300, y: 120, table: zoneRows(args) },
        { name: "cue_map", optype: "tableDAT", x: 600, y: 120, table: cueRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["source_mode", args.source_mode],
            ["zone", args.zone],
            ["zone_count", String(args.zone_count)],
            ["cue_count", String(args.cue_count)],
            ["output_rate", String(args.output_rate)],
            ["safety_blackout", String(args.safety_blackout)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Patch Pangolin Beyond only after physical laser safety review. Use cue_map as an operator-approved command manifest and rehearse blackout before show control.",
        },
      ],
    },
    "connect_pangolin_beyond failed",
    (report) =>
      `Created Pangolin Beyond scaffold ${report.container_path}; zones ${args.zone_count}; cues ${args.cue_count}.`,
  );
}

export const registerConnectPangolinBeyond: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_pangolin_beyond",
    {
      title: "Connect Pangolin Beyond",
      description:
        "Create a safety-gated Pangolin Beyond laser-control scaffold with zone maps, cue maps, blackout notes, and no live-output claim.",
      inputSchema: connectPangolinBeyondSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPangolinBeyondImpl(ctx, args),
  );
};
