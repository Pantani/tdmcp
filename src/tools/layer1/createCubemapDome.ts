import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const RESOLUTIONS = {
  "1024": 1024,
  "2048": 2048,
  "4096": 4096,
} as const;

export const createCubemapDomeSchema = z.object({
  projection: z
    .enum(["fisheye", "equirectangular"])
    .default("fisheye")
    .describe(
      "fisheye: sample the cube map into a centred dome disc (planetarium fulldome master). equirectangular: sweep the cube map into a full 360°×180° latlong image.",
    ),
  fov: z.coerce
    .number()
    .min(1)
    .max(360)
    .default(180)
    .describe(
      "Fisheye coverage in degrees (the angular diameter the disc spans). 180 = full hemisphere (standard fulldome); larger over-fills, smaller zooms in. Exposed as a live Fov knob; ignored for equirectangular.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Optional path to an existing TOP delivering a cube-map texture (e.g. a Render TOP in cube-map mode) to remap. When omitted, a simple test scene (sphere on a grid + camera + light) is rendered by a Render TOP in cube-map mode so the tool is self-contained.",
    ),
  resolution: z
    .enum(["1024", "2048", "4096"])
    .default("2048")
    .describe("Square dome-master resolution (width = height)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live Fov knob (and a Rotation knob that spins the dome horizon)."),
  name: z.string().default("cubemap_dome").describe("Base name for the system container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the dome container is created (default '/project1')."),
});
type CreateCubemapDomeArgs = z.infer<typeof createCubemapDomeSchema>;

/**
 * A GLSL fragment shader that samples a **cube map** input (TD's built-in
 * `samplerCube sTDCubeInputs[0]`, populated by the cube-map source wired into input 0) by 3D
 * direction to produce a dome master. Unlike create_dome_output (which warps a flat
 * equirectangular 2D source), this reads a real cube map, so there is no equirect pole-pinch or
 * seam. `uRotation` (degrees, converted with `radians()` in the shader) spins the azimuth; `uFov`
 * (degrees) sets the fisheye coverage live.
 *
 * - "fisheye": the output disc (centred vUV, radius 1 at the edge) maps radius → polar angle θ
 *   (via `uFov`) and disc angle → azimuth φ (+ `uRotation`); the spherical direction samples the
 *   cube map. Pixels outside the unit disc are black.
 * - "equirectangular": vUV.s → longitude (+ `uRotation`), vUV.t → latitude; that direction samples
 *   the cube map, giving a full 360°×180° latlong sweep.
 */
function remapShader(projection: "fisheye" | "equirectangular"): string {
  const PI = "3.14159265359";
  const TWO_PI = "6.28318530718";
  if (projection === "fisheye") {
    return [
      "uniform float uRotation;",
      "uniform float uFov;",
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
      `    float theta = r * radians(uFov) * 0.5;`,
      "    float phi = atan(p.y, p.x) + radians(uRotation);",
      "    // Spherical direction, then sample the cube map by that direction.",
      "    vec3 dir = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));",
      "    fragColor = TDOutputSwizzle(texture(sTDCubeInputs[0], dir));",
      "}",
    ].join("\n");
  }
  // Equirectangular: vUV → longitude/latitude → direction → cube-map sample.
  return [
    "uniform float uRotation;",
    "out vec4 fragColor;",
    "void main() {",
    `    float lon = vUV.s * ${TWO_PI} - ${PI} + radians(uRotation);`,
    `    float lat = (vUV.t - 0.5) * ${PI};`,
    "    vec3 dir = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));",
    "    fragColor = TDOutputSwizzle(texture(sTDCubeInputs[0], dir));",
    "}",
  ].join("\n");
}

export async function createCubemapDomeImpl(ctx: ToolContext, args: CreateCubemapDomeArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const res = RESOLUTIONS[args.resolution];

    // The cube-map source the GLSL TOP samples: either an existing one pulled in through a
    // Select TOP (works across COMP boundaries), or a freshly rendered test scene captured as a
    // cube map by a Render TOP in cube-map mode.
    let cubeSource: string;
    if (args.source) {
      cubeSource = await builder.add("selectTOP", "src", { top: args.source });
    } else {
      // Test scene: a sphere standing in front of a ground grid, lit, captured from the cube origin.
      // The camera sits at the origin, so the scene geometry must surround it at a distance — a
      // sphere at the origin would just fill the view from the inside. The sphere is pushed out
      // along +X and the grid is laid flat below the camera as a floor.
      const geo = await builder.add("geometryCOMP", "geo");
      const shape = await builder.add("sphereSOP", "shape", { tx: 3 }, geo);
      await builder.python(`_s = op(${q(shape)})\n_s.render = True\n_s.display = True`);
      // Grid floor: orient it to the ZX plane (horizontal) and drop it below the cube origin.
      const floor = await builder.add(
        "gridSOP",
        "floor",
        { sizex: 20, sizey: 20, orient: "zx", ty: -2 },
        geo,
      );
      await builder.python(`_f = op(${q(floor)})\n_f.render = True\n_f.display = True`);

      // Camera sits at the cube origin (the cube map captures all six directions around it).
      const cam = await builder.add("cameraCOMP", "cam", { tz: 0 });
      const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 3, tz: 5 });
      // A Render TOP in "cubemap" render mode outputs a real cube-map texture directly (all six
      // faces in one render) — TD then exposes it to the GLSL TOP as samplerCube sTDCubeInputs[0].
      // A separate Cube Map TOP is NOT needed: its assembly modes (onepersidetocubemap, …) expect
      // six pre-rendered face inputs, so feeding it one render errors ("Not enough sources").
      const render = await builder.add("renderTOP", "render", {
        camera: cam,
        geometry: geo,
        lights: light,
        rendermode: "cubemap",
      });
      cubeSource = render;
    }

    // Remap shader → Text DAT → GLSL TOP (square dome master), with the cube source on input 0.
    const frag = await builder.add("textDAT", "remap_frag");
    const remap = await builder.add("glslTOP", "remap", {
      outputresolution: "custom",
      resolutionw: res,
      resolutionh: res,
    });
    await builder.connect(cubeSource, remap);
    const shader = remapShader(args.projection);
    await builder.python(
      `op(${q(frag)}).text = ${q(shader)}\nop(${q(remap)}).par.pixeldat = op(${q(frag)}).name`,
    );

    // ALWAYS bind the uRotation (+ uFov for fisheye) uniforms on the GLSL TOP's "Vectors" page —
    // not just when controls are exposed. Otherwise TD leaves the uniform values at 0, so an
    // unexposed fisheye renders with uFov=0 and the dome collapses to black. uRotation = block 0,
    // uFov = block 1. The values seed the constant defaults here (rotation 0, fov args.fov); when
    // controls are exposed the Fov/Rotation knobs then drive vec0valuex/vec1valuex live via their
    // ControlSpec bind_to. Only the custom-par CONTROLS are conditional, never the uniform binding.
    {
      const blocks = args.projection === "fisheye" ? 2 : 1;
      const names = [
        `op(${q(remap)}).par.vec0name = "uRotation"`,
        `op(${q(remap)}).par.vec0valuex = 0`,
      ];
      if (args.projection === "fisheye") {
        names.push(`op(${q(remap)}).par.vec1name = "uFov"`);
        names.push(`op(${q(remap)}).par.vec1valuex = ${args.fov}`);
      }
      await builder.python(
        `_seq = op(${q(remap)}).seq.vec\n_seq.numBlocks = max(_seq.numBlocks, ${blocks})\n${names.join("\n")}`,
      );
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(remap, out);

    builder.warnings.push(
      "True cube-map dome: a Render TOP in cube-map mode feeds a real samplerCube into the GLSL remap. Verify the horizon is upright against your real dome (the Rotation knob spins the azimuth). Projection is a build-time choice (it swaps the whole shader); rebuild to switch fisheye ↔ equirectangular.",
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Rotation",
            label: "Rotation",
            type: "float",
            default: 0,
            min: -180,
            max: 180,
            bind_to: [`${remap}.vec0valuex`],
          },
          ...(args.projection === "fisheye"
            ? [
                {
                  name: "Fov",
                  label: "Fov",
                  type: "float" as const,
                  default: args.fov,
                  min: 1,
                  max: 360,
                  bind_to: [`${remap}.vec1valuex`],
                },
              ]
            : []),
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a true cube-map dome: ${
        args.source ? `remapped ${args.source}` : "rendered a test scene"
      } through a cube map into a ${args.projection} master at ${res}×${res}${
        args.projection === "fisheye" ? ` (fov ${args.fov}°)` : ""
      } → ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        projection: args.projection,
        fov: args.fov,
        source: args.source,
        resolution: args.resolution,
        cube_source: cubeSource,
        output_path: out,
      },
    });
  });
}

export const registerCreateCubemapDome: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_cubemap_dome",
    {
      title: "Create cube-map dome",
      description:
        "Render a true cube-map dome master — the higher-fidelity follow-up to create_dome_output (which only warps a flat equirectangular source). A 3D scene is rendered by a Render TOP in cube-map mode (rendermode 'cubemap', which outputs a real cube-map texture in one render — no separate Cube Map TOP), or an existing cube-map source is pulled in via a Select TOP; then a GLSL TOP samples that cube map by 3D direction (TD's built-in samplerCube sTDCubeInputs[0]) to produce a fisheye fulldome master or a full 360°×180° equirectangular image, ending on a Null ready for setup_output. Creates a new baseCOMP under `parent_path` (named by `name`) holding the cube-map source (or the test scene's Geometry/Camera/Light/Render TOP), GLSL remap, and Null output. Sampling a real cube map avoids the equirect pole-pinch/seam. With expose_controls, a live Fov knob sets fisheye coverage and a Rotation knob spins the dome horizon. Returns a summary plus a JSON block with the container path, created node paths, the cube-source/output paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createCubemapDomeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createCubemapDomeImpl(ctx, args),
  );
};
