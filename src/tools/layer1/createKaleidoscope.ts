import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

// Single-pass kaleidoscope / radial-mirror fold. TouchDesigner has no native polar (cartesian↔
// polar) TOP — confirmed absent from the knowledge base — so the classic polarTOP→mirror→polarTOP
// chain isn't available; this does the whole fold in one GLSL TOP, which is self-contained and has
// no per-op compile risk beyond this shader. It samples the source via sTD2DInputs[0] (the wired
// input), converts each pixel to polar (atan/length around the centre), folds the angle into one
// wedge with mod()+mirror so N identical mirrored segments tile the circle, then samples the source
// back. Uniforms are bound to parent().par.* by the builder so the exposed knobs drive it live.
//
// GLSL gotchas obeyed: declares `out vec4 fragColor`, writes via TDOutputSwizzle(); no built-in
// uTime is used (rotation is a uniform/control, not time); variable names are lowercase (no F1/F2
// that collide with the TD preamble #defines).
const KALEIDOSCOPE_SHADER = `out vec4 fragColor;
uniform float uSegments;
uniform float uRotation;
uniform float uZoom;
uniform vec2  uCenter;

const float kPi  = 3.14159265359;
const float kTau = 6.28318530718;

void main(){
    // Centre the coordinates on the kaleidoscope origin and apply zoom.
    vec2 pos = (vUV.st - uCenter) / max(uZoom, 0.0001);

    // To polar.
    float radius = length(pos);
    float angle  = atan(pos.y, pos.x) + uRotation;

    // Fold the angle into a single wedge, then mirror every other wedge so adjacent
    // segments meet edge-to-edge (a true kaleidoscope mirror rather than a plain repeat).
    float segments = max(uSegments, 2.0);
    float wedge = kTau / segments;
    angle = mod(angle, wedge);
    angle = abs(angle - 0.5 * wedge);

    // Back to cartesian, re-centred so we re-sample the original source texture.
    vec2 uv = uCenter + radius * vec2(cos(angle), sin(angle));

    // Outside [0,1] the source has no data; mirror-wrap so the look stays filled and seamless.
    uv = abs(fract(uv * 0.5) * 2.0 - 1.0);

    fragColor = TDOutputSwizzle(texture(sTD2DInputs[0], uv));
}
`;

export const createKaleidoscopeSchema = z.object({
  segments: z.coerce
    .number()
    .int()
    .min(2)
    .default(6)
    .describe("Number of mirrored wedges (N-fold symmetry). 6 is the classic look; higher = finer."),
  rotation: z.coerce
    .number()
    .default(0)
    .describe("Rotation of the whole kaleidoscope, in radians. Animate/bind this to spin it."),
  zoom: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("Zoom into the source — >1 magnifies the pattern, <1 pulls more of the source in."),
  center_x: z.coerce
    .number()
    .default(0.5)
    .describe("Kaleidoscope centre X in normalized UV (0–1). 0.5 is the middle of the frame."),
  center_y: z.coerce
    .number()
    .default(0.5)
    .describe("Kaleidoscope centre Y in normalized UV (0–1). 0.5 is the middle of the frame."),
  input_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of a source TOP to kaleidoscope. Brought in via a Select TOP (cross-container wiring silently no-ops). If omitted, a coloured noise source is generated so the network previews on its own.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Segments / Rotation / Zoom / Center X / Center Y knobs on the container."),
  parent_path: z.string().default("/project1"),
});
type CreateKaleidoscopeArgs = z.infer<typeof createKaleidoscopeSchema>;

/**
 * Brings in the source: a Select TOP referencing `input_path` by absolute path (you cannot wire
 * across containers), or — with no input — a coloured animated noise so the system previews and
 * tests with zero external dependencies.
 */
async function buildSource(builder: NetworkBuilder, args: CreateKaleidoscopeArgs): Promise<string> {
  if (args.input_path) {
    return builder.add("selectTOP", "source", { top: args.input_path });
  }
  // Coloured (non-monochrome) noise gives the fold something with structure and hue to mirror.
  const noise = await builder.add("noiseTOP", "source", { monochrome: 0, period: 4 });
  // Drift the noise over time so the default look is alive even before any control is touched.
  await builder.python(
    `op(${q(noise)}).par.tz.expr = ${q("absTime.seconds * 0.2")}`,
  );
  return noise;
}

export async function createKaleidoscopeImpl(ctx: ToolContext, args: CreateKaleidoscopeArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "kaleidoscope");

    const source = await buildSource(builder, args);

    // The fold itself. A fixed RGBA canvas keeps the output a clean full-res frame regardless of
    // the source's resolution (the GLSL TOP otherwise inherits input 0's size).
    const kaleido = await builder.add("glslTOP", "kaleido", {
      outputresolution: "custom",
      resolutionw: 1280,
      resolutionh: 720,
      format: "rgba8fixed",
    });
    const frag = await builder.add("textDAT", "kaleido_frag");
    await builder.python(
      `op(${q(frag)}).text = ${q(KALEIDOSCOPE_SHADER)}\nop(${q(kaleido)}).par.pixeldat = op(${q(frag)}).name`,
    );
    await builder.connect(source, kaleido);

    // Bind the four uniforms. uSegments/uRotation/uZoom are scalar floats and uCenter is a vec2 —
    // both kinds live in the GLSL TOP's "Vectors" sequence (a float fills valuex; the vec2 fills
    // valuex/valuey). The sequence block count has no structured setter, so raise numBlocks first,
    // then name each block and drive its components by expression off parent().par.* so the
    // exposed knobs move them live. A defensive hasattr() fallback uses the build-time constant
    // when no control is present, so the expression never errors.
    const segExpr = `(parent().par.Segments.eval() if hasattr(parent().par, 'Segments') else ${args.segments})`;
    const rotExpr = `(parent().par.Rotation.eval() if hasattr(parent().par, 'Rotation') else ${args.rotation})`;
    const zoomExpr = `(parent().par.Zoom.eval() if hasattr(parent().par, 'Zoom') else ${args.zoom})`;
    const cxExpr = `(parent().par.Centerx.eval() if hasattr(parent().par, 'Centerx') else ${args.center_x})`;
    const cyExpr = `(parent().par.Centery.eval() if hasattr(parent().par, 'Centery') else ${args.center_y})`;
    await builder.python(
      [
        `_g = op(${q(kaleido)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 4)`,
        `_g.par.vec0name = 'uSegments'`,
        `_g.par.vec0valuex.expr = ${q(segExpr)}`,
        `_g.par.vec1name = 'uRotation'`,
        `_g.par.vec1valuex.expr = ${q(rotExpr)}`,
        `_g.par.vec2name = 'uZoom'`,
        `_g.par.vec2valuex.expr = ${q(zoomExpr)}`,
        `_g.par.vec3name = 'uCenter'`,
        `_g.par.vec3valuex.expr = ${q(cxExpr)}`,
        `_g.par.vec3valuey.expr = ${q(cyExpr)}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(kaleido, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Segments", type: "int", min: 2, max: 32, default: args.segments },
          { name: "Rotation", type: "float", min: 0, max: 6.2832, default: args.rotation },
          { name: "Zoom", type: "float", min: 0.1, max: 4, default: args.zoom },
          { name: "Center X", type: "float", min: 0, max: 1, default: args.center_x },
          { name: "Center Y", type: "float", min: 0, max: 1, default: args.center_y },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a ${args.segments}-fold kaleidoscope ${
        args.input_path ? `over ${args.input_path}` : "over a generated noise source"
      } → ${out}. Bind a parameter to op('${out}').par.Rotation (on the container) — or feed input_path — to drive it.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        segments: args.segments,
        rotation: args.rotation,
        zoom: args.zoom,
        center: [args.center_x, args.center_y],
        input_path: args.input_path ?? null,
      },
    });
  });
}

export const registerCreateKaleidoscope: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_kaleidoscope",
    {
      title: "Create kaleidoscope",
      description:
        "Wrap a source in a kaleidoscope / radial-mirror symmetry effect — a signature VJ look. Folds the image into N identical mirrored wedges around a centre, with live Segments / Rotation / Zoom / Center controls. Pass input_path (an absolute TOP path) to kaleidoscope an existing visual, or omit it to generate a self-contained noise source that previews on its own. Output is a TOP.",
      inputSchema: createKaleidoscopeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKaleidoscopeImpl(ctx, args),
  );
};
