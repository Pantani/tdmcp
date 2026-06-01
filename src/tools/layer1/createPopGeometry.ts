import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// Primitive → SOP type. Lines + text need their own create-step (text uses a
// textSOP with a default string), grid is 2D, the rest are 3D parametric solids.
const PRIMITIVE_SOP: Record<string, string> = {
  box: "boxSOP",
  sphere: "sphereSOP",
  tube: "tubeSOP",
  torus: "torusSOP",
  grid: "gridSOP",
  line: "lineSOP",
  text: "textSOP",
};

const vec3 = (def: readonly [number, number, number]) =>
  z
    .tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()])
    .default([def[0], def[1], def[2]]);

export const createPopGeometrySchema = z.object({
  primitive: z
    .enum(["box", "sphere", "tube", "torus", "grid", "line", "text"])
    .default("box")
    .describe(
      "Base geometry primitive. Each maps to its stock SOP (boxSOP/sphereSOP/tubeSOP/torusSOP/gridSOP/lineSOP/textSOP).",
    ),
  translate: vec3([0, 0, 0]).describe(
    "Translation [tx,ty,tz] applied via a Transform SOP after the primitive.",
  ),
  rotate: vec3([0, 0, 0]).describe(
    "Rotation [rx,ry,rz] in degrees applied via the same Transform SOP.",
  ),
  scale: vec3([1, 1, 1]).describe(
    "Per-axis scale [sx,sy,sz] applied via the same Transform SOP. [1,1,1] = unchanged.",
  ),
  subdivisions: z.coerce
    .number()
    .int()
    .min(0)
    .max(8)
    .default(0)
    .describe(
      "Optional subdivision count. When > 0 a Subdivide SOP runs after the Transform SOP at this depth, then a per-point Noise SOP works on the denser mesh.",
    ),
  noise_amount: z.coerce
    .number()
    .min(0)
    .max(5)
    .default(0)
    .describe(
      "Displacement amount of the per-point Noise SOP (0 = bypassed; ~0.1..1 typical for organic warp).",
    ),
  noise_period: z.coerce
    .number()
    .min(0.01)
    .default(1)
    .describe(
      "Spatial period of the displacement noise. Larger = wider/softer ripples; smaller = tighter detail.",
    ),
  text_string: z
    .string()
    .default("tdmcp")
    .describe(
      "When `primitive` is 'text', the string fed into the textSOP. Ignored for other primitives.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live NoiseAmount + NoisePeriod + RotateY knobs on the container.",
    ),
  base_name: z
    .string()
    .optional()
    .describe(
      "Optional base name for the container (defaults to 'pop_geometry'). Final container path is `<parent_path>/<base_name>` with TD's auto-suffix.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the POP geometry container is created (default '/project1')."),
});
export type CreatePopGeometryArgs = z.infer<typeof createPopGeometrySchema>;

export async function createPopGeometryImpl(ctx: ToolContext, args: CreatePopGeometryArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(
      ctx,
      args.parent_path,
      args.base_name ?? "pop_geometry",
    );

    // The Geometry COMP renders its internal SOP chain; we build the chain inside it,
    // then mark the LAST SOP as render+display. The default torus the builder leaves
    // in geometryCOMP is overridden by toggling our chain on instead.
    const geo = await builder.add("geometryCOMP", "geo");

    // 1) Primitive SOP inside the Geometry COMP.
    const primType = PRIMITIVE_SOP[args.primitive] as string;
    const primParams: Record<string, unknown> = {};
    if (args.primitive === "text") primParams.text = args.text_string;
    const prim = await builder.add(primType, "prim", primParams, geo);

    // 2) Transform SOP — translate, rotate, scale.
    const [tx, ty, tz] = args.translate;
    const [rx, ry, rz] = args.rotate;
    const [sx, sy, sz] = args.scale;
    const xform = await builder.add(
      "transformSOP",
      "xform",
      { tx, ty, tz, rx, ry, rz, sx, sy, sz },
      geo,
    );
    await builder.connect(prim, xform);

    // 3) Optional subdivide + noise displacement chain.
    let last = xform;
    if (args.subdivisions > 0) {
      const sub = await builder.add("subdivideSOP", "subdiv", { depth: args.subdivisions }, geo);
      await builder.connect(xform, sub);
      last = sub;
    }
    if (args.noise_amount > 0) {
      const noise = await builder.add(
        "noiseSOP",
        "displace",
        { amp: args.noise_amount, period: args.noise_period },
        geo,
      );
      await builder.connect(last, noise);
      last = noise;
    }

    // 4) Material SOP (assigns a constantMAT for stable shading; the Render TOP
    //    picks up the assignment when the COMP renders the SOP).
    const mat = await builder.add("constantMAT", "mat", { colorr: 0.9, colorg: 0.9, colorb: 1.0 });
    const matSop = await builder.add("materialSOP", "matSop", { material: mat }, geo);
    await builder.connect(last, matSop);

    // 5) Null SOP for stable output reference inside the COMP.
    const nullSop = await builder.add("nullSOP", "out_sop", {}, geo);
    await builder.connect(matSop, nullSop);

    // Mark the Null SOP as render+display so the Geometry COMP draws our chain.
    await builder.python(
      `_n = op(${q(nullSop)})\n_n.render = True\n_n.display = True\n` +
        `_p = op(${q(prim)})\n_p.render = False\n_p.display = False`,
    );

    // 6) Camera + Light + Render TOP at container level.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "RotateY",
            type: "float",
            min: 0,
            max: 360,
            default: 0,
            bind_to: [`${geo}.ry`],
          },
          {
            name: "NoiseAmount",
            type: "float",
            min: 0,
            max: 5,
            default: args.noise_amount,
            bind_to: args.noise_amount > 0 ? [`${geo}/displace.amp`] : [],
          },
          {
            name: "NoisePeriod",
            type: "float",
            min: 0.01,
            max: 10,
            default: args.noise_period,
            bind_to: args.noise_amount > 0 ? [`${geo}/displace.period`] : [],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built POP geometry (${args.primitive}${
        args.subdivisions > 0 ? `, subdiv ${args.subdivisions}` : ""
      }${args.noise_amount > 0 ? `, noise ${args.noise_amount}` : ""}) rendered to ${out}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        primitive: args.primitive,
        translate: args.translate,
        rotate: args.rotate,
        scale: args.scale,
        subdivisions: args.subdivisions,
        noise_amount: args.noise_amount,
        noise_period: args.noise_period,
        primitive_path: prim,
        transform_path: xform,
        material_path: mat,
        geometry_path: geo,
        render_path: render,
        output_path: out,
      },
    });
  });
}

export const registerCreatePopGeometry: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pop_geometry",
    {
      title: "Create POP geometry",
      description:
        "Procedural Op Pattern (POP) geometry generator: build a SOP chain inside a Geometry COMP — primitive (box/sphere/tube/torus/grid/line/text) → Transform SOP (translate/rotate/scale) → optional Subdivide SOP → optional per-point Noise SOP displacement → Material SOP (Constant MAT) → Null SOP — then render through a Camera + Light + Render TOP to a Null TOP. Creates a new baseCOMP under `parent_path`. Exposes RotateY, NoiseAmount and NoisePeriod controls. Use build_sop_geometry for a fully declarative SOP chain without a render rig; use create_3d_scene for instanced primitives, create_pbr_scene for PBR shading.",
      inputSchema: createPopGeometrySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPopGeometryImpl(ctx, args),
  );
};
