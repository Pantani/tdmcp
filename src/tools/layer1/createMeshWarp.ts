import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Per-warp expression that drives a grid point's Z from its planar (X, Y) position. `A`
 * is substituted with the deformation amount. The grid lives in the XY plane, so pushing
 * Pz bends a flat sheet into a curved surface. These are *expressions* evaluated per point
 * (TouchDesigner exposes the incoming point as `me.inputPoint`), so the source X/Y are read
 * via `me.inputPoint.x` / `me.inputPoint.y`.
 */
const WARP_PZ_EXPR: Record<"bulge" | "wave" | "cylinder", (amount: string) => string> = {
  // Dome: highest at centre, falling to the rim (a paraboloid).
  bulge: (a) => `${a} * (1 - (me.inputPoint.x*me.inputPoint.x + me.inputPoint.y*me.inputPoint.y))`,
  // Ripples running across X.
  wave: (a) => `${a} * sin(me.inputPoint.x * 6.283185)`,
  // Half-cylinder: the sheet wraps around the X axis.
  cylinder: (a) => `${a} * cos(me.inputPoint.x * 3.141593)`,
};

export const createMeshWarpSchema = z.object({
  source_path: z
    .string()
    .describe("Path of the TOP to map onto the surface (brought in through a Select TOP)."),
  rows: z.coerce
    .number()
    .int()
    .min(2)
    .default(20)
    .describe("Grid rows — more rows give a smoother curve but a heavier mesh."),
  cols: z.coerce
    .number()
    .int()
    .min(2)
    .default(20)
    .describe("Grid columns — more columns give a smoother curve but a heavier mesh."),
  warp: z
    .enum(["bulge", "wave", "cylinder", "flat"])
    .default("bulge")
    .describe(
      "Surface shape: bulge (dome), wave (ripples across X), cylinder (half-cylinder wrap), or flat (no deform).",
    ),
  amount: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("Deformation strength (0 = flat, 1 = full bend). Ignored when warp is 'flat'."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true (default), expose a live Zoom (camera distance) knob."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the mesh-warp container is created (default '/project1')."),
});
type CreateMeshWarpArgs = z.infer<typeof createMeshWarpSchema>;

export async function createMeshWarpImpl(ctx: ToolContext, args: CreateMeshWarpArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "mesh_warp");

    // Source texture brought in via a Select TOP so it can live in another container.
    const src = await builder.add("selectTOP", "src", { top: args.source_path });

    // Geometry COMP (the builder clears its default torus) holding a grid in the XY plane.
    const geo = await builder.add("geometryCOMP", "geo");
    const surface = await builder.add(
      "gridSOP",
      "surface",
      { rows: args.rows, cols: args.cols, orient: "xy" },
      geo,
    );

    // Deform the grid by pushing each point's Z from its planar position, bending the flat
    // sheet into the chosen curved surface. The deformed SOP becomes the one the COMP renders.
    if (args.warp !== "flat") {
      const deform = await builder.add("pointSOP", "deform", {}, geo);
      await builder.connect(surface, deform);
      const amount = Number(args.amount.toFixed(4)).toString();
      const pzExpr = WARP_PZ_EXPR[args.warp](amount);
      // The Point SOP's tx/ty/tz are per-point translate expressions (the incoming point is
      // `me.inputPoint`), so the Z translate alone bends the flat sheet — no enable toggle needed.
      await builder.python(
        `_p = op(${q(deform)})\n_p.par.tz.expr = ${q(pzExpr)}\n_p.render = True\n_p.display = True`,
      );
      // The undeformed grid must stop being rendered so only the deformed surface shows.
      await builder.python(`_s = op(${q(surface)})\n_s.render = False\n_s.display = False`);
    } else {
      // Flat: render the grid directly.
      await builder.python(`_s = op(${q(surface)})\n_s.render = True\n_s.display = True`);
    }

    // Texture the surface with the source via a Constant MAT (its Color Map = the src TOP).
    const mat = await builder.add("constantMAT", "mat");
    await builder.python(`op(${q(mat)}).par.colormap = ${q(src)}`);
    await builder.setParams(geo, { material: mat });

    // Orthographic camera (no perspective distortion, which reads better for surface mapping),
    // tilted down a little so the curvature of the warped surface is visible rather than hidden
    // behind a head-on view. Reset rx/ty to 0 for a flat, projector-aligned mapping render.
    const cam = await builder.add("cameraCOMP", "cam", {
      tz: 5,
      ty: 1.4,
      rx: -22,
      projection: "ortho",
    });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    // Render TOP reads its scene from parameters (not wires): camera, geometry, lights.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Zoom (camera distance) binds cleanly. WarpAmount is driven by a per-point SOP expression,
    // not a single bindable parameter, so we do not fake a knob for it.
    const controls: ControlSpec[] = args.expose_controls
      ? [{ name: "Zoom", type: "float", min: 1, max: 20, default: 5, bind_to: [`${cam}.tz`] }]
      : [];
    if (args.expose_controls && args.warp !== "flat") {
      builder.warnings.push(
        "⚠ WarpAmount is baked into the deform expression (no single bindable param) — to make it live-tunable, add a custom WarpAmount par on the container and reference it inside the tz expression.",
      );
    }

    const warpNote = args.warp === "flat" ? "flat (no deform)" : `${args.warp} @ ${args.amount}`;
    return finalize(ctx, {
      summary: `Built a mesh-warp surface (${warpNote}, ${args.rows}×${args.cols} grid) rendered to ${out} — Select → Geometry(grid+deform, textured by Constant MAT) → Camera + Light + Render TOP. Send ${out} to setup_output.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source_path: args.source_path,
        rows: args.rows,
        cols: args.cols,
        warp: args.warp,
        amount: args.amount,
        output_path: out,
      },
    });
  });
}

export const registerCreateMeshWarp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_mesh_warp",
    {
      title: "Create mesh warp",
      description:
        "Map a source TOP onto a curved or irregular surface via a deformable textured grid — the curved-surface upgrade to create_projection_mapping's flat corner-pin, for domes, columns, and sculptures. Builds a Geometry COMP holding a grid that is bent into a dome (bulge), ripples (wave), half-cylinder (cylinder), or left flat, textured with the source through a Constant MAT, and rendered through an orthographic Camera + Light + Render TOP. Creates a new baseCOMP under `parent_path` holding all of these; output is a Null ready for setup_output; exposes a Zoom knob. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createMeshWarpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMeshWarpImpl(ctx, args),
  );
};
