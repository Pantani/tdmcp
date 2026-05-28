import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createPointCloudSchema = z.object({
  source: z
    .enum(["synthetic", "file", "camera", "existing"])
    .default("synthetic")
    .describe(
      "Texture whose brightness drives each point's depth (Z). 'synthetic' = an animated Noise pattern, so the cloud moves and the chain is testable without any device permission (the default). 'file' = a movie file. 'camera' = live webcam/capture device (creating it may pop a one-time macOS camera-permission dialog — click Allow). 'existing' = sample a TOP you already have (e.g. a real depth map).",
    ),
  file: z.string().optional().describe("Movie file path (source='file')."),
  existing: z
    .string()
    .optional()
    .describe("Path of an existing TOP to sample as the depth map (source='existing')."),
  resolution: z.coerce
    .number()
    .int()
    .min(8)
    .max(512)
    .default(128)
    .describe(
      "Grid side: the cloud is resolution×resolution points (count = resolution², e.g. 128 → 16 384). One point per texel of the position buffer. Capped at 512 (262 144 points) to stay GPU-sane.",
    ),
  depth_scale: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe(
      "How far bright pixels push each point along +Z. 0 = a flat sheet; higher = a deeper relief.",
    ),
  point_size: z.coerce
    .number()
    .positive()
    .default(0.02)
    .describe(
      "Radius of each dot (the source sphere SOP scale). TOP-instancing applies translate only, so per-point size lives on the sphere, not on instance scale.",
    ),
  rotate: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe("Whole-cloud spin around Y in degrees/sec (0 = still)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live DepthScale, PointSize, and Spin knobs on the system container."),
  parent_path: z.string().default("/project1"),
});
type CreatePointCloudArgs = z.infer<typeof createPointCloudSchema>;

/**
 * Builds the depth/luminance source TOP (mirrors create_depth_displacement's buildSource):
 * synthetic → an animated Noise (a tz expression scrolls it so the cloud breathes and the chain
 * is verifiable without a camera), file → Movie File In (playing), camera → Video Device In,
 * existing → a Select TOP INSIDE the container whose `top` par points at the external path
 * (TD rejects cross-container wires, so the external source must be pulled in through a Select TOP
 * before it can be connected into the chain — same trick create_layer_mixer uses for its sources).
 * Returns the source path, or undefined when an 'existing' path is missing (the caller falls back
 * to a synthetic noise so the build still cooks).
 */
async function buildSource(
  builder: NetworkBuilder,
  args: CreatePointCloudArgs,
): Promise<string | undefined> {
  if (args.source === "existing") {
    if (!args.existing) {
      return undefined;
    }
    // Pull the external TOP in through a Select TOP living inside the container; a direct
    // builder.connect(externalPath, …) would be rejected ("cannot wire across containers").
    return builder.add("selectTOP", "src", { top: args.existing });
  }
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "src", {
      ...(args.file ? { file: args.file } : {}),
      play: 1,
    });
  }
  if (args.source === "camera") {
    return builder.add("videodeviceinTOP", "src");
  }
  // synthetic: a scrolling noise field so the cloud animates with no device permission.
  const noise = await builder.add("noiseTOP", "src");
  await builder.python(`op(${q(noise)}).par.tz.expr = "absTime.seconds * 0.5"`);
  return noise;
}

/**
 * GLSL TOP fragment that packs each point's position into one RGBA32float texel:
 *   R = grid X (-1..1 across the buffer), G = grid Y (-1..1), B = luminance × uDepth (depth Z).
 * A single TOP then drives both the instance COUNT (its texel grid = resolution²) and the
 * per-instance translate (instancetx/ty/tz = r/g/b) — the validated create_gpu_particle_field
 * mapping. TouchDesigner GLSL TOP conventions: declare `out vec4 fragColor;`, sample
 * `sTD2DInputs[0]` (the heightmap), write via `TDOutputSwizzle(...)`, and there is NO built-in
 * uTime — uDepth is our own uniform.
 */
const POS_PACK_SHADER = `out vec4 fragColor;
uniform float uDepth;
void main(){
    vec2 uv = vUV.st;
    float lum = texture(sTD2DInputs[0], uv).r;
    float x = uv.x * 2.0 - 1.0;
    float y = uv.y * 2.0 - 1.0;
    float z = lum * uDepth;
    fragColor = TDOutputSwizzle(vec4(x, y, z, 1.0));
}
`;

export async function createPointCloudImpl(ctx: ToolContext, args: CreatePointCloudArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "point_cloud");
    const container = builder.containerPath;
    const source = (await buildSource(builder, args)) ?? (await builder.add("noiseTOP", "src"));

    // A monochrome version of the source is the depth map: one luminance value per pixel, sampled
    // by the position-pack shader to set each point's Z.
    const heightmap = await builder.add("monochromeTOP", "heightmap");
    await builder.connect(source, heightmap);

    // Position buffer: a custom resolution×resolution RGBA32float GLSL TOP whose texels encode each
    // point's XYZ (grid X/Y in R/G, depth Z in B). Its texel grid sets the instance count.
    const posPack = await builder.add("glslTOP", "pos_pack", {
      outputresolution: "custom",
      resolutionw: args.resolution,
      resolutionh: args.resolution,
      format: "rgba32float",
    });
    const posFrag = await builder.add("textDAT", "pos_frag");
    await builder.python(
      `op(${q(posFrag)}).text = ${q(POS_PACK_SHADER)}\nop(${q(posPack)}).par.pixeldat = op(${q(posFrag)}).name`,
    );
    await builder.connect(heightmap, posPack, 0, 0);

    // uDepth uniform on the GLSL TOP's "Vectors" sequence (the same path
    // orchestration.groupUniforms uses): name block 0 "uDepth", value = depth_scale.
    await builder.python(
      [
        `_p = op(${q(posPack)})`,
        "_seq = _p.seq.vec",
        "_seq.numBlocks = max(_seq.numBlocks, 1)",
        '_p.par.vec0name = "uDepth"',
        `_p.par.vec0valuex = ${args.depth_scale}`,
      ].join("\n"),
    );

    // A Geometry COMP renders a tiny dot once per texel, instanced from the position TOP: each
    // texel's RGB becomes that instance's XYZ translate. The builder clears the COMP's default
    // torus on creation. Dot size lives on the sphere SOP radius — TOP-instancing applies translate
    // but NOT scale, so a unit sphere would render full-size and the cloud would collapse into a
    // solid mass (validated live in create_gpu_particle_field).
    const geo = await builder.add("geometryCOMP", "geo");
    const dot = await builder.add(
      "sphereSOP",
      "dot",
      { radx: args.point_size, rady: args.point_size, radz: args.point_size },
      geo,
    );
    await builder.python(`_s = op(${q(dot)})\n_s.render = True\n_s.display = True`);

    // TOP instancing (validated live): instanceop = the position TOP sets the instance COUNT from
    // its texel grid (resolution² instances); instancetop names the TOP the per-instance translate
    // reads from; instancetx/ty/tz select its R/G/B channels for X/Y/Z. Scale is NOT set here.
    await builder.setParams(geo, {
      instancing: 1,
      instanceop: posPack,
      instancetop: posPack,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    });

    // A single near-white material so the dots read against the dark background.
    const mat = await builder.add("constantMAT", "mat");
    await builder.setParams(geo, { material: mat });

    // Whole-cloud spin around Y, MODULATED by the Spin control. ry is an expression reading the
    // container's Spin custom par as degrees/sec (absTime.seconds × Spin) so turning the knob
    // changes the spin rate live — rather than binding Spin directly onto ry, which would replace
    // this time expression with a static value and freeze the cloud. The `hasattr` fallback keeps
    // it cooking before exposeControls appends Spin (and when controls are off). Always emitted so
    // the exposed Spin knob actually drives motion.
    const spinExpr = `absTime.seconds * (op(${q(container)}).par.Spin.eval() if hasattr(op(${q(container)}).par, 'Spin') else ${args.rotate})`;
    await builder.python(`op(${q(geo)}).par.ry.expr = ${q(spinExpr)}`);

    const camDist = 3;
    const cam = await builder.add("cameraCOMP", "cam", { tz: camDist });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 4 });
    // Opaque near-black background so the bright dots are visible (same convention as
    // create_gpu_particle_field). The Render TOP reads its scene from parameters, not wires.
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      bgcolorr: 0.02,
      bgcolorg: 0.02,
      bgcolorb: 0.05,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Keep-alive: a still source (a paused movie or a static existing depth map) leaves pos_pack
    // cold, so the cloud would freeze. A tiny Execute DAT force-cooks the output each frame so the
    // depth stays live even before anything is bound (mirrors create_depth_displacement's cooker).
    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('out1').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            // Drives the position shader's uDepth uniform (vec0valuex) — bigger = deeper relief.
            name: "DepthScale",
            type: "float",
            min: 0,
            max: Math.max(4, args.depth_scale * 3),
            default: args.depth_scale,
            bind_to: [`${posPack}.vec0valuex`],
          },
          {
            // Resizes every point by driving the dot SOP's radius (TOP instancing does not apply
            // per-instance scale, so size lives on the source sphere).
            name: "PointSize",
            type: "float",
            min: 0.001,
            max: 0.5,
            default: args.point_size,
            bind_to: [`${dot}.radx`, `${dot}.rady`, `${dot}.radz`],
          },
          {
            // Spin (deg/sec) is read by geo.ry's absTime expression above, so it MODULATES the
            // spin rate. No bind_to: a direct bind would overwrite ry's time expression with a
            // constant and stop the rotation.
            name: "Spin",
            type: "float",
            min: 0,
            max: 720,
            default: args.rotate,
          },
        ]
      : [];

    const count = args.resolution * args.resolution;
    return finalize(ctx, {
      summary: `Built a point cloud (source: ${args.source}) — ${args.resolution}×${args.resolution} = ${count} points whose XYZ comes from the depth/luminance map (grid X/Y + Z = brightness × ${args.depth_scale}) via TOP-instancing, rendered to ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source: args.source,
        resolution: args.resolution,
        count,
        depth_scale: args.depth_scale,
        rotate: args.rotate,
        output_path: out,
      },
    });
  });
}

export const registerCreatePointCloud: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_point_cloud",
    {
      title: "Create point cloud",
      description:
        "Render a point cloud from a depth/luminance map (or a synthetic source): scatter a resolution×resolution grid of points and push each point's XYZ from the texture — X/Y from its grid position, Z from the map's brightness × `depth_scale`. Unlike create_depth_displacement (a continuous shaded mesh), this is a cloud of discrete dots. A GLSL TOP packs each point's position into one RGBA32float buffer, then a Geometry COMP TOP-instances a tiny sphere once per texel (reaching resolution², up to 512²≈262k points). Source can be an animated synthetic pattern (testable without any device, the default), a movie file, the live camera (may prompt for macOS permission), or an existing TOP (e.g. a real depth map). Exposes DepthScale, PointSize, and Spin knobs — bind DepthScale to a tempo ramp or an audio feature to make the cloud heave.",
      inputSchema: createPointCloudSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPointCloudImpl(ctx, args),
  );
};
