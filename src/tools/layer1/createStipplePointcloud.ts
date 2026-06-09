import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const rgb = (def: readonly [number, number, number]) =>
  z
    .tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()])
    .default([def[0], def[1], def[2]]);

export const createStipplePointcloudSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to create the container under."),
  name: z
    .string()
    .default("stipple_pointcloud")
    .describe("Base name for the system container (TD auto-suffixes)."),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing TOP whose luminance drives density. " +
        "When omitted, a rampTOP radial gradient is built as the source.",
    ),
  dot_size: z.coerce
    .number()
    .min(0.5)
    .max(8)
    .default(2)
    .describe("Point primitive size in pixels (0.5..8, default 2)."),
  density: z.coerce
    .number()
    .int()
    .min(100)
    .max(200000)
    .default(20000)
    .describe(
      "Total particle count (100..200000, default 20000). Drives maxparticles + birthrate.",
    ),
  mode: z
    .enum(["bw_dots", "colored_dots", "random_jitter"])
    .default("bw_dots")
    .describe(
      "Visual treatment: bw_dots (constant colour), colored_dots (sample source RGB per-point), " +
        "random_jitter (adds noisePOP for organic scatter).",
    ),
  color_mode: z
    .enum(["white_on_black", "black_on_white", "palette"])
    .default("white_on_black")
    .describe(
      "Background/foreground choice for bw_dots and random_jitter. Ignored by colored_dots.",
    ),
  palette_color: rgb([0.95, 0.9, 0.7]).describe(
    "Foreground RGB tuple when color_mode=palette. Default warm parchment [0.95, 0.9, 0.7].",
  ),
  jitter_amount: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.25)
    .describe("Per-point position noise scale for random_jitter mode (0..1, default 0.25)."),
  resolution: z
    .tuple([z.coerce.number().int(), z.coerce.number().int()])
    .default([1280, 720])
    .describe("Output Render TOP resolution [w, h]. Default [1280, 720]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true, expose live DotSize, Density (read-only), JitterAmount (random_jitter only), CameraRotate.",
    ),
});

export type CreateStipplePointcloudArgs = z.infer<typeof createStipplePointcloudSchema>;

function resolveColors(args: CreateStipplePointcloudArgs): {
  fgR: number;
  fgG: number;
  fgB: number;
  bgR: number;
  bgG: number;
  bgB: number;
} {
  const [pr, pg, pb] = args.palette_color;
  if (args.color_mode === "white_on_black") {
    return { fgR: 1, fgG: 1, fgB: 1, bgR: 0, bgG: 0, bgB: 0 };
  }
  if (args.color_mode === "black_on_white") {
    return { fgR: 0, fgG: 0, fgB: 0, bgR: 1, bgG: 1, bgB: 1 };
  }
  // palette
  return { fgR: pr, fgG: pg, fgB: pb, bgR: 0, bgG: 0, bgB: 0 };
}

export async function createStipplePointcloudImpl(
  ctx: ToolContext,
  args: CreateStipplePointcloudArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // 1) Source TOP — selectTOP referencing external path, or self-contained rampTOP.
    const src = args.source_top_path
      ? await builder.add("selectTOP", "source", { top: args.source_top_path })
      : await builder.add("rampTOP", "source", {
          type: "radial",
          resolutionw: 512,
          resolutionh: 512,
        });

    // 2) Particle emitter — maxparticles + birthrate both equal density, life=9999 (static cloud).
    const emitter = await builder.add("particlePOP", "emit", {
      maxparticles: args.density,
      birthrate: args.density,
      life: 9999,
      emissionmode: "continuous",
    });

    // 3) Density lookup — par.top is set via extra_inputs[0] (FM-03 lookup-family contract).
    //    The source TOP path must exist in TD; for the offline rampTOP case we pass the node path
    //    by building the container path ourselves: <container>/<srcName>.
    //    buildPopChainImpl is NOT used here — we drive the chain through NetworkBuilder directly
    //    so that the same per-kind param overlay pattern applies.
    const densityLut = await builder.add("lookuptexturePOP", "density_lut", {
      attrclass: "point",
    });
    await builder.connect(emitter, densityLut);
    // Set par.top via python (lookup-family contract: not a wire).
    await builder.python(`op(${q(densityLut)}).par.top = ${q(src)}`);

    // 4) Optional jitter (random_jitter mode).
    let tail = densityLut;
    let jitterPath: string | undefined;
    if (args.mode === "random_jitter") {
      const jit = await builder.add("noisePOP", "jitter", {
        amp: args.jitter_amount,
        period: 1.0,
      });
      await builder.connect(tail, jit);
      tail = jit;
      jitterPath = jit;
    }

    // 5) Optional colour lookup (colored_dots mode) — second lookupTexturePOP for Cd attribute.
    let colorLutPath: string | undefined;
    if (args.mode === "colored_dots") {
      const colorLut = await builder.add("lookuptexturePOP", "color_lut", {
        attrclass: "point",
        outputattr: "Cd",
      });
      await builder.connect(tail, colorLut);
      await builder.python(`op(${q(colorLut)}).par.top = ${q(src)}`);
      tail = colorLut;
      colorLutPath = colorLut;
    }

    // 6) Null POP — stable output handle for the POP chain.
    const outPop = await builder.add("nullPOP", "out_pop");
    await builder.connect(tail, outPop);

    // 7) Geometry COMP in point-cloud render mode.
    const geo = await builder.add("geometryCOMP", "geo");
    await builder.python(
      `op(${q(geo)}).par.pointcloudpop = ${q(outPop)}\n` +
        `op(${q(geo)}).par.rendertype = "points"\n` +
        `op(${q(geo)}).par.pointsize = ${args.dot_size}`,
    );

    // 8) constantMAT — colour from resolved fg/bg colours (colored_dots ignores fg but keeps MAT).
    const { fgR, fgG, fgB } = resolveColors(args);
    const mat = await builder.add("constantMAT", "mat", {
      colorr: fgR,
      colorg: fgG,
      colorb: fgB,
    });

    // Assign material to the geometry COMP.
    await builder.python(`op(${q(geo)}).par.material = ${q(mat)}`);

    // 9) Camera, light, renderTOP.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 5 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });

    const { bgR, bgG, bgB } = resolveColors(args);
    const [resW, resH] = args.resolution;
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: resW,
      resolutionh: resH,
      bgcolorr: bgR,
      bgcolorg: bgG,
      bgcolorb: bgB,
    });

    // 10) Null TOP — preview + output handle.
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // 11) Control panel.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "DotSize",
            type: "float" as const,
            min: 0.5,
            max: 8,
            default: args.dot_size,
            bind_to: [`${geo}.pointsize`],
          },
          // JitterAmount only when jitter node exists.
          ...(args.mode === "random_jitter" && jitterPath !== undefined
            ? [
                {
                  name: "JitterAmount",
                  type: "float" as const,
                  min: 0,
                  max: 1,
                  default: args.jitter_amount,
                  bind_to: [`${jitterPath}.amp`],
                },
              ]
            : []),
          {
            name: "CameraRotate",
            type: "float" as const,
            min: 0,
            max: 360,
            default: 0,
            bind_to: [`${cam}.ry`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary:
        `Built stipple pointcloud (mode=${args.mode}, density=${args.density}` +
        (args.source_top_path ? `, source=${args.source_top_path}` : ", source=ramp") +
        `) → ${out}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        mode: args.mode,
        color_mode: args.color_mode,
        density: args.density,
        dot_size: args.dot_size,
        source_top: args.source_top_path ?? `${src} (ramp)`,
        emitter_path: emitter,
        density_lut_path: densityLut,
        color_lut_path: colorLutPath,
        jitter_path: jitterPath,
        out_pop_path: outPop,
        geometry_path: geo,
        render_path: render,
        output_path: out,
        pop_render_verified: false,
      },
    });
  });
}

export const registerCreateStipplePointcloud: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_stipple_pointcloud",
    {
      title: "Create stipple point cloud",
      description:
        "Density-weighted particle scatter rendered as discrete points — a stippled / halftone-engraving " +
        "point cloud whose dot distribution follows the luminance of a source TOP. Brighter regions " +
        "yield denser clusters. Three visual modes: bw_dots (constant colour stipple), colored_dots " +
        "(sample source RGB at each point), random_jitter (adds noisePOP for organic hand-engraved " +
        "scatter). Outputs a Render TOP through a Geometry COMP in points render mode. " +
        "Sibling to create_pop_geometry (procedural SOP geo) and the rasterised create_dither / " +
        "create_halftone tools (which stay in TOP space).",
      inputSchema: createStipplePointcloudSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createStipplePointcloudImpl(ctx, args),
  );
};
