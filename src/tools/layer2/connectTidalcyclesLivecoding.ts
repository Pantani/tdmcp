import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectTidalcyclesLivecodingSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Tidal scaffold."),
  name: z.string().default("tidalcycles_livecoding").describe("Generated baseCOMP name."),
  tidal_host: z.string().default("127.0.0.1").describe("TidalCycles/SuperDirt OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(57120),
  receive_port: z.coerce.number().int().min(1).max(65535).default(6010),
  orbit_count: z.coerce.number().int().min(1).max(32).default(4),
  pattern_count: z.coerce.number().int().min(1).max(128).default(8),
  active: z.boolean().default(false),
});

type ConnectTidalcyclesLivecodingArgs = z.infer<typeof connectTidalcyclesLivecodingSchema>;

function patternRows(args: ConnectTidalcyclesLivecodingArgs): string[][] {
  const rows = [["pattern", "osc_address", "value_hint"]];
  for (let pattern = 1; pattern <= args.pattern_count; pattern += 1) {
    rows.push([`pattern_${pattern}`, `/tidal/pattern/${pattern}`, "trigger|density|gain"]);
  }
  return rows;
}

function orbitRows(args: ConnectTidalcyclesLivecodingArgs): string[][] {
  const rows = [["orbit", "event_address", "visual_bus"]];
  for (let orbit = 0; orbit < args.orbit_count; orbit += 1) {
    rows.push([String(orbit), `/dirt/play/${orbit}`, `orbit_${orbit}_energy`]);
  }
  return rows;
}

export async function connectTidalcyclesLivecodingImpl(
  ctx: ToolContext,
  args: ConnectTidalcyclesLivecodingArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "tidalcycles_livecoding",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        tidal_host: args.tidal_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        orbit_count: args.orbit_count,
        pattern_count: args.pattern_count,
        active: args.active,
      },
      warnings: [
        "This scaffold maps OSC only; it does not run TidalCycles, SuperDirt, or SuperCollider.",
        "Live-coded audio events should be smoothed before driving bright visual or physical outputs.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.tidal_host,
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
        { name: "pattern_map", optype: "tableDAT", x: 300, y: 120, table: patternRows(args) },
        { name: "orbit_map", optype: "tableDAT", x: 600, y: 120, table: orbitRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.tidal_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["orbit_count", String(args.orbit_count)],
            ["pattern_count", String(args.pattern_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run TidalCycles/SuperDirt separately, mirror SuperDirt OSC events into osc_in, then bind orbit_map energy channels to visual controls.",
        },
      ],
    },
    "connect_tidalcycles_livecoding failed",
    (report) =>
      `Created TidalCycles live-coding scaffold ${report.container_path}; patterns ${args.pattern_count}; orbits ${args.orbit_count}.`,
  );
}

export const registerConnectTidalcyclesLivecoding: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_tidalcycles_livecoding",
    {
      title: "Connect TidalCycles live coding",
      description:
        "Create a TidalCycles/SuperDirt OSC scaffold with pattern and orbit maps for live-coded audiovisual sets.",
      inputSchema: connectTidalcyclesLivecodingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTidalcyclesLivecodingImpl(ctx, args),
  );
};
