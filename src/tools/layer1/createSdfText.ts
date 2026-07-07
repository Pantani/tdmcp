import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parseHexColor, rgbToHex } from "../util/color.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * SDF text raymarcher. A Text TOP renders the string to a mask; that mask is treated as an
 * extruded 3D slab (an SDF whose 2D cross-section is the glyph coverage and whose thickness is
 * `depth`) and raymarched in a GLSL TOP so the letters read as solid, lit, beveled 3D volumes
 * — optionally spinning. Distinct from create_sdf_field (primitive CSG only, no text) and from
 * create_text_3d (mesh-extruded text SOP): this is a raymarched, distance-field text look.
 *
 * The mask→SDF is approximate: the glyph coverage from the Text TOP defines inside/outside in
 * the XY plane, and the slab is closed by two Z planes at ±depth/2. Because the XY distance is
 * estimated from the coverage gradient (not a true font SDF atlas), edges are softened by a
 * small `smoothing` — legible and robustly stock-TD, no external SDF atlas asset required.
 */

const MARCH_BODY = `float sdText(vec3 pos){
  // XY: sample the glyph mask; inside letters -> negative distance. The coverage is
  // a 0..1 field; remap to a signed value and scale so it behaves like a shallow SDF.
  vec2 uv = pos.xy * 0.5 + 0.5;
  float cov = texture(sTD2DInputs[0], uv).r;
  float xy = (0.5 - cov) * uSmoothing;
  // Z: close the slab at +/- half depth.
  float z = abs(pos.z) - uDepth * 0.5;
  // Outside the mask uv range is empty.
  float outside = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
  return max(max(xy, z), outside);
}
vec3 sdTextNormal(vec3 pos){
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    sdText(pos + e.xyy) - sdText(pos - e.xyy),
    sdText(pos + e.yxy) - sdText(pos - e.yxy),
    sdText(pos + e.yyx) - sdText(pos - e.yyx)));
}
void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  vec3 ro = vec3(0.0, 0.0, max(uCameraZ, 0.1));
  vec3 fwd = normalize(vec3(0.0, 0.0, -1.0));
  vec3 right = vec3(1.0, 0.0, 0.0);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 rd = normalize(fwd + uv.x * right + uv.y * up);
  // rotate the sample space (letters turn) driven by uRotate * uTime
  float a = uTime * uRotate;
  float ca = cos(a), sa = sin(a);
  mat3 rot = mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca);
  float traveled = 0.0;
  float hit = 0.0;
  for(int i = 0; i < 128; i++){
    if(i >= int(max(uSteps, 1.0))){ break; }
    vec3 pos = rot * (ro + rd * traveled);
    float dist = sdText(pos);
    if(dist < 0.001){ hit = 1.0; break; }
    traveled += max(dist, 0.004);
    if(traveled > 20.0){ break; }
  }
  vec3 col = uBackground;
  if(hit > 0.5){
    vec3 pos = rot * (ro + rd * traveled);
    vec3 n = sdTextNormal(pos);
    float diff = max(dot(n, normalize(uLightDir)), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.0);
    col = uFill * (0.2 + 0.8 * diff) + uEdge * rim * 0.6;
  }
  col *= max(uIntensity, 0.0);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

export const createSdfTextSchema = z.object({
  text: z.string().min(1).max(64).default("HELLO").describe("The string to raymarch as SDF text."),
  font: z
    .string()
    .default("Arial")
    .describe("Font family for the Text TOP that seeds the glyph mask (must be installed in TD)."),
  bold: z.boolean().default(true).describe("Render the seed text bold (thicker glyph coverage)."),
  depth: z.coerce
    .number()
    .positive()
    .default(0.25)
    .describe("Extrusion thickness of the raymarched text slab along Z (uDepth)."),
  smoothing: z.coerce
    .number()
    .min(0.05)
    .max(2)
    .default(0.6)
    .describe(
      "How sharply the mask coverage maps to the XY distance field. Lower = crisper edges, higher = softer/rounder.",
    ),
  camera_z: z.coerce
    .number()
    .min(1)
    .max(8)
    .default(2.2)
    .describe("Camera distance from the text (uCameraZ). Live 'CameraZ' control."),
  rotate: z.coerce
    .number()
    .min(-6.28)
    .max(6.28)
    .default(0.0)
    .describe(
      "Y-axis rotation speed of the text (radians/s via uRotate * uTime). Live 'Rotate'. Reads 0 when the TD timeline is paused.",
    ),
  speed: z.coerce
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe("Animation time multiplier (drives uTime). Live 'Speed' control."),
  step_count: z.coerce
    .number()
    .int()
    .min(16)
    .max(128)
    .default(80)
    .describe("Raymarch iterations (uSteps). Live 'StepCount'."),
  intensity: z.coerce
    .number()
    .min(0)
    .max(3)
    .default(1)
    .describe("Output brightness multiplier (uIntensity). Live 'Intensity'."),
  fill_color: z
    .string()
    .default("#ffd34d")
    .describe("Letter body colour hex (e.g. '#ffd34d'). Live RGB swatch 'Fill'."),
  edge_color: z
    .string()
    .default("#ff5c8a")
    .describe("Rim/edge highlight colour hex. Live RGB swatch 'Edge'."),
  background: z
    .string()
    .default("#0a0a12")
    .describe("Background / miss colour hex. Live RGB swatch 'Background'."),
  light_direction: z
    .tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()])
    .default([0.4, 0.6, 0.8])
    .describe("Light direction, normalised in shader — baked as GLSL constant."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height] of the GLSL TOP."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live CameraZ/Speed/StepCount/Intensity/Rotate/Fill/Edge/Background controls.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'sdf_text' container is created inside."),
});
type CreateSdfTextArgs = z.infer<typeof createSdfTextSchema>;

function buildFragmentShader(lightDir: [number, number, number]): string {
  const ld = lightDir;
  const len = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]) || 1;
  const uniforms = `out vec4 fragColor;
uniform float uTime;
uniform float uCameraZ;
uniform float uSteps;
uniform float uIntensity;
uniform float uRotate;
uniform float uDepth;
uniform float uSmoothing;
uniform vec3  uFill;
uniform vec3  uEdge;
uniform vec3  uBackground;
const vec3 uLightDir = normalize(vec3(${(ld[0] / len).toFixed(4)}, ${(ld[1] / len).toFixed(4)}, ${(ld[2] / len).toFixed(4)}));
`;
  return `${uniforms}
${MARCH_BODY}`;
}

export async function createSdfTextImpl(ctx: ToolContext, args: CreateSdfTextArgs) {
  return runBuild(async () => {
    const defaultFill: [number, number, number] = [1.0, 0.827, 0.302];
    const defaultEdge: [number, number, number] = [1.0, 0.361, 0.541];
    const defaultBg: [number, number, number] = [0.039, 0.039, 0.071];

    const fill = parseHexColor(args.fill_color) ?? defaultFill;
    const edge = parseHexColor(args.edge_color) ?? defaultEdge;
    const bg = parseHexColor(args.background) ?? defaultBg;

    const colorWarnings: string[] = [];
    if (parseHexColor(args.fill_color) === undefined)
      colorWarnings.push(`Could not parse fill_color "${args.fill_color}"; used the default.`);
    if (parseHexColor(args.edge_color) === undefined)
      colorWarnings.push(`Could not parse edge_color "${args.edge_color}"; used the default.`);
    if (parseHexColor(args.background) === undefined)
      colorWarnings.push(`Could not parse background "${args.background}"; used the default.`);

    const builder = await createSystemContainer(ctx, args.parent_path, "sdf_text");
    const [width, height] = args.resolution;

    // ── Glyph mask source ─────────────────────────────────────────────────────
    // A Text TOP renders the string white-on-black; its red channel is the glyph
    // coverage the shader turns into an SDF. Square-ish so the letters fit the -1..1
    // sample space; black background keeps outside-of-letter coverage at 0.
    const textTop = await builder.add("textTOP", "glyph_mask", {
      text: args.text,
      font: args.font,
      fontsizex: 200,
      alignx: "center",
      aligny: "center",
      resolutionw: 1024,
      resolutionh: 1024,
      bgcolorr: 0,
      bgcolorg: 0,
      bgcolorb: 0,
      bgalpha: 1,
      fontcolorr: 1,
      fontcolorg: 1,
      fontcolorb: 1,
    });
    // `bold` is a menu/toggle on the Text TOP; set defensively.
    await builder.python(
      `try:\n    op(${q(textTop)}).par.bold = ${args.bold ? 1 : 0}\nexcept Exception:\n    pass`,
    );

    // ── GLSL raymarcher ───────────────────────────────────────────────────────
    const glsl = await builder.add("glslTOP", "raymarch", {
      resolutionw: width,
      resolutionh: height,
      outputresolution: "custom",
    });
    await builder.connect(textTop, glsl, 0, 0);

    const frag = await builder.add("textDAT", "raymarch_frag");
    const fragment = buildFragmentShader(args.light_direction);
    await builder.python(
      `op(${q(frag)}).text = ${q(fragment)}\ntry:\n    op(${q(glsl)}).par.pixeldat = op(${q(frag)}).name\nexcept Exception:\n    pass`,
    );

    // Uniforms — scalars/vec via the "Vectors" page, colours via the "Colors" page.
    // Scalar uniforms read the container's exposed pars via expr with a hasattr fallback,
    // so turning a knob updates the shader live (mirrors create_sdf_field).
    const timeExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`;
    const camExpr = `parent().par.Cameraz.eval() if hasattr(parent().par, 'Cameraz') else ${args.camera_z}`;
    const stepsExpr = `parent().par.Stepcount.eval() if hasattr(parent().par, 'Stepcount') else ${args.step_count}`;
    const intensityExpr = `parent().par.Intensity.eval() if hasattr(parent().par, 'Intensity') else ${args.intensity}`;
    const rotateExpr = `parent().par.Rotate.eval() if hasattr(parent().par, 'Rotate') else ${args.rotate}`;
    const colorExpr = (control: string, fallback: number): string =>
      `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;

    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 7)`,
        `_g.par.vec0name = 'uTime'`,
        `_g.par.vec0valuex.expr = ${q(timeExpr)}`,
        `_g.par.vec1name = 'uCameraZ'`,
        `_g.par.vec1valuex.expr = ${q(camExpr)}`,
        `_g.par.vec2name = 'uSteps'`,
        `_g.par.vec2valuex.expr = ${q(stepsExpr)}`,
        `_g.par.vec3name = 'uIntensity'`,
        `_g.par.vec3valuex.expr = ${q(intensityExpr)}`,
        `_g.par.vec4name = 'uRotate'`,
        `_g.par.vec4valuex.expr = ${q(rotateExpr)}`,
        `_g.par.vec5name = 'uDepth'`,
        `_g.par.vec5valuex = ${args.depth}`,
        `_g.par.vec6name = 'uSmoothing'`,
        `_g.par.vec6valuex = ${args.smoothing}`,
        `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 3)`,
        `_g.par.color0name = 'uFill'`,
        `_g.par.color0rgbr.expr = ${q(colorExpr("Fillr", fill[0]))}`,
        `_g.par.color0rgbg.expr = ${q(colorExpr("Fillg", fill[1]))}`,
        `_g.par.color0rgbb.expr = ${q(colorExpr("Fillb", fill[2]))}`,
        `_g.par.color1name = 'uEdge'`,
        `_g.par.color1rgbr.expr = ${q(colorExpr("Edger", edge[0]))}`,
        `_g.par.color1rgbg.expr = ${q(colorExpr("Edgeg", edge[1]))}`,
        `_g.par.color1rgbb.expr = ${q(colorExpr("Edgeb", edge[2]))}`,
        `_g.par.color2name = 'uBackground'`,
        `_g.par.color2rgbr.expr = ${q(colorExpr("Backgroundr", bg[0]))}`,
        `_g.par.color2rgbg.expr = ${q(colorExpr("Backgroundg", bg[1]))}`,
        `_g.par.color2rgbb.expr = ${q(colorExpr("Backgroundb", bg[2]))}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    builder.warnings.push(...colorWarnings);
    builder.warnings.push(
      "The mask→SDF is approximate: the XY distance is estimated from the Text TOP's coverage (not a true font SDF atlas), so edges are eased by `smoothing`. Text TOP `bold` and GLSL 'Vectors'/'Colors' uniform sub-parameters are set defensively; a menu/par-name mismatch degrades to a warning, not a failed build.",
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "CameraZ", type: "float", min: 1, max: 8, default: args.camera_z },
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "StepCount", type: "int", min: 16, max: 128, default: args.step_count },
          { name: "Intensity", type: "float", min: 0, max: 3, default: args.intensity },
          { name: "Rotate", type: "float", min: -6.28, max: 6.28, default: args.rotate },
          { name: "Fill", type: "rgb", default: rgbToHex(fill) },
          { name: "Edge", type: "rgb", default: rgbToHex(edge) },
          { name: "Background", type: "rgb", default: rgbToHex(bg) },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built SDF raymarched text "${args.text}" (font ${args.font}, depth ${args.depth}) → ${out} — Text TOP glyph mask → GLSL raymarch slab.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        text: args.text,
        font: args.font,
        bold: args.bold,
        depth: args.depth,
        smoothing: args.smoothing,
        camera_z: args.camera_z,
        rotate: args.rotate,
        speed: args.speed,
        step_count: args.step_count,
        intensity: args.intensity,
        fill_color: fill,
        edge_color: edge,
        background: bg,
        resolution: args.resolution,
        glyph_mask: textTop,
        glsl_node: glsl,
        output_path: out,
      },
    });
  });
}

export const registerCreateSdfText: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_sdf_text",
    {
      title: "Create SDF text",
      description:
        "Raymarch a text string as a signed-distance-field 3D slab: a Text TOP renders the glyphs to a mask, and a GLSL TOP treats that mask as an extruded distance field (glyph coverage in XY, closed by two Z planes at ±depth/2) so the letters read as solid, lit, rim-highlit 3D volumes that can spin. Distinct from create_sdf_field (primitive CSG only, no text) and create_text_3d (mesh-extruded text SOP) — this is the raymarched distance-field text look. The mask→SDF is approximate (coverage-derived, no external font SDF atlas required) and eased by `smoothing`. Creates a new baseCOMP under `parent_path`. Exposes CameraZ/Speed/StepCount/Intensity/Rotate/Fill/Edge/Background controls and previews the output. Returns a summary plus a JSON block with node paths, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: createSdfTextSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSdfTextImpl(ctx, args),
  );
};
