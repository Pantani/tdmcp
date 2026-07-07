import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parseHexColor, rgbToHex } from "../util/color.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Order↔chaos grid generator. A single GLSL TOP draws a `rows × cols` grid of filled quads (or
 * outlined cells) where one `disorder` knob (0 = a perfect grid, 1 = full chaos) scales per-cell
 * position, rotation, and scale jitter — each hashed from the cell index so it is stable and
 * reproducible. Classic generative-design "controlled randomness" (Schotter) in one pass, no
 * external source. Named generically so it fits any order/chaos study.
 */

const CELL_FRAG = `
uniform vec2 uGrid;        // (cols, rows)
uniform float uDisorder;   // 0 = perfect grid, 1 = full chaos
uniform float uPosAmt;     // max position jitter (fraction of a cell)
uniform float uRotAmt;     // max rotation jitter (radians)
uniform float uScaleAmt;   // max scale jitter (fraction)
uniform float uFill;       // cell size 0..1 within its slot
uniform float uOutline;    // 1 = draw outlined cells, 0 = filled quads
uniform float uLineWidth;  // outline thickness (fraction of a cell)
uniform vec3 uCellColor;
uniform vec3 uBackground;

out vec4 fragColor;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p){ return vec2(hash21(p), hash21(p + vec2(19.19, 7.7))); }

// signed distance to an axis-aligned box of half-size b, point q in box-local space
float sdBox(vec2 q, vec2 b){
  vec2 d = abs(q) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main(){
  vec2 grid = max(uGrid, vec2(1.0));
  vec2 cellF = vUV.st * grid;
  vec2 cellId = floor(cellF);
  vec2 cellUV = fract(cellF) - 0.5;   // -0.5..0.5 centered in the slot

  // per-cell hashed disorder, scaled by the single uDisorder knob
  vec2 rnd = hash22(cellId + 3.17);
  float rr = hash21(cellId + 8.4);
  vec2 posJit = (rnd - 0.5) * 2.0 * uPosAmt * uDisorder;
  float rot   = (rr - 0.5) * 2.0 * uRotAmt * uDisorder;
  float scl   = 1.0 + (hash21(cellId + 1.9) - 0.5) * 2.0 * uScaleAmt * uDisorder;

  // move into the cell's local frame, apply position + rotation + scale
  vec2 p = cellUV - posJit;
  float c = cos(rot), s = sin(rot);
  p = mat2(c, -s, s, c) * p;
  p /= max(scl, 0.05);

  vec2 half = vec2(0.5 * uFill);
  float d = sdBox(p, half);

  float aa = 1.5 / max(grid.x, grid.y) / 200.0;
  float mask;
  if(uOutline > 0.5){
    float w = max(uLineWidth, 0.001);
    // outline = band around the box edge
    mask = smoothstep(w + aa, w, abs(d));
  } else {
    mask = smoothstep(aa, -aa, d);
  }

  vec3 col = mix(uBackground, uCellColor, mask);
  fragColor = vec4(col, 1.0);
}
`;

export const controlledDisorderGridSchema = z.object({
  rows: z.coerce
    .number()
    .int()
    .min(1)
    .max(128)
    .default(20)
    .describe("Number of grid rows (top to bottom)."),
  cols: z.coerce
    .number()
    .int()
    .min(1)
    .max(128)
    .default(20)
    .describe("Number of grid columns (left to right)."),
  disorder: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe(
      "The single order↔chaos knob. 0 = a perfect grid; 1 = full chaos. Scales all per-cell position/rotation/scale jitter together.",
    ),
  pos_jitter: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Max per-cell position offset at disorder=1 (fraction of a cell)."),
  rot_jitter: z.coerce
    .number()
    .min(0)
    .max(Math.PI)
    .default(1.2)
    .describe("Max per-cell rotation at disorder=1 (radians)."),
  scale_jitter: z.coerce
    .number()
    .min(0)
    .max(0.9)
    .default(0.3)
    .describe("Max per-cell scale variation at disorder=1 (fraction)."),
  fill: z.coerce
    .number()
    .min(0.05)
    .max(1)
    .default(0.7)
    .describe("Cell size within its slot (0..1); leaves gutters between cells."),
  outline: z
    .boolean()
    .default(false)
    .describe("Draw outlined cells instead of filled quads (classic Schotter look)."),
  line_width: z.coerce
    .number()
    .min(0.005)
    .max(0.5)
    .default(0.04)
    .describe("Outline thickness (fraction of a cell); used only when outline=true."),
  cell_color: z
    .string()
    .default("#f2f2f2")
    .describe("Cell / line colour hex (e.g. '#f2f2f2'). Live RGB swatch 'CellColor'."),
  background: z
    .string()
    .default("#101014")
    .describe("Background colour hex. Live RGB swatch 'Background'."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1080, 1080])
    .describe("Output resolution [width, height] of the GLSL TOP (square suits a grid)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose the live Disorder knob (and CellColor/Background swatches)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'disorder_grid' container is created inside."),
});
type ControlledDisorderGridArgs = z.infer<typeof controlledDisorderGridSchema>;

export async function controlledDisorderGridImpl(
  ctx: ToolContext,
  args: ControlledDisorderGridArgs,
) {
  return runBuild(async () => {
    const defaultCell: [number, number, number] = [0.949, 0.949, 0.949];
    const defaultBg: [number, number, number] = [0.063, 0.063, 0.078];
    const cell = parseHexColor(args.cell_color) ?? defaultCell;
    const bg = parseHexColor(args.background) ?? defaultBg;

    const colorWarnings: string[] = [];
    if (parseHexColor(args.cell_color) === undefined)
      colorWarnings.push(`Could not parse cell_color "${args.cell_color}"; used the default.`);
    if (parseHexColor(args.background) === undefined)
      colorWarnings.push(`Could not parse background "${args.background}"; used the default.`);

    const builder = await createSystemContainer(ctx, args.parent_path, "disorder_grid");
    const [width, height] = args.resolution;

    const glsl = await builder.add("glslTOP", "grid", {
      resolutionw: width,
      resolutionh: height,
      outputresolution: "custom",
    });
    const frag = await builder.add("textDAT", "grid_frag");
    await builder.python(
      `op(${q(frag)}).text = ${q(CELL_FRAG)}\ntry:\n    op(${q(glsl)}).par.pixeldat = op(${q(frag)}).name\nexcept Exception:\n    pass`,
    );

    // The Disorder knob is read live via an expr with a hasattr fallback so turning it
    // rebuilds the layout without re-running the tool. The rest are baked.
    const disorderExpr = `parent().par.Disorder.eval() if hasattr(parent().par, 'Disorder') else ${args.disorder}`;
    const colorExpr = (control: string, fallback: number): string =>
      `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;

    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 8)`,
        `_g.par.vec0name = 'uGrid'`,
        `_g.par.vec0valuex = ${args.cols}`,
        `_g.par.vec0valuey = ${args.rows}`,
        `_g.par.vec1name = 'uDisorder'`,
        `_g.par.vec1valuex.expr = ${q(disorderExpr)}`,
        `_g.par.vec2name = 'uPosAmt'`,
        `_g.par.vec2valuex = ${args.pos_jitter}`,
        `_g.par.vec3name = 'uRotAmt'`,
        `_g.par.vec3valuex = ${args.rot_jitter}`,
        `_g.par.vec4name = 'uScaleAmt'`,
        `_g.par.vec4valuex = ${args.scale_jitter}`,
        `_g.par.vec5name = 'uFill'`,
        `_g.par.vec5valuex = ${args.fill}`,
        `_g.par.vec6name = 'uOutline'`,
        `_g.par.vec6valuex = ${args.outline ? 1 : 0}`,
        `_g.par.vec7name = 'uLineWidth'`,
        `_g.par.vec7valuex = ${args.line_width}`,
        `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 2)`,
        `_g.par.color0name = 'uCellColor'`,
        `_g.par.color0rgbr.expr = ${q(colorExpr("Cellcolorr", cell[0]))}`,
        `_g.par.color0rgbg.expr = ${q(colorExpr("Cellcolorg", cell[1]))}`,
        `_g.par.color0rgbb.expr = ${q(colorExpr("Cellcolorb", cell[2]))}`,
        `_g.par.color1name = 'uBackground'`,
        `_g.par.color1rgbr.expr = ${q(colorExpr("Backgroundr", bg[0]))}`,
        `_g.par.color1rgbg.expr = ${q(colorExpr("Backgroundg", bg[1]))}`,
        `_g.par.color1rgbb.expr = ${q(colorExpr("Backgroundb", bg[2]))}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    builder.warnings.push(...colorWarnings);
    builder.warnings.push(
      "Per-cell jitter is hashed from the cell index in-shader (stable/reproducible). GLSL 'Vectors'/'Colors' uniform sub-parameters are set defensively; a par-name mismatch degrades to a warning, not a failed build.",
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Disorder",
            type: "float",
            min: 0,
            max: 1,
            default: args.disorder,
          },
          { name: "CellColor", type: "rgb", default: rgbToHex(cell) },
          { name: "Background", type: "rgb", default: rgbToHex(bg) },
        ]
      : [];

    const look = args.outline ? "outlined cells" : "filled quads";
    return finalize(ctx, {
      summary: `Built a ${args.rows}×${args.cols} controlled-disorder grid of ${look} (disorder ${args.disorder}) → ${out} — one GLSL TOP; the single Disorder knob (0=order → 1=chaos) scales per-cell position/rotation/scale jitter.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        rows: args.rows,
        cols: args.cols,
        disorder: args.disorder,
        pos_jitter: args.pos_jitter,
        rot_jitter: args.rot_jitter,
        scale_jitter: args.scale_jitter,
        fill: args.fill,
        outline: args.outline,
        line_width: args.line_width,
        cell_color: cell,
        background: bg,
        resolution: args.resolution,
        glsl_node: glsl,
        output_path: out,
      },
    });
  });
}

export const registerControlledDisorderGrid: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "controlled_disorder_grid",
    {
      title: "Controlled disorder grid",
      description:
        "Generate a rows×cols grid of quads (or outlined cells) with a single order↔chaos `disorder` knob: 0 = a perfect grid, 1 = full chaos. The one knob scales per-cell position, rotation, and scale jitter together — each hashed from the cell index in a single GLSL TOP so the pattern is stable and reproducible (the classic generative-design 'controlled randomness' / Schotter study, no external source). Set `outline: true` for line cells. Creates a new baseCOMP under `parent_path`. Exposes the live Disorder knob plus CellColor/Background swatches. Returns a summary plus a JSON block with node paths, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: controlledDisorderGridSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => controlledDisorderGridImpl(ctx, args),
  );
};
