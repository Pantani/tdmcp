import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/** Default Monument-Valley pastel 5-stop palette (R,G,B tuples). */
const DEFAULT_PALETTE: Array<[number, number, number]> = [
  [0.96, 0.87, 0.7],
  [0.72, 0.85, 0.88],
  [0.93, 0.71, 0.64],
  [0.78, 0.88, 0.78],
  [0.88, 0.78, 0.9],
];

export const createVoxelStackSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the voxel stack container is created."),
  name: z.string().optional().describe("Base name for the container (defaults to 'voxel_stack')."),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "Path to an existing TOP that drives heights and colors. " +
        "If omitted, a built-in animated noiseTOP feeds the stack.",
    ),
  grid_size: z
    .tuple([z.coerce.number().int().min(1).max(256), z.coerce.number().int().min(1).max(256)])
    .default([32, 32])
    .describe("Voxel grid cols × rows. Hard-capped at 256×256 (65k instances)."),
  voxel_size: z.coerce
    .number()
    .min(0.01)
    .max(2)
    .default(0.5)
    .describe("Cube edge length in world units; also the XZ spacing between voxels."),
  height_scale: z.coerce
    .number()
    .min(0)
    .max(50)
    .default(8)
    .describe("Multiplier on luminance → Y translate. 0 = flat slab."),
  color_mode: z
    .enum(["source_color", "palette", "height_ramp"])
    .default("source_color")
    .describe(
      "Per-instance color: sample source TOP directly (source_color), " +
        "look up into a palette ramp (palette), or use a default pastel height ramp (height_ramp).",
    ),
  palette: z
    .array(z.tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()]))
    .min(2)
    .max(8)
    .optional()
    .describe(
      "Ramp endpoints as [r,g,b] tuples (2–8 stops). Used only when color_mode='palette'. " +
        "Defaults to a Monument-Valley pastel 5-stop ramp.",
    ),
  output_resolution: z
    .tuple([z.coerce.number().int().min(64).max(4096), z.coerce.number().int().min(64).max(4096)])
    .default([1280, 720])
    .describe("Render TOP resolution [width, height]."),
  camera_mode: z
    .enum(["isometric", "perspective"])
    .default("isometric")
    .describe(
      "Isometric uses ortho camera at rx=-35.264°, ry=45° (classic iso). " +
        "Perspective uses a standard 35mm orbit cam.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true, expose HeightScale, RotateY, and VoxelSize knobs on the container."),
});

export type CreateVoxelStackArgs = z.infer<typeof createVoxelStackSchema>;

export async function createVoxelStackImpl(ctx: ToolContext, args: CreateVoxelStackArgs) {
  return runBuild(async () => {
    const [cols, rows] = args.grid_size;
    const voxelCount = cols * rows;
    const isIso = args.camera_mode === "isometric";
    const usePalette = args.color_mode === "palette" || args.color_mode === "height_ramp";
    const palette = args.palette ?? DEFAULT_PALETTE;

    // Warn in summary when grid is large
    const largeGridWarning =
      voxelCount > 128 * 128 ? " [soft-cap: cook time may exceed 50ms at 256×256]" : "";

    const builder = await createSystemContainer(ctx, args.parent_path, args.name ?? "voxel_stack");

    // 1) Source TOP — either a Select wrapping the external path or a noiseTOP fallback.
    const srcTop = args.source_top_path
      ? await builder.add("selectTOP", "src_top", { top: args.source_top_path })
      : await builder.add("noiseTOP", "src_top", {
          period: 2,
          monochrome: 0,
          // Animated: let TD cook each frame
        });

    // 2) CHOP chain — produces N=cols*rows instance channels.
    // patternCHOP: index ramp over all N cells.
    const patternChop = await builder.add("patternCHOP", "pattern1", {
      length: voxelCount,
      type: 0, // ramp
    });

    // mathCHOP: tx = (i % cols - cols/2) * voxel_size
    const txChop = await builder.add("mathCHOP", "tx", {
      chopop: "modulo",
      value: cols,
    });
    await builder.connect(patternChop, txChop);

    // mathCHOP: tz = (i / cols - rows/2) * voxel_size (floor division via divide)
    const tzChop = await builder.add("mathCHOP", "tz", {
      chopop: "divide",
      value: cols,
    });
    await builder.connect(patternChop, tzChop);

    // topToCHOP for luminance: sample src_top resampled to cols×rows.
    const lumTop = await builder.add("toptoCHOP", "lum_top", {
      top: srcTop,
      width: cols,
      height: rows,
      monochrome: 1,
    });

    // mathCHOP: ty = luminance * height_scale * 0.5 (center on slab base)
    const tyChop = await builder.add("mathCHOP", "ty", {
      gain: args.height_scale * 0.5,
    });
    await builder.connect(lumTop, tyChop);

    // mathCHOP: sy = max(lum * height_scale, voxel_size)
    const syChop = await builder.add("mathCHOP", "sy", {
      gain: args.height_scale,
      floor: args.voxel_size,
      dofloor: 1,
    });
    await builder.connect(lumTop, syChop);

    // Optional palette rampTOP when color mode needs it.
    let colorTop: string;
    if (usePalette) {
      // Build ramp keys as Python list string
      const keys = palette
        .map(
          ([r, g, b], i) => `{"r":${r},"g":${g},"b":${b},"a":1,"pos":${i / (palette.length - 1)}}`,
        )
        .join(",");
      const rampTop = await builder.add("rampTOP", "palette_ramp", {
        ramptype: 0, // horizontal
        width: 256,
        height: 1,
      });
      // Set ramp keys via python
      await builder.python(
        `_r = op(${q(rampTop)})\n` +
          `_r.par.ramptype = 0\n` +
          `_keys = [${keys}]\n` +
          `while len(_r.ramp) < len(_keys):\n` +
          `    _r.ramp.add(0)\n` +
          `for _i, _k in enumerate(_keys):\n` +
          `    _r.ramp[_i].pos = _k["pos"]\n` +
          `    _r.ramp[_i].r = _k["r"]\n` +
          `    _r.ramp[_i].g = _k["g"]\n` +
          `    _r.ramp[_i].b = _k["b"]`,
      );
      // topToCHOP sampling the ramp by luminance (U = lum value)
      colorTop = await builder.add("toptoCHOP", "color_top", {
        top: rampTop,
        width: cols,
        height: rows,
        monochrome: 0,
      });
    } else {
      // source_color: sample src_top RGB directly
      colorTop = await builder.add("toptoCHOP", "color_top", {
        top: srcTop,
        width: cols,
        height: rows,
        monochrome: 0,
      });
    }

    // nullCHOP — combine tx, ty, tz, sy, r, g, b as instancing source.
    const instNull = await builder.add("nullCHOP", "inst_null");
    await builder.connect(txChop, instNull);
    await builder.connect(tzChop, instNull);
    await builder.connect(tyChop, instNull);
    await builder.connect(syChop, instNull);
    await builder.connect(colorTop, instNull);

    // 3) Geometry COMP with boxSOP + constantMAT inside.
    const geo = await builder.add("geometryCOMP", "voxel_geo");

    // boxSOP inside geo — TD param name is sizex/sizey/sizez.
    const boxSop = await builder.add(
      "boxSOP",
      "voxel",
      { sizex: args.voxel_size, sizey: args.voxel_size, sizez: args.voxel_size },
      geo,
    );

    // constantMAT: per-instance color will be applied via instancing
    const mat = await builder.add("constantMAT", "mat", { colorr: 1, colorg: 1, colorb: 1 }, geo);

    // 4) Camera — iso ortho or perspective orbit.
    const camParams = isIso
      ? {
          rx: -35.264,
          ry: 45,
          tz: (cols * args.voxel_size + rows * args.voxel_size) * 2,
          projection: 1, // orthographic
          orthowidth: cols * args.voxel_size * 1.5,
        }
      : { rx: -20, ry: 45, tz: (cols * args.voxel_size + rows * args.voxel_size) * 1.5 };
    const cam = await builder.add("cameraCOMP", "cam", camParams);

    // 5) Light.
    const light = await builder.add("lightCOMP", "light", {
      tx: cols * args.voxel_size * 0.5,
      ty: args.height_scale * 2,
      tz: rows * args.voxel_size * 0.5,
    });

    // 6) Render TOP.
    const [resW, resH] = args.output_resolution;
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      resolutionw: resW,
      resolutionh: resH,
    });

    // 7) Output null.
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // 8) Instancing python block — sets all instancing parameters in one shot.
    await builder.python(
      `_g = op(${q(geo)})\n` +
        `_g.par.instancing = True\n` +
        `_g.par.instanceop = op(${q(instNull)}).name\n` +
        `_g.par.instancetx = "tx"\n` +
        `_g.par.instancety = "ty"\n` +
        `_g.par.instancetz = "tz"\n` +
        `_g.par.instancesx = "sy"\n` +
        `_g.par.instancesy = "sy"\n` +
        `_g.par.instancesz = "sy"\n` +
        `_g.par.instancer = "r"\n` +
        `_g.par.instanceg = "g"\n` +
        `_g.par.instanceb = "b"\n` +
        `_g.par.numinstances = ${voxelCount}\n` +
        `# Enable per-instance color on the material\n` +
        `_m = op(${q(mat)})\n` +
        `_m.par.colorr.mode = ParMode.CONSTANT\n` +
        `_m.par.colorg.mode = ParMode.CONSTANT\n` +
        `_m.par.colorb.mode = ParMode.CONSTANT\n` +
        `# Mark boxSOP as render+display\n` +
        `_b = op(${q(boxSop)})\n` +
        `_b.render = True\n` +
        `_b.display = True`,
    );

    // 9) Exposed controls.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "HeightScale",
            type: "float",
            min: 0,
            max: 50,
            default: args.height_scale,
            bind_to: [`${builder.pathOf("ty") ?? ""}.gain`, `${builder.pathOf("sy") ?? ""}.gain`],
          },
          {
            name: "VoxelSize",
            type: "float",
            min: 0.01,
            max: 2,
            default: args.voxel_size,
            bind_to: [`${geo}/voxel.sizex`],
          },
          {
            name: "RotateY",
            type: "float",
            min: 0,
            max: 360,
            default: 0,
            bind_to: [isIso ? `${geo}.ry` : `${cam}.ry`],
          },
        ]
      : [];

    const srcLabel = args.source_top_path ? args.source_top_path : "internal noiseTOP";
    const summary =
      `Built voxel stack ${cols}×${rows} (${voxelCount} instances) ` +
      `sourced from ${srcLabel} rendered to ${out}.` +
      (voxelCount > 128 * 128 ? largeGridWarning : "");

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        geometry_path: geo,
        instance_chop_path: instNull,
        render_path: render,
        output_path: out,
        grid_size: args.grid_size,
        voxel_count: voxelCount,
        color_mode: args.color_mode,
        controls_exposed: args.expose_controls ? ["HeightScale", "RotateY", "VoxelSize"] : [],
      },
    });
  });
}

export const registerCreateVoxelStack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_voxel_stack",
    {
      title: "Create voxel stack",
      description:
        "Isometric voxel-stack renderer driven by any TOP. Builds a single instanced Geometry COMP " +
        "(boxSOP, N=cols·rows instances up to 256×256) with a CHOP chain sampling luminance for column " +
        "height and per-instance color. Color modes: source_color (sample TOP directly), palette " +
        "(Monument-Valley pastel ramp), height_ramp (same palette, height-based). Isometric ortho cam " +
        "(rx=-35.264°, ry=45°) by default; perspective available. Exposes HeightScale, VoxelSize, and " +
        "RotateY controls. If source_top_path is omitted, an animated noiseTOP drives the stack.",
      inputSchema: createVoxelStackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVoxelStackImpl(ctx, args),
  );
};
