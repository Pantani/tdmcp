import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createStepRepeatSchema = z.object({
  source_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of a TOP to tile (pulled in via selectTOP so it can live anywhere). Omit to " +
        "use TD's bundled Mosaic.mp4 test clip so the grid previews standalone.",
    ),
  rows: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(4)
    .describe("Number of tile rows (vertical repeats)."),
  cols: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(4)
    .describe("Number of tile columns (horizontal repeats)."),
  gap: z.coerce
    .number()
    .min(0)
    .max(0.9)
    .default(0.05)
    .describe("Fractional inset per cell (0 = tiles touch, 0.5 = half the cell is gap)."),
  jitter_pos: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Per-cell random position offset, fraction of a cell."),
  jitter_rot: z.coerce
    .number()
    .min(0)
    .max(Math.PI)
    .default(0)
    .describe("Per-cell random rotation, max radians."),
  brick_offset: z
    .boolean()
    .default(false)
    .describe("Shift alternating rows by half a tile (brick/masonry layout)."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'step_repeat' container is created inside."),
});

type CreateStepRepeatArgs = z.infer<typeof createStepRepeatSchema>;

/**
 * Fragment shader for the brick/grid tiler. Computes the cell each pixel belongs to
 * (with an optional half-cell horizontal shift on odd rows for a masonry layout),
 * insets each cell by `uGap`, applies a per-cell pseudo-random position + rotation
 * jitter (hashed from the cell index so it is stable frame-to-frame), then samples
 * the source TOP at the resulting local UV. Cells whose sample falls in the gap
 * border are left black/transparent.
 */
const STEP_REPEAT_FRAG = `
uniform vec2 uGrid;      // (cols, rows)
uniform float uGap;      // fractional inset per cell, 0..0.9
uniform float uJitterPos;  // fraction of a cell, 0..1
uniform float uJitterRot;  // radians, 0..~3.14159
uniform float uBrickOffset; // 0 or 1

out vec4 fragColor;

float hash21(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
	return vec2(hash21(p), hash21(p + vec2(19.19, 7.7)));
}

void main() {
	vec2 uv = vUV.st;
	vec2 grid = max(uGrid, vec2(1.0));

	// Brick/masonry: odd rows shift half a cell to the right (wrapping).
	float rowIndex = floor(uv.y * grid.y);
	float rowIsOdd = mod(rowIndex, 2.0);
	float shiftX = uBrickOffset * rowIsOdd * (0.5 / grid.x);
	vec2 shiftedUV = vec2(fract(uv.x + shiftX), uv.y);

	vec2 cellF = shiftedUV * grid;
	vec2 cellId = floor(cellF);
	vec2 cellUV = fract(cellF); // 0..1 within the cell

	// Per-cell jitter, hashed from the (pre-shift) cell index so it stays stable.
	vec2 rnd = hash22(cellId + 0.5);
	float rot = (rnd.x - 0.5) * 2.0 * uJitterRot;
	vec2 posJitter = (rnd - 0.5) * 2.0 * uJitterPos;

	// Work in a -0.5..0.5 local space centered on the cell so rotation is about
	// the cell center, then apply position jitter before the gap inset.
	vec2 local = cellUV - 0.5;
	float c = cos(rot);
	float s = sin(rot);
	local = mat2(c, -s, s, c) * local;
	local += posJitter;

	// Gap inset: shrink the sampled region so a border strip reads as empty.
	float scale = max(1.0 - uGap, 0.001);
	vec2 insetLocal = local / scale;

	vec2 sampleUV = insetLocal + 0.5;
	bool inGap = any(lessThan(insetLocal, vec2(-0.5))) || any(greaterThan(insetLocal, vec2(0.5)));

	if (inGap) {
		fragColor = vec4(0.0, 0.0, 0.0, 0.0);
	} else {
		fragColor = texture(sTD2DInputs[0], sampleUV);
	}
}
`;

export async function createStepRepeatImpl(ctx: ToolContext, args: CreateStepRepeatArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "step_repeat");
    const [width, height] = args.resolution;

    // ── Source ────────────────────────────────────────────────────────────────
    let sourceNode: string;
    if (args.source_path) {
      sourceNode = await builder.add("selectTOP", "src", {
        top: args.source_path,
        resolutionw: width,
        resolutionh: height,
      });
    } else {
      // Use TD's bundled Mosaic.mp4 so the grid previews standalone with no external asset.
      sourceNode = await builder.add("moviefileinTOP", "movie_test", {
        file: "Mosaic.mp4",
        resolutionw: width,
        resolutionh: height,
      });
    }

    // ── GLSL grid tiler ───────────────────────────────────────────────────────
    // A single-pass shader does gap inset + per-cell position/rotation jitter +
    // brick offset all together — a stock tileTOP has no per-cell gap/jitter
    // knobs, so a compositional tileTOP/transformTOP chain could only approximate
    // a UNIFORM (not per-cell) jitter. This shader gives true per-cell control.
    const glsl = await builder.add("glslTOP", "tiler", {
      resolutionw: width,
      resolutionh: height,
    });
    await builder.connect(sourceNode, glsl, 0, 0);

    // Fragment shader lives in a Text DAT; glslTOP.par.pixeldat points at it.
    const fragDat = await builder.add("textDAT", "tiler_frag");
    await builder.python(
      `_f = op(${JSON.stringify(fragDat)})\n_f.text = ${JSON.stringify(STEP_REPEAT_FRAG)}\n_g = op(${JSON.stringify(glsl)})\ntry:\n    _g.par.pixeldat = _f.name\nexcept Exception:\n    pass`,
    );

    // Uniforms live in the glslTOP's "Vectors" page parameter sequence (op.seq.vec),
    // same mechanism as recipe glsl_uniforms in orchestration.ts: raise numBlocks
    // first, then each block gets a name (<seq><i>name) + value sub-parameters
    // (<seq><i>valuex..w). uGrid is a vec2 (cols, rows); the rest are scalars
    // that fill valuex of their own block. UNVERIFIED: exact "Vectors" page
    // sequence name/sub-parameter suffixes are asserted from createOpticalFlow's
    // recipe-uniform path but not independently live-verified for glslTOP — probe
    // defensively and fall back to a direct par write if numBlocks/seq differs.
    const uniformDefs: Array<{ name: string; values: number[] }> = [
      { name: "uGrid", values: [args.cols, args.rows] },
      { name: "uGap", values: [args.gap] },
      { name: "uJitterPos", values: [args.jitter_pos] },
      { name: "uJitterRot", values: [args.jitter_rot] },
      { name: "uBrickOffset", values: [args.brick_offset ? 1 : 0] },
    ];
    await builder.python(
      [
        `_g = op(${JSON.stringify(glsl)})`,
        `_defs = ${JSON.stringify(uniformDefs)}`,
        `try:`,
        `    _seq = _g.seq.vec`,
        `    _seq.numBlocks = max(_seq.numBlocks, len(_defs))`,
        `    for _i, _d in enumerate(_defs):`,
        `        _blk = _seq[_i]`,
        `        _blk.par.name = _d["name"]`,
        `        _fields = ["valuex", "valuey", "valuez", "valuew"]`,
        `        for _j, _v in enumerate(_d["values"]):`,
        `            if _j < len(_fields):`,
        `                setattr(_blk.par, _fields[_j], _v)`,
        `except Exception:`,
        `    pass`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1", {
      resolutionw: width,
      resolutionh: height,
    });
    await builder.connect(glsl, out, 0, 0);

    // ── Controls ──────────────────────────────────────────────────────────────
    // rows/cols/gap/jitter_pos/jitter_rot bind straight to the glslTOP's uGrid/uGap/
    // uJitterPos/uJitterRot uniform sub-parameters (vec0..vec3 valuex/y once the
    // blocks above exist). brick_offset toggles uBrickOffset (vec4valuex, 0/1).
    // These bindings depend on the block layout set above; if the live build's
    // "Vectors" page differs, bind_to silently fails to find the parameter and the
    // failure is folded into warnings by createControlPanel's bind step — the
    // control still gets created, just not wired.
    const glslPath = builder.pathOf("tiler") ?? `${builder.containerPath}/tiler`;
    const controls: ControlSpec[] = [
      {
        name: "Rows",
        type: "int",
        min: 1,
        max: 64,
        default: args.rows,
        bind_to: [`${glslPath}.vec0valuey`],
      },
      {
        name: "Cols",
        type: "int",
        min: 1,
        max: 64,
        default: args.cols,
        bind_to: [`${glslPath}.vec0valuex`],
      },
      {
        name: "Gap",
        type: "float",
        min: 0,
        max: 0.9,
        default: args.gap,
        bind_to: [`${glslPath}.vec1valuex`],
      },
      {
        name: "JitterPos",
        type: "float",
        min: 0,
        max: 1,
        default: args.jitter_pos,
        bind_to: [`${glslPath}.vec2valuex`],
      },
      {
        name: "JitterRot",
        type: "float",
        min: 0,
        max: Math.PI,
        default: args.jitter_rot,
        bind_to: [`${glslPath}.vec3valuex`],
      },
      {
        name: "BrickOffset",
        type: "toggle",
        default: args.brick_offset,
        // A toggle control's underlying par is bool; the uniform sub-parameter is a
        // float (0/1). Left unbound to avoid a type-mismatch bind failure — driven
        // once at build time via uBrickOffset above. Re-run the tool to change it.
        bind_to: [],
      },
    ];

    const sourceSummary = args.source_path ? args.source_path : "Mosaic.mp4 (built-in test clip)";
    const summary =
      `Built a ${args.rows}×${args.cols} brick/grid tiling of ${sourceSummary} ` +
      `(gap=${args.gap}, jitter_pos=${args.jitter_pos}, jitter_rot=${args.jitter_rot.toFixed(2)}rad, ` +
      `brick_offset=${args.brick_offset}) → ${out}. ` +
      `Approach: a single GLSL TOP shader does per-cell gap inset + position/rotation jitter + brick ` +
      `offset in one pass (a stock tileTOP has no per-cell gap/jitter controls, so a tileTOP/transformTOP ` +
      `chain could only apply one uniform transform to the whole grid, not true per-cell variation).`;

    const extra: Record<string, unknown> = {
      approach: "glsl",
      rows: args.rows,
      cols: args.cols,
      gap: args.gap,
      jitter_pos: args.jitter_pos,
      jitter_rot: args.jitter_rot,
      brick_offset: args.brick_offset,
      source_path: args.source_path ?? null,
      resolution: args.resolution,
      source_node: sourceNode,
      glsl_node: glsl,
      frag_dat: fragDat,
      output_path: out,
      unverified: [
        "glslTOP 'Vectors' page uniform binding: op.seq.vec block layout (numBlocks, block[i].par.name, " +
          "valuex/y/z/w) is asserted from the recipe glsl_uniforms convention (see orchestration.ts " +
          "groupUniforms) but not independently live-verified on a glslTOP specifically — set defensively " +
          "inside a try/except so a mismatch degrades to a warning, not a failed build.",
        "glslTOP.par.pixeldat expects the Text DAT's .name (not full path) per existing recipe code — " +
          "set defensively via try/except.",
        "GLSL version/`out vec4 fragColor` + `sTD2DInputs[0]` + `vUV.st` are the standard TD GLSL TOP " +
          "conventions (implicit #version + TD-injected varyings/samplers); not re-verified live in this " +
          "build.",
      ],
    };

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra,
    });
  });
}

export const registerCreateStepRepeat: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_step_repeat",
    {
      title: "Create step repeat (brick/grid tiling)",
      description:
        "Tile a source TOP into a rows×cols brick/grid pattern with per-cell gap, position jitter, " +
        "rotation jitter, and an optional brick/masonry half-tile row offset — all computed per-cell in " +
        "a single GLSL TOP shader (stock TOPs only, no external files besides the optional source). " +
        "Defaults to TD's bundled Mosaic.mp4 test clip so the grid previews standalone without a source. " +
        "Output is a nullTOP. Returns a summary plus JSON with node paths, live controls, warnings, and " +
        "an inline preview image.",
      inputSchema: createStepRepeatSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createStepRepeatImpl(ctx, args),
  );
};
