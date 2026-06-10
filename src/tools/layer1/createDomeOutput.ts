import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const RESOLUTIONS = {
  "1024": 1024,
  "2048": 2048,
  "4096": 4096,
} as const;

export const createDomeOutputSchema = z.object({
  source_path: z
    .string()
    .describe(
      "The master TOP to remap, treated as an equirectangular / panoramic source (the full 360°×180° latlong image the dome warps from).",
    ),
  projection: z
    .enum(["fisheye", "equirectangular"])
    .default("fisheye")
    .describe(
      "fisheye: warp the equirectangular source into a centred dome disc (planetarium fulldome master). equirectangular: near-passthrough identity remap, so an already-equirect source still yields a valid output.",
    ),
  resolution: z
    .enum(["1024", "2048", "4096"])
    .default("2048")
    .describe("Square dome-master resolution (width = height)."),
  fov: z.coerce
    .number()
    .min(1)
    .max(360)
    .default(180)
    .describe(
      "Fisheye coverage in degrees (the angular diameter the disc spans). 180 = full hemisphere (standard fulldome); larger over-fills, smaller zooms in. Used by the fisheye shader.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose a Rotation knob bound to the shader uniform that spins the dome horizon (degrees).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the dome-output container is created (default '/project1')."),
});
type CreateDomeOutputArgs = z.infer<typeof createDomeOutputSchema>;

/**
 * A GLSL fragment shader that remaps an equirectangular source TOP (sTD2DInputs[0]) into a
 * dome master. For "fisheye": the output disc (centred vUV) is read as a polar angle (radius →
 * polar angle θ via `fov`, vUV angle → azimuth φ), turned into a spherical direction, and that
 * direction samples the latlong source at `(φ/2π+0.5, θ/π+0.5)`; pixels outside the unit disc are
 * black. `uRotation` (a `uniform float`, radians) spins the azimuth so the dome horizon can turn.
 * For "equirectangular": a near-passthrough identity remap sampling sTD2DInputs[0] at vUV.st (with
 * the same `uRotation` horizontal wrap), so an already-equirect source still produces valid output.
 */
function remapShader(projection: "fisheye" | "equirectangular", fovDeg: number): string {
  const PI = "3.14159265359";
  const TWO_PI = "6.28318530718";
  if (projection === "fisheye") {
    // Half the fisheye coverage, in radians: the polar angle at the disc edge (radius 1).
    const halfFov = ((fovDeg * Math.PI) / 360).toFixed(6);
    return [
      "uniform float uRotation;",
      "out vec4 fragColor;",
      "void main() {",
      "    // Output disc: centre the UVs, radius 1 at the disc edge.",
      "    vec2 p = vUV.st * 2.0 - 1.0;",
      "    float r = length(p);",
      "    if (r > 1.0) {",
      "        fragColor = TDOutputSwizzle(vec4(0.0, 0.0, 0.0, 1.0));",
      "        return;",
      "    }",
      "    // Disc radius → polar angle (0 at zenith); disc angle → azimuth (+ rotation).",
      `    float theta = r * ${halfFov};`,
      "    float phi = atan(p.y, p.x) + uRotation;",
      "    // Spherical direction, then back to longitude/latitude for the latlong source.",
      "    vec3 dir = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));",
      "    float lon = atan(dir.z, dir.x);",
      "    float lat = asin(clamp(dir.y, -1.0, 1.0));",
      `    vec2 uv = vec2(lon / ${TWO_PI} + 0.5, lat / ${PI} + 0.5);`,
      "    fragColor = TDOutputSwizzle(texture(sTD2DInputs[0], uv));",
      "}",
    ].join("\n");
  }
  // Equirectangular: identity remap with a horizontal wrap driven by uRotation.
  return [
    "uniform float uRotation;",
    "out vec4 fragColor;",
    "void main() {",
    `    vec2 uv = vec2(fract(vUV.s + uRotation / ${TWO_PI}), vUV.t);`,
    "    fragColor = TDOutputSwizzle(texture(sTD2DInputs[0], uv));",
    "}",
  ].join("\n");
}

export async function createDomeOutputImpl(ctx: ToolContext, args: CreateDomeOutputArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "dome_output");
    const res = RESOLUTIONS[args.resolution];

    // Pull the master in through a Select TOP (works across COMP boundaries).
    const src = await builder.add("selectTOP", "src", { top: args.source_path });

    // Remap shader → Text DAT → GLSL TOP (square dome master).
    const frag = await builder.add("textDAT", "remap_frag");
    const remap = await builder.add("glslTOP", "remap", {
      outputresolution: "custom",
      resolutionw: res,
      resolutionh: res,
    });
    await builder.connect(src, remap);
    const shader = remapShader(args.projection, args.fov);
    await builder.python(
      `op(${q(frag)}).text = ${q(shader)}\nop(${q(remap)}).par.pixeldat = op(${q(frag)}).name`,
    );

    // Expose the uRotation uniform (a "Vectors" block) so the Rotation control can drive it.
    if (args.expose_controls) {
      await builder.python(
        `_seq = op(${q(remap)}).seq.vec\n_seq.numBlocks = max(_seq.numBlocks, 1)\nop(${q(remap)}).par.vec0name = "uRotation"`,
      );
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(remap, out);

    builder.warnings.push(
      "⚠ This GLSL-remaps an existing (ideally equirectangular) source into a dome master — the exact fisheye math + fov mapping needs live tuning against your real source and dome. For higher fidelity, a true cubemap render (Render TOP cube-map mode, or a 6-camera rig feeding the latlong source) is the recommended follow-up.",
    );

    const controls = args.expose_controls
      ? [
          {
            name: "Rotation",
            label: "Rotation",
            type: "float" as const,
            default: 0,
            min: -180,
            max: 180,
            bind_to: [`${remap}.vec0valuex`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Remapped ${args.source_path} to a ${args.projection} dome master at ${res}×${res} (fov ${args.fov}°) → ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source_path: args.source_path,
        projection: args.projection,
        resolution: args.resolution,
        fov: args.fov,
        output_path: out,
      },
    });
  });
}

export const registerCreateDomeOutput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_dome_output",
    {
      title: "Create dome output",
      description:
        "Remap a source TOP (treated as an equirectangular / panoramic master) into a square single-output dome master for planetarium fulldomes / 360 — the curved complement to create_multi_output's flat tiling. A Select TOP pulls the master in, a GLSL TOP warps it (fisheye: equirect → centred dome disc using `fov`; equirectangular: near-passthrough identity remap) via a shader held in a Text DAT, ending on a Null ready for setup_output. Creates a new baseCOMP under `parent_path` holding the Select TOP, GLSL remap, and Null output. With expose_controls a Rotation knob spins the dome horizon. Note: this GLSL-remaps an existing flat source — use create_cubemap_dome instead for a true cube-map render (higher fidelity, no equirect pole-pinch/seam). Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings (including the cubemap-follow-up note), and an inline preview image.",
      inputSchema: createDomeOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDomeOutputImpl(ctx, args),
  );
};
