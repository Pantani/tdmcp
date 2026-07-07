import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Dedicated heightmap-terrain generator. A Noise TOP produces an animated luminance
 * height field; a subdivided Grid SOP is displaced along +Z in a GLSL MAT vertex stage
 * (real 2.5D geometry, elevation-shaded from a low/high colour ramp), lit by a key Light,
 * framed by a raised, angled Camera, and rendered. Optionally a flat translucent water
 * plane sits at a set elevation, and a distance-fade "fog" blend eases the far terrain
 * into the background colour in the pixel stage.
 *
 * Distinct from create_visual_system's "terrain" keyword (which only maps to the
 * noise_landscape recipe): this is a fully parameterized landscape pipeline with its own
 * displacement material, water, and fog controls.
 */

const rgb = z.coerce.number().min(0).max(1);

export const createTerrainSchema = z.object({
  subdivisions: z.coerce
    .number()
    .int()
    .min(4)
    .max(400)
    .default(160)
    .describe(
      "Grid resolution (rows = cols). Higher = finer relief and smoother displacement, but more vertices to push. 160 gives a 160×160 plane.",
    ),
  height: z.coerce
    .number()
    .min(0)
    .default(0.6)
    .describe("Displacement amount along Z: how far bright pixels push the surface up. 0 = flat."),
  noise_period: z.coerce
    .number()
    .positive()
    .default(2.4)
    .describe("Noise TOP period — larger = broader, smoother hills; smaller = tighter, rockier."),
  drift: z.coerce
    .number()
    .min(0)
    .default(0.15)
    .describe(
      "Scroll speed of the noise height field along Z per second so the landscape slowly evolves. 0 = static terrain. Reads 0 when the TD timeline is paused.",
    ),
  low_color: z
    .tuple([rgb, rgb, rgb])
    .default([0.06, 0.12, 0.05])
    .describe("Colour of the valleys / lowest elevation (RGB 0..1)."),
  high_color: z
    .tuple([rgb, rgb, rgb])
    .default([0.85, 0.82, 0.7])
    .describe("Colour of the peaks / highest elevation (RGB 0..1)."),
  water: z
    .boolean()
    .default(true)
    .describe("Add a flat translucent water plane at `water_level` cutting through the terrain."),
  water_level: z.coerce
    .number()
    .default(0.12)
    .describe("Z elevation of the water plane, in the same units as `height`."),
  water_color: z
    .tuple([rgb, rgb, rgb])
    .default([0.05, 0.22, 0.35])
    .describe("Water plane colour (RGB 0..1). Rendered semi-transparent."),
  fog: z
    .boolean()
    .default(true)
    .describe("Fade the far terrain into `background` by camera distance (volumetric-ish haze)."),
  background: z
    .tuple([rgb, rgb, rgb])
    .default([0.5, 0.6, 0.72])
    .describe("Sky / background + fog colour (RGB 0..1)."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true (default), expose live Height / Drift / WaterLevel / Zoom controls."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the terrain container is created (default '/project1')."),
});
type CreateTerrainArgs = z.infer<typeof createTerrainSchema>;

export async function createTerrainImpl(ctx: ToolContext, args: CreateTerrainArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "terrain");
    const [lr, lg, lb] = args.low_color;
    const [hr, hg, hb] = args.high_color;
    const [wr, wg, wb] = args.water_color;
    const [bgr, bgg, bgb] = args.background;

    // ── Height field ──────────────────────────────────────────────────────────
    // A monochrome Noise TOP is the height map: one luminance value per pixel, sampled
    // by the displacement material to offset each grid vertex along Z. `drift` scrolls it
    // (via a tz expression) so the landscape slowly evolves; it reads 0 when paused.
    const noise = await builder.add("noiseTOP", "heightmap", {
      period: args.noise_period,
      mono: 1,
      resolutionw: 512,
      resolutionh: 512,
    });
    await builder.python(
      `op(${q(noise)}).par.tz.expr = "absTime.seconds * (parent().par.Drift.eval() if hasattr(parent().par, 'Drift') else ${args.drift})"`,
    );

    // ── Terrain surface (real geometry) ───────────────────────────────────────
    // Geometry COMP (builder clears its default torus) holding a subdivided grid, flagged
    // render + display so the COMP renders it. Grid is on the XY plane; we push along +Z.
    const geo = await builder.add("geometryCOMP", "geo");
    const surface = await builder.add(
      "gridSOP",
      "surface",
      { rows: args.subdivisions, cols: args.subdivisions, sizex: 4, sizey: 4 },
      geo,
    );
    await builder.python(`_s = op(${q(surface)})\n_s.render = True\n_s.display = True`);

    // GLSL displacement MAT — vertex stage samples the height map and offsets P.z by
    // luminance × uHeight (real vertex displacement, not a TOP-space warp); pixel stage
    // shades by elevation between uLow/uHigh and, when uFog>0, mixes toward uBackground
    // by camera distance for a haze. MAT conventions: TDDeform/TDWorldToProj, explicit
    // uniforms, sampler bound by name (a GLSL MAT does not auto-declare samplers).
    const mat = await builder.add("glslMAT", "displace");
    const vertexShader = [
      "uniform sampler2D sHeight;",
      "uniform float uHeight;",
      "out float iElev;",
      "out float iDist;",
      "void main() {",
      "\tfloat lum = texture(sHeight, uv[0].st).r;",
      "\tiElev = lum;",
      "\tvec3 p = P;",
      "\tp.z += lum * uHeight;",
      "\tvec4 world = TDDeform(vec4(p, 1.0));",
      "\tvec4 cam = uTDMat.cam * world;",
      "\tiDist = length(cam.xyz);",
      "\tgl_Position = TDWorldToProj(world);",
      "}",
    ].join("\n");
    const vertDat = await builder.add("textDAT", "displace_vert");

    const pixelShader = [
      "in float iElev;",
      "in float iDist;",
      "uniform vec3 uLow;",
      "uniform vec3 uHigh;",
      "uniform vec3 uBackground;",
      "uniform float uFog;",
      "void main() {",
      "\tvec3 col = mix(uLow, uHigh, clamp(iElev, 0.0, 1.0));",
      "\tif (uFog > 0.5) {",
      "\t\tfloat f = clamp((iDist - 3.0) / 6.0, 0.0, 1.0);",
      "\t\tcol = mix(col, uBackground, f);",
      "\t}",
      "\tfragColor = TDOutputSwizzle(vec4(col, 1.0));",
      "}",
    ].join("\n");
    const fragDat = await builder.add("textDAT", "displace_pixel");

    await builder.python(
      [
        `op(${q(vertDat)}).text = ${q(vertexShader)}`,
        `op(${q(fragDat)}).text = ${q(pixelShader)}`,
        `_m = op(${q(mat)})`,
        `_m.par.vdat = op(${q(vertDat)}).name`,
        `_m.par.pdat = op(${q(fragDat)}).name`,
        `_m.par.sampler0top = ${q(noise)}`,
        '_m.par.sampler0name = "sHeight"',
        // All uniforms (scalars AND vec3 colours) bind through the "Vectors" page: a
        // block's valuex/y/z/w carry up to a vec4 (live-verified against a real glslMAT —
        // the "Constants" page holds a single scalar `const<i>value`, not per-component
        // colour sub-parameters).
        "_seq = _m.seq.vec",
        "_seq.numBlocks = max(_seq.numBlocks, 5)",
        '_m.par.vec0name = "uHeight"',
        `_m.par.vec0valuex = ${args.height}`,
        '_m.par.vec1name = "uFog"',
        `_m.par.vec1valuex = ${args.fog ? 1 : 0}`,
        '_m.par.vec2name = "uLow"',
        `_m.par.vec2valuex = ${lr}`,
        `_m.par.vec2valuey = ${lg}`,
        `_m.par.vec2valuez = ${lb}`,
        '_m.par.vec3name = "uHigh"',
        `_m.par.vec3valuex = ${hr}`,
        `_m.par.vec3valuey = ${hg}`,
        `_m.par.vec3valuez = ${hb}`,
        '_m.par.vec4name = "uBackground"',
        `_m.par.vec4valuex = ${bgr}`,
        `_m.par.vec4valuey = ${bgg}`,
        `_m.par.vec4valuez = ${bgb}`,
      ].join("\n"),
    );
    await builder.python(`op(${q(geo)}).par.material = ${q(mat)}`);

    // ── Optional water plane ──────────────────────────────────────────────────
    let waterGeo: string | undefined;
    if (args.water) {
      waterGeo = await builder.add("geometryCOMP", "water_geo");
      const waterGrid = await builder.add(
        "gridSOP",
        "water_grid",
        { rows: 2, cols: 2, sizex: 4, sizey: 4 },
        waterGeo,
      );
      await builder.python(`_s = op(${q(waterGrid)})\n_s.render = True\n_s.display = True`);
      // Raise the water plane to water_level along Z (grid is on XY, terrain pushes +Z).
      await builder.python(`op(${q(waterGeo)}).par.tz = ${args.water_level}`);
      const waterMat = await builder.add("constantMAT", "water_mat", {
        colorr: wr,
        colorg: wg,
        colorb: wb,
        alpha: 0.55,
      });
      // Enable alpha blending so the translucent water shows the terrain beneath it.
      await builder.python(
        `try:\n    op(${q(waterMat)}).par.blending = 1\nexcept Exception:\n    pass`,
      );
      await builder.python(`op(${q(waterGeo)}).par.material = ${q(waterMat)}`);
    }

    // ── Camera / light / render ───────────────────────────────────────────────
    // Camera raised and angled down so the relief reads as landscape, not a flat plane.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 5, ty: 2.4, rx: -32 });
    const light = await builder.add("lightCOMP", "light", { tx: 4, ty: 5, tz: 3 });
    const geometryList = waterGeo ? `${geo} ${waterGeo}` : geo;
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geometryList,
      lights: light,
      bgcolorr: bgr,
      bgcolorg: bgg,
      bgcolorb: bgb,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    builder.warnings.push(
      "All uniforms (uHeight/uFog scalars and uLow/uHigh/uBackground vec3 colours) bind through the live-verified Vectors page (vec<i>valuex/y/z). The vertex stage reads camera-space depth via TD's uTDMat.cam for the distance fog.",
    );

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Height",
            type: "float",
            min: 0,
            max: Math.max(3, args.height * 3),
            default: args.height,
            bind_to: [`${mat}.vec0valuex`],
          },
          { name: "Drift", type: "float", min: 0, max: 2, default: args.drift },
          {
            name: "WaterLevel",
            type: "float",
            min: -1,
            max: 2,
            default: args.water_level,
            bind_to: waterGeo ? [`${waterGeo}.tz`] : [],
          },
          { name: "Zoom", type: "float", min: 1, max: 20, default: 5, bind_to: [`${cam}.tz`] },
        ]
      : [];

    const waterNote = args.water ? `, water@${args.water_level}` : "";
    const fogNote = args.fog ? ", distance fog" : "";
    return finalize(ctx, {
      summary: `Built a heightmap terrain (${args.subdivisions}×${args.subdivisions} grid, height ${args.height}, noise period ${args.noise_period}${waterNote}${fogNote}) rendered to ${out} — Noise heightmap → GLSL vertex-displacement MAT → Camera + Light + Render TOP.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        subdivisions: args.subdivisions,
        height: args.height,
        noise_period: args.noise_period,
        drift: args.drift,
        water: args.water,
        water_level: args.water_level,
        fog: args.fog,
        heightmap: noise,
        material: mat,
        geometry: geo,
        water_geometry: waterGeo ?? null,
        render,
        output_path: out,
      },
    });
  });
}

export const registerCreateTerrain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_terrain",
    {
      title: "Create terrain",
      description:
        "Build a procedural heightmap landscape: an animated Noise TOP height field displaces a subdivided Grid SOP along Z in a GLSL vertex-displacement MAT (real 2.5D geometry, elevation-shaded from a low→high colour ramp), lit by a key Light, framed by a raised angled Camera, and rendered. Optionally adds a flat translucent water plane at `water_level` and a camera-distance fog fade into the sky/background colour. Distinct from create_visual_system's 'terrain' keyword (which only maps to a noise_landscape recipe) — this is a dedicated, fully parameterized terrain pipeline with its own displacement material, water, and fog. Creates a new baseCOMP under `parent_path`. Exposes Height, Drift, WaterLevel, and Zoom controls. Returns a summary plus a JSON block with the container path, created node paths, output path, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: createTerrainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTerrainImpl(ctx, args),
  );
};
