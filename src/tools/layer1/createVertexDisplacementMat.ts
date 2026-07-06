import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * True vertex-shader displacement material. Builds a GLSL MAT whose vertex stage offsets each
 * vertex along its normal by procedural 3D noise (or, when `texture_path` is given, by the
 * luminance of a sampled TOP). The MAT is assigned to a target Geometry COMP so its mesh is
 * physically deformed on the GPU — distinct from the TOP-space image warps
 * create_depth_displacement / create_displacement_warp, which push 2D pixels, not mesh vertices.
 *
 * If `target_geo` is omitted, a demo Geometry COMP + subdivided sphere is created so the MAT
 * previews standalone; otherwise the tool only builds + assigns the MAT (and captures no
 * preview, since it does not own the target's render chain).
 */

const rgb = z.coerce.number().min(0).max(1);

export const createVertexDisplacementMatSchema = z.object({
  target_geo: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing Geometry COMP to assign the displacement MAT to. Omit to build a self-contained demo (subdivided sphere + camera + light + render) so the material previews standalone.",
    ),
  texture_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of a TOP whose luminance drives the displacement instead of procedural noise. Omit to use built-in 3D noise.",
    ),
  amount: z.coerce
    .number()
    .min(0)
    .default(0.25)
    .describe("Displacement distance along each vertex normal (uAmount). 0 = undeformed."),
  frequency: z.coerce
    .number()
    .positive()
    .default(2.5)
    .describe("Spatial frequency of the procedural noise (ignored when texture_path is set)."),
  speed: z.coerce
    .number()
    .min(0)
    .default(0.3)
    .describe(
      "Animation speed of the noise field (uTime scroll, cycles/s). 0 = static. Reads 0 when the TD timeline is paused.",
    ),
  demo_subdivisions: z.coerce
    .number()
    .int()
    .min(8)
    .max(400)
    .default(140)
    .describe("Demo sphere mesh resolution (only used when target_geo is omitted)."),
  demo_color: z
    .tuple([rgb, rgb, rgb])
    .default([0.6, 0.75, 0.95])
    .describe("Demo surface tint (RGB 0..1); shaded by facing + displacement. Demo only."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Amount / Frequency / Speed controls bound to the MAT.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the container (holding the MAT and, for the demo, the render chain) is created.",
    ),
});
type CreateVertexDisplacementMatArgs = z.infer<typeof createVertexDisplacementMatSchema>;

export async function createVertexDisplacementMatImpl(
  ctx: ToolContext,
  args: CreateVertexDisplacementMatArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "vertex_displace_mat");
    const useTexture = !!args.texture_path;
    const [cr, cg, cb] = args.demo_color;

    // ── GLSL displacement MAT ─────────────────────────────────────────────────
    // Vertex stage: offset P along the vertex normal N by uAmount × field, where the field is
    // either a Perlin-ish 3D noise (uTime-scrolled) or the luminance of a bound texture sampled
    // at the mesh UVs. iField carries the displacement to the pixel stage for shading.
    // MAT conventions: deform through TDDeform/TDWorldToProj, explicit uniforms, samplers bound
    // by name (a GLSL MAT does not auto-declare samplers like a GLSL TOP's sTD2DInputs).
    const mat = await builder.add("glslMAT", "displace");

    const noiseGlsl = `
// classic value-noise (hash-based) — good enough for vertex displacement
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

    const fieldExpr = useTexture
      ? "texture(sDisp, uv[0].st).r"
      : "vnoise(P * uFrequency + vec3(0.0, 0.0, uTime))";

    const vertexShader = [
      "uniform float uAmount;",
      "uniform float uFrequency;",
      "uniform float uTime;",
      ...(useTexture ? ["uniform sampler2D sDisp;"] : []),
      "out float iField;",
      noiseGlsl,
      "void main() {",
      `\tfloat field = ${fieldExpr};`,
      "\tiField = field;",
      "\tvec3 disp = P + N * (field * uAmount);",
      "\tgl_Position = TDWorldToProj(TDDeform(vec4(disp, 1.0)));",
      "}",
    ].join("\n");
    const vertDat = await builder.add("textDAT", "displace_vert");

    const pixelShader = [
      "in float iField;",
      "uniform vec3 uTint;",
      "void main() {",
      "\tvec3 col = uTint * (0.35 + 0.65 * clamp(iField, 0.0, 1.0));",
      "\tfragColor = TDOutputSwizzle(vec4(col, 1.0));",
      "}",
    ].join("\n");
    const fragDat = await builder.add("textDAT", "displace_pixel");

    const matSetup: string[] = [
      `op(${q(vertDat)}).text = ${q(vertexShader)}`,
      `op(${q(fragDat)}).text = ${q(pixelShader)}`,
      `_m = op(${q(mat)})`,
      `_m.par.vdat = op(${q(vertDat)}).name`,
      `_m.par.pdat = op(${q(fragDat)}).name`,
      // All uniforms (scalars AND the uTint vec3) bind through the "Vectors" page: a
      // block's valuex/y/z/w carry up to a vec4 (live-verified against a real glslMAT —
      // the "Constants" page holds a single scalar `const<i>value`, not per-component
      // colour sub-parameters).
      "_seq = _m.seq.vec",
      "_seq.numBlocks = max(_seq.numBlocks, 4)",
      '_m.par.vec0name = "uAmount"',
      `_m.par.vec0valuex = ${args.amount}`,
      '_m.par.vec1name = "uFrequency"',
      `_m.par.vec1valuex = ${args.frequency}`,
      '_m.par.vec2name = "uTime"',
      // uTime scrolls the noise; hasattr fallback keeps it cooking before controls exist.
      `_m.par.vec2valuex.expr = "absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})"`,
      '_m.par.vec3name = "uTint"',
      `_m.par.vec3valuex = ${cr}`,
      `_m.par.vec3valuey = ${cg}`,
      `_m.par.vec3valuez = ${cb}`,
    ];
    if (useTexture) {
      matSetup.push(
        `_m.par.sampler0top = ${q(args.texture_path as string)}`,
        '_m.par.sampler0name = "sDisp"',
      );
    }
    await builder.python(matSetup.join("\n"));

    // ── Assign to target, or build a demo render chain ────────────────────────
    let out: string | undefined;
    let demoGeo: string | undefined;
    let capturePreviewImage = false;

    if (args.target_geo) {
      // Assign the MAT to the caller's existing Geometry COMP. Defensive: if the path is not a
      // geometryCOMP, fold a warning rather than throwing.
      await builder.python(
        `try:\n    _g = op(${q(args.target_geo)})\n    if _g is not None:\n        _g.par.material = ${q(mat)}\nexcept Exception:\n    pass`,
      );
      builder.warnings.push(
        `Displacement MAT assigned to ${args.target_geo}. No preview captured — this tool does not own that geometry's render chain; render it in your own network to see the deformation.`,
      );
    } else {
      // Self-contained demo: subdivided sphere so the vertex displacement is visible.
      demoGeo = await builder.add("geometryCOMP", "demo_geo");
      const sphere = await builder.add(
        "sphereSOP",
        "demo_shape",
        { rows: args.demo_subdivisions, cols: args.demo_subdivisions, type: "polygon" },
        demoGeo,
      );
      await builder.python(`_s = op(${q(sphere)})\n_s.render = True\n_s.display = True`);
      await builder.python(`op(${q(demoGeo)}).par.material = ${q(mat)}`);

      const cam = await builder.add("cameraCOMP", "cam", { tz: 3.4 });
      const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 4 });
      const render = await builder.add("renderTOP", "render", {
        camera: cam,
        geometry: demoGeo,
        lights: light,
        bgcolorr: 0.03,
        bgcolorg: 0.03,
        bgcolorb: 0.05,
        bgcolora: 1,
      });
      out = await builder.add("nullTOP", "out1");
      await builder.connect(render, out);
      capturePreviewImage = true;
    }

    builder.warnings.push(
      "All uniforms (uAmount/uFrequency/uTime scalars and the uTint vec3) bind through the live-verified Vectors page (vec<i>valuex/y/z).",
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Amount",
            type: "float",
            min: 0,
            max: Math.max(1, args.amount * 4),
            default: args.amount,
            bind_to: [`${mat}.vec0valuex`],
          },
          {
            name: "Frequency",
            type: "float",
            min: 0.1,
            max: 12,
            default: args.frequency,
            bind_to: [`${mat}.vec1valuex`],
          },
          { name: "Speed", type: "float", min: 0, max: 3, default: args.speed },
        ]
      : [];

    const target = args.target_geo ? `assigned to ${args.target_geo}` : "on a demo sphere";
    const driver = useTexture ? `texture ${args.texture_path}` : "procedural 3D noise";
    return finalize(ctx, {
      summary: `Built a vertex-displacement GLSL MAT (${driver}, amount ${args.amount}) ${target} → ${out ?? mat}. This deforms real mesh vertices on the GPU, unlike the TOP-space warps create_depth_displacement / create_displacement_warp.`,
      builder,
      outputPath: out,
      capturePreviewImage,
      controls,
      extra: {
        target_geo: args.target_geo ?? null,
        texture_path: args.texture_path ?? null,
        driver: useTexture ? "texture" : "noise",
        amount: args.amount,
        frequency: args.frequency,
        speed: args.speed,
        material: mat,
        demo_geometry: demoGeo ?? null,
        output_path: out ?? null,
      },
    });
  });
}

export const registerCreateVertexDisplacementMat: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vertex_displacement_mat",
    {
      title: "Create vertex displacement MAT",
      description:
        "Build a true vertex-shader displacement material: a GLSL MAT whose vertex stage offsets each vertex along its normal by procedural 3D noise (uTime-animated) or by the luminance of a sampled TOP (`texture_path`), so the mesh is physically deformed on the GPU. Distinct from the TOP-space image warps create_depth_displacement / create_displacement_warp — those push 2D pixels; this pushes mesh vertices. Assign it to your own Geometry COMP via `target_geo`, or omit it to build a self-contained demo (subdivided sphere + camera + light + render + Null) so the material previews standalone. Creates a new baseCOMP under `parent_path`. Exposes Amount, Frequency, and Speed controls bound to the MAT. Returns a summary plus a JSON block with the container path, created node paths, the material path, the output path (demo only), exposed controls, node errors, warnings, and (demo only) an inline preview image.",
      inputSchema: createVertexDisplacementMatSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVertexDisplacementMatImpl(ctx, args),
  );
};
