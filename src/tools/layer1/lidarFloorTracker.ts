import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const FLOOR_SHADER = `out vec4 fragColor;
void main() {
  vec2 uv = vUV.st;
  vec2 g = abs(fract(uv * vec2(12.0, 8.0)) - 0.5);
  float grid = step(min(g.x, g.y), 0.015);
  float zone = step(abs(uv.x - 0.5), 0.01) + step(abs(uv.y - 0.5), 0.01);
  vec3 col = mix(vec3(0.01, 0.015, 0.02), vec3(0.1, 0.7, 1.0), grid);
  col = mix(col, vec3(1.0, 0.35, 0.05), clamp(zone, 0.0, 1.0));
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}`;

export const lidarFloorTrackerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP path to build inside."),
  name: z.string().default("lidar_floor_tracker").describe("Generated container name."),
  sensor: z
    .enum(["synthetic", "ouster", "leuze_rod4", "udp_points"])
    .default("synthetic")
    .describe("Sensor scaffold to create. Hardware modes stay inactive by default."),
  sensor_address: z.string().optional().describe("IP address for Ouster/Leuze hardware modes."),
  port: z.coerce.number().int().positive().default(7502).describe("UDP/network input port."),
  floor_width_m: z.coerce.number().positive().default(6).describe("Tracked floor width in meters."),
  floor_depth_m: z.coerce.number().positive().default(4).describe("Tracked floor depth in meters."),
  threshold: z.coerce.number().min(0).max(1).default(0.35).describe("Occupancy threshold."),
  active: z
    .boolean()
    .default(false)
    .describe("Enable live hardware input immediately. Defaults false for rehearsal safety."),
  expose_controls: z.boolean().default(true).describe("Expose Threshold and Scale controls."),
});
type LidarFloorTrackerArgs = z.infer<typeof lidarFloorTrackerSchema>;

export async function lidarFloorTrackerImpl(ctx: ToolContext, args: LidarFloorTrackerArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    let source: string;
    if (args.sensor === "ouster") {
      source = await builder.add("ousterTOP", "ouster_lidar", {
        deviceaddress: args.sensor_address,
        lidarport: args.port,
        active: args.active,
      });
    } else if (args.sensor === "leuze_rod4") {
      source = await builder.add("leuzeROD4CHOP", "leuze_lidar", {
        netaddress: args.sensor_address,
        port: args.port,
        active: args.active,
      });
    } else if (args.sensor === "udp_points") {
      source = await builder.add("udpInDAT", "udp_points", {
        port: args.port,
        active: args.active,
      });
    } else {
      source = await builder.add("constantCHOP", "synthetic_points", {
        name0: "x",
        value0: 0,
        name1: "y",
        value1: 0,
        name2: "intensity",
        value2: 1,
        name3: "id",
        value3: 1,
      });
    }

    const points =
      args.sensor === "ouster"
        ? await builder.add("toptoCHOP", "points_from_ouster", { top: source })
        : args.sensor === "udp_points"
          ? await builder.add("dattoCHOP", "points_from_udp", { dat: source })
          : source;
    if (points !== source) await builder.connect(source, points);

    const normalize = await builder.add("mathCHOP", "normalize_floor", {
      fromrange1: -1,
      torange1: 1,
    });
    await builder.connect(points, normalize);
    const occupancy = await builder.add("logicCHOP", "occupancy", {
      convert: "bound",
      boundmin: args.threshold,
      boundmax: 1,
    });
    await builder.connect(normalize, occupancy);
    const outChop = await builder.add("nullCHOP", "tracked_points");
    await builder.connect(occupancy, outChop);

    const preview = await builder.add("glslTOP", "floor_preview", {
      resolutionw: 1280,
      resolutionh: 720,
    });
    const frag = await builder.add("textDAT", "floor_preview_frag");
    await builder.python(
      `op(${q(frag)}).text = ${q(FLOOR_SHADER)}\nop(${q(preview)}).par.pixeldat = op(${q(frag)}).name`,
    );
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(preview, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: args.threshold,
            bind_to: [`${occupancy}.boundmin`],
          },
          {
            name: "Scale",
            type: "float",
            min: 0.1,
            max: 10,
            default: 1,
            bind_to: [`${normalize}.gain`],
          },
        ]
      : [];

    if (args.sensor !== "synthetic") {
      builder.warnings.push(
        `${args.sensor} hardware path is scaffolded but UNVERIFIED until the sensor is connected and tracked_points channels are inspected live.`,
      );
    }

    return finalize(ctx, {
      summary: `Built a ${args.sensor} LiDAR floor tracker scaffold with CHOP output ${outChop} and preview ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        sensor: args.sensor,
        source,
        output_chop: outChop,
        output_top: out,
        floor_width_m: args.floor_width_m,
        floor_depth_m: args.floor_depth_m,
        live_validation: args.sensor === "synthetic" ? "offline-synthetic" : "UNVERIFIED-hardware",
      },
    });
  });
}

export const registerLidarFloorTracker: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "lidar_floor_tracker",
    {
      title: "LiDAR floor tracker",
      description:
        "Build a floor-occupancy tracker scaffold for synthetic rehearsal, Ouster TOP, Leuze ROD4 CHOP, or UDP point input. Produces a tracked_points CHOP plus a floor preview TOP; hardware modes default inactive and remain explicitly unverified until a real sensor is connected.",
      inputSchema: lidarFloorTrackerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => lidarFloorTrackerImpl(ctx, args),
  );
};
