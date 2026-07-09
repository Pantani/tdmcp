import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectAbletonLinkSessionSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Link scaffold."),
  name: z.string().default("ableton_link_session").describe("Generated baseCOMP name."),
  tempo_hint: z.coerce.number().min(20).max(300).default(120),
  signature: z.coerce.number().int().min(1).max(16).default(4),
  export_bars: z.coerce.number().int().min(1).max(128).default(8),
  start_stop_sync: z.boolean().default(false),
  active: z.boolean().default(false),
});

type ConnectAbletonLinkSessionArgs = z.infer<typeof connectAbletonLinkSessionSchema>;

function beatRows(args: ConnectAbletonLinkSessionArgs): string[][] {
  const rows = [["bar", "beat", "channel_hint"]];
  for (let bar = 1; bar <= args.export_bars; bar += 1) {
    for (let beat = 1; beat <= args.signature; beat += 1) {
      rows.push([String(bar), String(beat), `bar_${bar}_beat_${beat}`]);
    }
  }
  return rows;
}

export async function connectAbletonLinkSessionImpl(
  ctx: ToolContext,
  args: ConnectAbletonLinkSessionArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ableton_link_session",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        tempo_hint: args.tempo_hint,
        signature: args.signature,
        export_bars: args.export_bars,
        start_stop_sync: args.start_stop_sync,
        active: args.active,
      },
      warnings: [
        "Ableton Link follows the local Link session; tempo_hint is documentation for the show, not a forced remote tempo.",
        "Start/stop sync should be rehearsed with every Link participant before show operation.",
      ],
      nodes: [
        {
          name: "link",
          optype: "abletonlinkCHOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            enable: args.active ? 1 : 0,
            startstopsync: args.start_stop_sync ? 1 : 0,
            signature: args.signature,
          },
        },
        { name: "beat_map", optype: "tableDAT", x: 300, y: 120, table: beatRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["tempo_hint", String(args.tempo_hint)],
            ["signature", String(args.signature)],
            ["export_bars", String(args.export_bars)],
            ["start_stop_sync", String(args.start_stop_sync)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Use Ableton Link CHOP channels for bar, beat, phase, pulse, and count exports. Bind beat_map rows to cue engines or modulators after rehearsal.",
        },
      ],
    },
    "connect_ableton_link_session failed",
    (report) =>
      `Created Ableton Link session scaffold ${report.container_path}; ${args.export_bars} bar map at ${args.signature}/4.`,
  );
}

export const registerConnectAbletonLinkSession: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_ableton_link_session",
    {
      title: "Connect Ableton Link session",
      description:
        "Create an Ableton Link timing scaffold with beat/bar maps for tempo-locked visual systems.",
      inputSchema: connectAbletonLinkSessionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectAbletonLinkSessionImpl(ctx, args),
  );
};
