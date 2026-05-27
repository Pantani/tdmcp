import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createDepthDisplacementSchema = z.object({
  source: z
    .enum(["camera", "file", "synthetic", "existing_top"])
    .default("synthetic")
    .describe(
      "Depth/luminance source that drives the relief. 'camera' = live webcam/capture device (creating it may pop a one-time macOS camera-permission dialog — click Allow). 'file' = a movie file. 'synthetic' = an animated noise pattern, so the relief moves and the chain is testable without any device permission (the default). 'existing_top' = displace by a TOP you already have (e.g. a real depth map).",
    ),
  movie_file_path: z.string().optional().describe("Movie file path (source='file')."),
  existing_top_path: z
    .string()
    .optional()
    .describe("Path of an existing TOP to sample as the height map (source='existing_top')."),
  subdivisions: z.coerce
    .number()
    .int()
    .min(2)
    .default(100)
    .describe(
      "Grid resolution (rows = cols). Higher = finer relief and smoother displacement, but more vertices to push. 100 gives a 100×100 plane.",
    ),
  depth: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe(
      "Displacement amount along Z: how far bright (or dark, if inverted) pixels push the surface out of the plane. 0 = flat.",
    ),
  invert: z
    .boolean()
    .default(false)
    .describe(
      "Flip the height mapping. false = bright pixels push toward the camera (bright = near); true = dark pixels push toward the camera (dark = near).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live Depth (displacement amount) and Zoom (camera distance) knobs."),
  parent_path: z.string().default("/project1"),
});
type CreateDepthDisplacementArgs = z.infer<typeof createDepthDisplacementSchema>;

/**
 * Builds the depth/luminance source TOP, mirroring create_motion_reactive's buildSource:
 * camera → Video Device In, file → Movie File In (playing), synthetic → an animated Noise
 * (a tz expression scrolls it so the relief breathes), existing_top → the given path.
 */
async function buildSource(
  builder: NetworkBuilder,
  args: CreateDepthDisplacementArgs,
): Promise<string> {
  if (args.source === "existing_top" && args.existing_top_path) {
    return args.existing_top_path;
  }
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "videoin", {
      ...(args.movie_file_path ? { file: args.movie_file_path } : {}),
      play: 1,
    });
  }
  if (args.source === "synthetic") {
    // A scrolling noise field: a moving height map so the relief animates and the chain is
    // verifiable without any camera permission.
    const noise = await builder.add("noiseTOP", "videoin");
    await builder.python(`op(${q(noise)}).par.tz.expr = "absTime.seconds * 0.5"`);
    return noise;
  }
  return builder.add("videodeviceinTOP", "videoin");
}

export async function createDepthDisplacementImpl(
  ctx: ToolContext,
  args: CreateDepthDisplacementArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "depth_displacement");
    const source = await buildSource(builder, args);

    // A monochrome version of the source is the height map: one luminance value per pixel,
    // sampled by the displacement material to offset each vertex along Z.
    const heightmap = await builder.add("monochromeTOP", "heightmap");
    await builder.connect(source, heightmap);

    // Geometry COMP (the builder clears its default torus) holding a subdivided grid. A finer
    // grid resolves finer relief. The grid SOP is flagged render + display so the COMP renders it.
    const geo = await builder.add("geometryCOMP", "geo");
    const surface = await builder.add(
      "gridSOP",
      "surface",
      { rows: args.subdivisions, cols: args.subdivisions },
      geo,
    );
    await builder.python(`_s = op(${q(surface)})\n_s.render = True\n_s.display = True`);

    // Displacement material: a GLSL MAT (`glslMAT`) whose vertex stage samples the height map TOP
    // and offsets P.z by (luminance × depth). This is the real-geometry path (a true 2.5D relief),
    // unlike a flat displace TOP. The grid is built on the XY plane, so we push along +Z.
    const mat = await builder.add("glslMAT", "displace");

    // Vertex shader: sample the height map at the grid's UVs and offset position along Z by
    // luminance × uDepth (real geometry displacement). TouchDesigner MAT conventions: deform the
    // point position through TDDeform/TDWorldToProj, no built-in uTime, explicit uniforms.
    // `uInvert` flips bright↔near; the sampler is `sHeight`; iLum carries the height to the pixel
    // stage so the relief is shaded by elevation.
    const vertexShader = [
      // A GLSL MAT does not auto-declare named samplers (unlike a GLSL TOP's sTD2DInputs) — the
      // `sampler0name` par binds the height map to this explicitly-declared uniform.
      "uniform sampler2D sHeight;",
      "uniform float uDepth;",
      "uniform float uInvert;",
      "out float iLum;",
      "void main() {",
      "\tfloat lum = texture(sHeight, uv[0].st).r;",
      "\tlum = mix(lum, 1.0 - lum, uInvert);",
      "\tiLum = lum;",
      "\tvec3 p = P;",
      "\tp.z += lum * uDepth;",
      "\tgl_Position = TDWorldToProj(TDDeform(vec4(p, 1.0)));",
      "}",
    ].join("\n");
    const vertDat = await builder.add("textDAT", "displace_vert");

    // Pixel shader: shade the surface by elevation (dark valleys → bright peaks) so the relief
    // reads even on a flat-lit scene. A GLSL MAT needs both a vertex and a pixel stage.
    const pixelShader = [
      "in float iLum;",
      "out vec4 fragColor;",
      "void main() {",
      "\tvec3 col = vec3(0.15 + 0.85 * iLum);",
      "\tfragColor = TDOutputSwizzle(vec4(col, 1.0));",
      "}",
    ].join("\n");
    const fragDat = await builder.add("textDAT", "displace_pixel");

    // Wire the GLSL MAT: vertex DAT (`vdat`), pixel DAT (`pdat`), sampler 0 → the height map TOP
    // named `sHeight` (`sampler0top` / `sampler0name`), and the uDepth/uInvert float uniforms via
    // the "Vectors" sequence (`vec0..`) — all par names verified live against a real GLSL MAT.
    await builder.python(
      [
        `op(${q(vertDat)}).text = ${q(vertexShader)}`,
        `op(${q(fragDat)}).text = ${q(pixelShader)}`,
        `_m = op(${q(mat)})`,
        `_m.par.vdat = op(${q(vertDat)}).name`,
        `_m.par.pdat = op(${q(fragDat)}).name`,
        `_m.par.sampler0top = ${q(heightmap)}`,
        '_m.par.sampler0name = "sHeight"',
        "_seq = _m.seq.vec",
        "_seq.numBlocks = max(_seq.numBlocks, 2)",
        '_m.par.vec0name = "uDepth"',
        `_m.par.vec0valuex = ${args.depth}`,
        '_m.par.vec1name = "uInvert"',
        `_m.par.vec1valuex = ${args.invert ? 1 : 0}`,
      ].join("\n"),
    );

    // Assign the material to the Geometry COMP (mirrors create_3d_scene / create_waveform).
    await builder.python(`op(${q(geo)}).par.material = ${q(mat)}`);

    // Camera pulled back and angled down so the relief reads as depth, not a flat plane. A light
    // for the render scene; the displaced surface catches it. Render TOP reads its scene from
    // PARAMETERS (camera/geometry/lights), not wires.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 4, ty: 2, rx: -28 });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Keep-alive: a still source (e.g. a paused movie or an existing static depth map) leaves the
    // height map cold, so the surface would never re-displace. A tiny Execute DAT force-cooks the
    // output each frame so the relief stays live even before anything is bound (mirrors
    // create_motion_reactive's cooker idiom).
    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('out1').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    // Depth knob binds to the GLSL MAT's uDepth uniform value (vec0valuex, verified live).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Depth",
            type: "float",
            min: 0,
            max: Math.max(4, args.depth * 3),
            default: args.depth,
            bind_to: [`${mat}.vec0valuex`],
          },
          { name: "Zoom", type: "float", min: 1, max: 20, default: 4, bind_to: [`${cam}.tz`] },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a depth-displacement relief (source: ${args.source}) — a ${args.subdivisions}×${args.subdivisions} grid pushed into 3D by a luminance/depth map via a GLSL MAT, rendered to ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source: args.source,
        subdivisions: args.subdivisions,
        depth: args.depth,
        invert: args.invert,
        output_path: out,
      },
    });
  });
}

export const registerCreateDepthDisplacement: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_depth_displacement",
    {
      title: "Create depth displacement",
      description:
        "Push a flat plane into real 3D relief by a depth/luminance map: a subdivided grid whose vertices are offset along Z by a GLSL displacement material sampling the source's brightness, rendered with a camera + light so it reads as depth that shifts with the view. Unlike create_depth_silhouette (a flat 2D mask), this is true geometry — a 2.5D landscape. Source can be the live camera (may prompt for macOS permission), a movie file, an animated synthetic pattern (testable without a camera), or an existing TOP (e.g. a real depth map). `subdivisions` sets the relief resolution, `depth` the push amount, `invert` flips bright↔near. Exposes Depth and Zoom knobs — bind Depth to a tempo ramp or an audio feature to make the surface heave.",
      inputSchema: createDepthDisplacementSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDepthDisplacementImpl(ctx, args),
  );
};
