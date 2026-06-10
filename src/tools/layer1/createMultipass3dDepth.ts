import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

// Createable op type per primitive. `torusSOP` is the default — the richest read of SSAO
// contact shadows. (The geometryCOMP's default torus is cleared by the builder, so we add
// our own named SOP regardless of the chosen primitive.)
const PRIMITIVE_SOP: Record<string, string> = {
  sphere: "sphereSOP",
  box: "boxSOP",
  torus: "torusSOP",
  grid: "gridSOP",
};

export const multipass3dDepthSchema = z.object({
  name: z
    .string()
    .default("multipass_3d")
    .describe("Name of the self-contained container created under parent_path."),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent COMP path the multipass 3D container is created inside (default '/project1').",
    ),
  geometry: z
    .enum(["sphere", "box", "torus", "grid"])
    .default("torus")
    .describe("Primitive to render."),
  instances: z.coerce
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(1)
    .describe("GPU-instanced copies scattered over a grid (1 = single)."),
  ssao: z
    .boolean()
    .default(true)
    .describe("Add a Screen-Space Ambient Occlusion pass for contact shadows/depth."),
  expose_depth: z
    .boolean()
    .default(true)
    .describe(
      "Expose a Depth TOP output (feeds create_depth_displacement/silhouette synthetically).",
    ),
  spin: z.coerce.number().default(10).describe("Degrees/sec rotation."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Render resolution [width, height] in pixels."),
});
type Multipass3dDepthArgs = z.infer<typeof multipass3dDepthSchema>;

export async function multipass3dDepthImpl(ctx: ToolContext, args: Multipass3dDepthArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [resW, resH] = args.resolution;

    // Geometry COMP (the builder clears its default torus), with the chosen primitive SOP
    // inside it, flagged for render + display so the COMP renders it. Same shape as
    // create_3d_scene.
    const geo = await builder.add("geometryCOMP", "geo");
    const shape = await builder.add(PRIMITIVE_SOP[args.geometry] as string, "shape", {}, geo);
    await builder.python(`_s = op(${q(shape)})\n_s.render = True\n_s.display = True`);

    // Optional GPU instancing — scatter `instances` copies over a grid of points; the
    // Geometry COMP renders the shape once per point. Mirrors create_3d_scene's approach.
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
      await builder.setParams(geo, {
        instancing: 1,
        instanceop: points,
        instancetx: "P(0)",
        instancety: "P(1)",
        instancetz: "P(2)",
      });
    }

    const camDist = args.instances > 1 ? Math.max(cols, rows) * spacing + 6 : 5;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });

    // Beauty/color pass. Render TOP reads its scene from parameters (camera, geometry,
    // lights) — proven working in create_3d_scene — at the chosen resolution.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: resW,
      resolutionh: resH,
    });
    // Force a fixed output resolution (Use Input has no input on a Render TOP, so set the
    // resolution menu to "Custom Resolution" = 9). Best-effort: a build that names this
    // differently still cooks at the geometry-default resolution.
    await builder.python(
      `try:\n    op(${q(render)}).par.outputresolution = 9\nexcept Exception:\n    pass`,
    );

    // Per-instance / whole-scene spin around Y over time. On a single object this rotates the
    // geometry; with instances it spins every copy. (instancery auto-switches to EXPRESSION.)
    if (args.spin !== 0) {
      if (args.instances > 1) {
        await builder.python(
          `op(${q(geo)}).par.instancery.expr = ${q(`absTime.seconds * ${args.spin}`)}`,
        );
      } else {
        await builder.python(`op(${q(geo)}).par.ry.expr = ${q(`absTime.seconds * ${args.spin}`)}`);
      }
    }

    const extra: Record<string, unknown> = {
      geometry: geo,
      camera: cam,
      light,
      render,
      instances: args.instances,
      spin: args.spin,
      resolution: [resW, resH],
    };

    // SSAO pass. The SSAO TOP performs ambient occlusion on the output of a Render TOP and
    // requires the depth buffer, so it must sit *directly* after the Render TOP with NO TOP
    // in between (KB: SSAO TOP). We wire render → ssao and combine with the color so the
    // beauty pass carries contact shadows. The op type string + the "combine with color"
    // par name are UNVERIFIED against a live build (the KB stores labels, not createable
    // op-types/internal par names), so the wiring is best-effort: a failure is collected as
    // a warning and the scene still cooks from the plain Render TOP.
    let beauty = render;
    if (args.ssao) {
      const ssao = await builder.add("ssaoTOP", "ssao");
      // No TOP may sit between the render and the SSAO — wire render straight in.
      await builder.connect(render, ssao);
      await builder.python(
        `try:\n    op(${q(ssao)}).par.combinewithcolor = 1\nexcept Exception:\n    pass`,
      );
      beauty = ssao;
      extra.ssao = ssao;
    }

    // End the beauty pass on a Null TOP (the stable output handle).
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(beauty, out);
    extra.output_path = out;

    // Optional Depth TOP output: resolves the named Render TOP into a depth map and exposes
    // it as a second Null (`depth_out`) so create_depth_displacement / create_depth_silhouette
    // can consume it with source='existing_top' / existing_top_path — a synthetic depth feed,
    // no depth camera needed. The Depth TOP references its source via a "Render TOP" parameter
    // (KB label); the internal par name `rendertop` is UNVERIFIED, so we set it best-effort.
    if (args.expose_depth) {
      const depth = await builder.add("depthTOP", "depth");
      await builder.python(
        `try:\n    op(${q(depth)}).par.rendertop = ${q(render)}\nexcept Exception:\n    pass`,
      );
      const depthOut = await builder.add("nullTOP", "depth_out");
      await builder.connect(depth, depthOut);
      extra.depth = depth;
      extra.depth_out = depthOut;
    }

    const controls: ControlSpec[] = [
      { name: "Spin", type: "float", min: -180, max: 180, default: args.spin, bind_to: [] },
      {
        name: "Zoom",
        type: "float",
        min: 1,
        max: camDist * 3,
        default: camDist,
        bind_to: [`${cam}.tz`],
      },
    ];
    if (args.ssao && extra.ssao) {
      controls.push({
        name: "Ssao",
        type: "toggle",
        default: 1,
        bind_to: [`${extra.ssao}.combinewithcolor`],
      });
    }

    const ssaoNote = args.ssao ? " + SSAO" : "";
    const depthNote = args.expose_depth ? `, depth at ${extra.depth_out}` : "";
    const instanceNote = args.instances > 1 ? ` ×${args.instances}` : "";
    return finalize(ctx, {
      summary: `Built a multipass 3D scene (${args.geometry}${instanceNote}${ssaoNote}) rendered to ${out}${depthNote}. ${
        args.expose_depth
          ? `Feed ${extra.depth_out} into create_depth_displacement / create_depth_silhouette (source='existing_top') for a synthetic depth-driven effect.`
          : ""
      }`,
      builder,
      outputPath: out,
      controls,
      extra,
    });
  });
}

export const registerMultipass3dDepth: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "multipass_3d_depth",
    {
      title: "Multipass 3D scene (SSAO + depth)",
      description:
        "Build a renderable 3D scene with depth cues that read on stage: a Geometry COMP holding the chosen primitive (sphere/box/torus/grid), a Camera, a Light, and a Render TOP beauty pass, output as a Null — like create_3d_scene but with an optional Screen-Space Ambient Occlusion (SSAO) pass for contact shadows, and an optional Depth TOP output. The SSAO TOP is wired directly after the Render TOP (it needs the depth buffer — no TOP between them) and combined with the color. When expose_depth is on, a Depth TOP resolves the same render into a depth map exposed as a second Null ('depth_out'); feed that path into create_depth_displacement or create_depth_silhouette with source='existing_top' for a synthetic depth-driven effect — no depth camera needed. Optionally GPU-instanced into a grid, with spin over time. Exposes Spin, Zoom, and (with SSAO) an Ssao toggle. Returns a summary plus a JSON block with the container path, created node paths, the render/output/depth paths, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: multipass3dDepthSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => multipass3dDepthImpl(ctx, args),
  );
};
