import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const PRIMITIVE_SOP: Record<string, string> = {
  sphere: "sphereSOP",
  box: "boxSOP",
  grid: "gridSOP",
};

export const create3dSceneSchema = z.object({
  primitive: z.enum(["sphere", "box", "grid"]).default("sphere").describe("Geometry to render."),
  instances: z.coerce
    .number()
    .int()
    .positive()
    .default(1)
    .describe("Copies to scatter via GPU instancing on a grid (1 = a single object)."),
  spin: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "Per-instance spin around Y in degrees/sec (0 = still). Each copy rotates in place over time; needs instances > 1.",
    ),
  scale_variation: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Per-instance size variation: 0 = all the same size, 1 = sizes range from 0 to full. Needs instances > 1.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true (default), expose live RotateY (spin) and Zoom (camera distance) knobs."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the 3D-scene container is created (default '/project1')."),
});
type Create3dSceneArgs = z.infer<typeof create3dSceneSchema>;

export async function create3dSceneImpl(ctx: ToolContext, args: Create3dSceneArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "scene3d");

    // Geometry COMP (the builder clears its default torus), with the chosen primitive SOP
    // inside it, flagged for render + display so the COMP renders it.
    const geo = await builder.add("geometryCOMP", "geo");
    const shape = await builder.add(PRIMITIVE_SOP[args.primitive] as string, "shape", {}, geo);
    await builder.python(`_s = op(${q(shape)})\n_s.render = True\n_s.display = True`);

    // Instancing: scatter `instances` copies over a grid of points; the Geometry COMP renders the
    // shape once per point. instanceop needs the full path, and tx/ty/tz map to the point P attrs.
    const cols = Math.ceil(Math.sqrt(args.instances));
    const rows = Math.ceil(args.instances / cols);
    const spacing = 2.5;
    if (args.instances > 1) {
      const points = await builder.add(
        "gridSOP",
        "points",
        {
          rows,
          cols,
          sizex: Math.max(1, cols - 1) * spacing,
          sizey: Math.max(1, rows - 1) * spacing,
        },
        geo,
      );
      await builder.python(`_p = op(${q(points)})\n_p.render = False\n_p.display = False`);

      // Scale variation: a Point SOP writes a per-point `pscale` attribute (random per point via
      // tdu.rand), and instancesx/sy/sz read it so each copy gets its own size. Range is
      // [1 - variation, 1] — at variation 1 some copies shrink toward 0, at 0 it stays uniform.
      let instanceSrc = points;
      if (args.scale_variation > 0) {
        const pscale = await builder.add("pointSOP", "pscale", {}, geo);
        await builder.connect(points, pscale);
        const lo = Number((1 - args.scale_variation).toFixed(4));
        const rng = Number(args.scale_variation.toFixed(4));
        await builder.python(
          `_p = op(${q(pscale)})\n_p.par.dopscale = True\n_p.par.pscale.expr = ${q(`${lo} + ${rng}*tdu.rand(me.inputPoint.index)`)}\n_p.render = False\n_p.display = False`,
        );
        instanceSrc = pscale;
      }

      const instanceParams: Record<string, unknown> = {
        instancing: 1,
        instanceop: instanceSrc,
        instancetx: "P(0)",
        instancety: "P(1)",
        instancetz: "P(2)",
      };
      if (args.scale_variation > 0) {
        instanceParams.instancesx = "pscale";
        instanceParams.instancesy = "pscale";
        instanceParams.instancesz = "pscale";
      }
      await builder.setParams(geo, instanceParams);

      // Per-instance spin: an expression on instancery (auto-switches the param to EXPRESSION mode)
      // rotates every copy around its own Y axis over time.
      if (args.spin > 0) {
        await builder.python(
          `op(${q(geo)}).par.instancery.expr = ${q(`absTime.seconds * ${args.spin}`)}`,
        );
      }
    }

    const camDist = args.instances > 1 ? Math.max(cols, rows) * spacing + 6 : 5;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (not wires): camera, geometry, lights.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "RotateY", type: "float", min: 0, max: 360, default: 0, bind_to: [`${geo}.ry`] },
          {
            name: "Zoom",
            type: "float",
            min: 1,
            max: camDist * 3,
            default: camDist,
            bind_to: [`${cam}.tz`],
          },
        ]
      : [];

    const instanceNote =
      args.instances > 1
        ? ` ×${args.instances} instanced${args.scale_variation > 0 ? ", varied scale" : ""}${args.spin > 0 ? `, ${args.spin}°/s spin` : ""}`
        : "";
    return finalize(ctx, {
      summary: `Built a 3D scene (${args.primitive}${instanceNote}) rendered to ${out} — Geometry + Camera + Light + Render TOP.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        primitive: args.primitive,
        instances: args.instances,
        spin: args.spin,
        scale_variation: args.scale_variation,
        geometry: geo,
        camera: cam,
        render,
        output_path: out,
      },
    });
  });
}

export const registerCreate3dScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_3d_scene",
    {
      title: "Create 3D scene",
      description:
        "Build a renderable 3D scene: a Geometry COMP holding the chosen primitive (sphere/box/grid), a Camera, a Light, and a Render TOP, output as a Null. Creates a new baseCOMP under `parent_path` holding all of these — optionally instanced into a grid of `instances` copies via GPU instancing, with `scale_variation` for per-copy random sizes and `spin` for per-copy rotation over time. Exposes RotateY (whole-scene spin) and Zoom (camera distance) knobs. The starting point for 3D visuals — bind RotateY to a tempo ramp or an audio feature to make it move. Use create_3d_audio_reactive instead when you want the geometry driven by sound, or create_pbr_scene for physically-based materials. Returns a summary plus a JSON block with the container path, created node paths, the geometry/camera/render/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: create3dSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => create3dSceneImpl(ctx, args),
  );
};
