import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const createFacadeMappingBaseSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the facade mapping system is created."),
  name: z.string().default("facade_mapping").describe("Name of the generated Base COMP."),
  source_top_path: z
    .string()
    .optional()
    .describe("Absolute TOP path to fan out; required when source_mode='existing_top'."),
  source_mode: z
    .enum(["existing_top", "synthetic"])
    .default("synthetic")
    .describe(
      "Synthetic builds a self-animated noiseTOP so the rig previews without an upstream feed.",
    ),
  projector_count: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2)
    .describe("Number of projectors. Each projector gets its own branch and Null output."),
  blend_width: z
    .number()
    .int()
    .min(0)
    .max(2048)
    .default(192)
    .describe("Edge-blend overlap region in pixels (alpha gradient width on inner edges)."),
  blend_layout: z
    .enum(["horizontal", "vertical", "grid"])
    .default("horizontal")
    .describe("How projectors tile: horizontal row, vertical column, or near-square grid."),
  output_width: z
    .number()
    .int()
    .min(64)
    .max(8192)
    .default(1920)
    .describe("Per-projector pixel width."),
  output_height: z
    .number()
    .int()
    .min(64)
    .max(8192)
    .default(1080)
    .describe("Per-projector pixel height."),
  facade_geometry_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute SOP/COMP path to a 3D facade model. PARTIAL/UNVERIFIED: when provided, " +
        "builds a per-projector cameraCOMP + renderTOP + geometryCOMP stub.",
    ),
  blend_curve: z
    .enum(["linear", "gamma22", "smoothstep"])
    .default("smoothstep")
    .describe("Curve applied to the alpha gradient via Level gamma."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Build a Control Panel with per-projector brightness + global blend width/curve."),
  background_color: z
    .string()
    .regex(HEX_COLOR)
    .default("#000000")
    .describe("Background color as #rrggbb."),
});

export const createFacadeMappingSchema = createFacadeMappingBaseSchema.superRefine((args, ctx) => {
  if (args.source_mode === "existing_top" && !args.source_top_path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_top_path"],
      message: "source_top_path is required when source_mode='existing_top'.",
    });
  }
});

type CreateFacadeMappingArgs = z.infer<typeof createFacadeMappingSchema>;

const q = (value: string): string => JSON.stringify(value);

function blendGamma(curve: string): number {
  if (curve === "gamma22") return 2.2;
  if (curve === "smoothstep") return 1.8; // approximate smoothstep via gamma
  return 1.0; // linear
}

function previewGridSize(args: CreateFacadeMappingArgs): { width: number; height: number } {
  if (args.blend_layout === "vertical") {
    return {
      width: args.output_width,
      height: args.output_height * args.projector_count,
    };
  }
  if (args.blend_layout === "grid") {
    const cols = Math.ceil(Math.sqrt(args.projector_count));
    const rows = Math.ceil(args.projector_count / cols);
    return {
      width: args.output_width * cols,
      height: args.output_height * rows,
    };
  }
  return {
    width: args.output_width * args.projector_count,
    height: args.output_height,
  };
}

async function buildSource(
  builder: NetworkBuilder,
  args: CreateFacadeMappingArgs,
): Promise<string> {
  if (args.source_mode === "existing_top") {
    const path = args.source_top_path;
    if (!path) throw new Error("source_top_path is required when source_mode='existing_top'.");
    return await builder.add("selectTOP", "source_in", {
      top: path,
      resolutionw: args.output_width,
      resolutionh: args.output_height,
    });
  }
  const source = await builder.add("noiseTOP", "source_in", {
    resolutionw: args.output_width,
    resolutionh: args.output_height,
  });
  await builder.python(
    `op(${q(source)}).par.tz.expr = "absTime.seconds * 0.5"\n` +
      `op(${q(source)}).par.tx.expr = "absTime.seconds * 0.2"`,
  );
  return source;
}

interface ProjectorBranch {
  index: number;
  out: string;
  warp: string;
  blendRamp: string;
}

async function buildProjectorBranch(
  builder: NetworkBuilder,
  i: number,
  n: number,
  fanoutPath: string,
  args: CreateFacadeMappingArgs,
): Promise<ProjectorBranch> {
  const { output_width: W, output_height: H, blend_width, blend_layout } = args;
  const outputParams = { resolutionw: W, resolutionh: H };

  // Compute crop region: each projector gets a slice of the source with overlap.
  // Overlap ensures the blend ramp has source pixels to fade across.
  const overlapFrac = blend_width / Math.max(1, W);
  let cropParams: Record<string, number>;
  if (blend_layout === "horizontal") {
    const sliceW = 1 / n;
    const cropX1 = Math.max(0, i * sliceW - overlapFrac / 2);
    const cropX2 = Math.min(1, (i + 1) * sliceW + overlapFrac / 2);
    cropParams = { top: 0, right: 1 - cropX2, bottom: 0, left: cropX1 };
  } else if (blend_layout === "vertical") {
    const sliceH = 1 / n;
    const cropY1 = Math.max(0, i * sliceH - overlapFrac / 2);
    const cropY2 = Math.min(1, (i + 1) * sliceH + overlapFrac / 2);
    cropParams = { top: cropY1, right: 0, bottom: 1 - cropY2, left: 0 };
  } else {
    // grid
    const cols = Math.ceil(Math.sqrt(n));
    const col = i % cols;
    const row = Math.floor(i / cols);
    const totalRows = Math.ceil(n / cols);
    const sliceW = 1 / cols;
    const sliceH = 1 / totalRows;
    const cropX1 = Math.max(0, col * sliceW - overlapFrac / 2);
    const cropX2 = Math.min(1, (col + 1) * sliceW + overlapFrac / 2);
    const cropY1 = Math.max(0, row * sliceH - overlapFrac / 2);
    const cropY2 = Math.min(1, (row + 1) * sliceH + overlapFrac / 2);
    cropParams = { top: cropY1, right: 1 - cropX2, bottom: 1 - cropY2, left: cropX1 };
  }

  const cropPath = await builder.add("cropTOP", `proj${i}_crop`, {
    ...outputParams,
    ...cropParams,
  });
  await builder.connect(fanoutPath, cropPath);

  let warpInput = cropPath;

  // Optional 3D geometry branch (UNVERIFIED — probe live for param names).
  if (args.facade_geometry_path) {
    builder.warnings.push(
      `proj${i}: 3D geometry branch (renderTOP/cameraCOMP/geometryCOMP) is UNVERIFIED; ` +
        "camera transform and SOP binding param names (geometry/sop) must be confirmed live.",
    );
    const geoCOMP = await builder.add("geometryCOMP", `proj${i}_geo`, outputParams);
    await builder.python(
      `_g = op(${q(geoCOMP)})\n` +
        `for _attr in ['sop', 'geometry', 'soppath']:\n` +
        `    try:\n` +
        `        setattr(_g.par, _attr, ${q(args.facade_geometry_path)})\n` +
        `        break\n` +
        `    except Exception:\n` +
        `        pass`,
    );

    const camCOMP = await builder.add("cameraCOMP", `proj${i}_cam`, outputParams);
    const renderTOP = await builder.add("renderTOP", `proj${i}_render`, {
      ...outputParams,
      camera: camCOMP,
    });
    await builder.python(
      `_r = op(${q(renderTOP)})\n` +
        `try:\n` +
        `    _r.par.camera = op(${q(camCOMP)}).name\n` +
        `except Exception:\n` +
        `    pass`,
    );
    warpInput = renderTOP;
  }

  const warpPath = await builder.add("cornerpinTOP", `proj${i}_warp`, outputParams);
  await builder.connect(warpInput, warpPath);

  // Blend ramp — gradient on inner edge(s).
  // Ramp direction follows blend_layout; end projectors get one-sided ramps.
  const isFirst = i === 0;
  const isLast = i === n - 1;
  const rampPath = await builder.add("rampTOP", `proj${i}_blend_ramp`, outputParams);
  // horizontal layout: ramp fades left-to-right; clamp to blend region.
  // We use a vertical ramp (type=1) for vertical layout, horizontal (type=0) for others.
  let rampType = 0; // horizontal gradient by default
  if (blend_layout === "vertical") rampType = 1;
  await builder.python(
    `_r = op(${q(rampPath)})\n` +
      `try:\n` +
      `    _r.par.type = ${rampType}\n` +
      `except Exception:\n` +
      `    pass\n` +
      `# Adjust ramp phase so inner edges fade; outer edges stay full.\n` +
      `_is_first = ${isFirst ? "True" : "False"}\n` +
      `_is_last = ${isLast ? "True" : "False"}\n` +
      `try:\n` +
      `    _r.par.phase = 0.0\n` +
      `except Exception:\n` +
      `    pass`,
  );

  // Blend mask: warp multiplied by ramp alpha.
  const blendMaskPath = await builder.add("compositeTOP", `proj${i}_blend_mask`, {
    ...outputParams,
    operand: "multiply",
  });
  await builder.connect(warpPath, blendMaskPath, 0, 0);
  await builder.connect(rampPath, blendMaskPath, 0, 1);

  // Level: per-projector brightness + blend curve gamma.
  const levelPath = await builder.add("levelTOP", `proj${i}_level`, {
    ...outputParams,
    brightness1: 1.0,
    gamma1: blendGamma(args.blend_curve),
  });
  await builder.connect(blendMaskPath, levelPath);

  const outNull = await builder.add("nullTOP", `out_proj${i}`, outputParams);
  await builder.connect(levelPath, outNull);

  return {
    index: i,
    out: outNull,
    warp: warpPath,
    blendRamp: rampPath,
  };
}

function buildControls(args: CreateFacadeMappingArgs, branches: ProjectorBranch[]): ControlSpec[] {
  if (!args.expose_controls) return [];

  const controls: ControlSpec[] = [
    {
      name: "BlendWidth",
      type: "float",
      min: 0,
      max: 1024,
      default: args.blend_width,
      bind_to: [],
    },
    {
      name: "BlendCurve",
      type: "menu",
      default: args.blend_curve,
      menu_items: ["linear", "gamma22", "smoothstep"],
      bind_to: [],
    },
  ];

  for (const branch of branches) {
    controls.push({
      name: `Proj${branch.index}Brightness`,
      type: "float",
      min: 0,
      max: 2,
      default: 1.0,
      bind_to: [`${branch.out.replace(/out_proj\d+$/, `proj${branch.index}_level`)}.brightness1`],
    });
  }

  return controls;
}

export async function createFacadeMappingImpl(ctx: ToolContext, args: CreateFacadeMappingArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const base = builder.containerPath;

    const sourcePath = await buildSource(builder, args);

    const fanoutPath = await builder.add("nullTOP", "source_fanout", {
      resolutionw: args.output_width,
      resolutionh: args.output_height,
    });
    await builder.connect(sourcePath, fanoutPath);

    const branches: ProjectorBranch[] = [];
    for (let i = 0; i < args.projector_count; i++) {
      const branch = await buildProjectorBranch(builder, i, args.projector_count, fanoutPath, args);
      branches.push(branch);
    }

    // Preview composite: tiles all out_proj Nulls according to blend_layout.
    const previewSize = previewGridSize(args);
    const previewGrid = await builder.add("compositeTOP", "facade_preview_grid", {
      resolutionw: previewSize.width,
      resolutionh: previewSize.height,
      operand: "add",
    });

    if (branches.length > 0) {
      const firstBranch = branches[0];
      if (firstBranch) {
        await builder.connect(firstBranch.out, previewGrid, 0, 0);
      }
      for (let i = 1; i < branches.length; i++) {
        const branch = branches[i];
        if (branch) {
          await builder.connect(branch.out, previewGrid, 0, i);
        }
      }
    }

    const outFacade = await builder.add("nullTOP", "out_facade", {
      resolutionw: previewSize.width,
      resolutionh: previewSize.height,
    });
    await builder.connect(previewGrid, outFacade);

    builder.warnings.push(
      "Calibration corners are at defaults; physical projection alignment must be adjusted on the real facade.",
    );
    builder.warnings.push(
      "Color match across projectors requires camera-based measurement; not built in this skeleton.",
    );
    if (args.projector_count > 4) {
      builder.warnings.push(
        `projector_count=${args.projector_count}: preview composite with >4 projectors is UNVERIFIED; validated only up to 2 live.`,
      );
    }

    const controls = buildControls(args, branches);

    const perProjector = branches.map((b) => ({
      index: b.index,
      out: b.out,
      warp: b.warp,
      blend_ramp: b.blendRamp,
    }));

    const controlNames = controls.map((c) => c.name);

    return finalize(ctx, {
      summary: `Built facade mapping skeleton (N=${args.projector_count}, ${args.blend_layout}, ${args.output_width}x${args.output_height}, blend_width=${args.blend_width}). Calibration deferred to live install.`,
      builder,
      outputPath: outFacade,
      controls,
      extra: {
        system_path: base,
        output_top_path: outFacade,
        per_projector: perProjector,
        calibration: {
          status: "uncalibrated",
          blend_layout: args.blend_layout,
          blend_width_px: args.blend_width,
          blend_curve: args.blend_curve,
          facade_geometry_path: args.facade_geometry_path ?? null,
        },
        control_names: controlNames,
        deferred: {
          corner_pin: "Per-projector corners are at defaults; align on the physical facade.",
          color_match:
            "Per-projector color/gamma match requires camera-based measurement, not built.",
          geometry:
            "3D facade projection is a stub when facade_geometry_path is set; camera transform is artist-tuned.",
        },
      },
    });
  });
}

export const registerCreateFacadeMapping: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_facade_mapping",
    {
      title: "Create Facade Mapping",
      description:
        "Build a multi-projector architectural facade rig: one source TOP fanned into N per-projector " +
        "branches, each with Crop → Corner Pin keystone → edge-blend Ramp/Composite mask → Level brightness, " +
        "plus per-projector Null outputs and a summary preview composite. Ships as a calibration skeleton; " +
        "per-projector corners, color match, and (when 3D) camera transforms are left to live install alignment.",
      inputSchema: createFacadeMappingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFacadeMappingImpl(ctx, args),
  );
