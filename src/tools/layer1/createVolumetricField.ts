import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const COLOR_MAP_INDEX: Record<string, number> = {
  smoke: 0,
  nebula: 1,
  ember: 2,
  ice: 3,
  toxic: 4,
  mono: 5,
};

/**
 * Beer-Lambert accumulation GLSL shader for the viewer glslTOP.
 * Samples sTD2DInputs[0] (the cacheTOP output) N times with per-slice UV offsets,
 * accumulates transmittance front-to-back, then maps through one of 6 baked palettes.
 *
 * Loop uses `if (i >= N) break` pattern (GLSL spec compliance: no dynamic loop bound).
 * No built-in uTime — uniforms are provided explicitly via the vec sequence.
 */
const VIEWER_SHADER = `
uniform float uDensity;
uniform float uTurbulence;
uniform float uSliceCountF;
uniform float uColorMapF;

const vec3 PALETTE_LO[6] = vec3[6](
    vec3(0.05, 0.05, 0.07),
    vec3(0.02, 0.00, 0.10),
    vec3(0.08, 0.00, 0.00),
    vec3(0.85, 0.92, 1.00),
    vec3(0.00, 0.10, 0.05),
    vec3(0.00, 0.00, 0.00)
);
const vec3 PALETTE_HI[6] = vec3[6](
    vec3(0.85, 0.85, 0.90),
    vec3(0.95, 0.40, 0.95),
    vec3(1.00, 0.55, 0.10),
    vec3(0.20, 0.55, 0.95),
    vec3(0.55, 1.00, 0.20),
    vec3(1.00, 1.00, 1.00)
);

out vec4 fragColor;
void main() {
    vec2 uv = vUV.st;
    float acc = 0.0;
    float trans = 1.0;
    int N = clamp(int(uSliceCountF), 4, 32);
    int cm = clamp(int(uColorMapF), 0, 5);
    for (int i = 0; i < 32; ++i) {
        if (i >= N) break;
        float z = float(i) / float(N);
        vec2 off = vec2(cos(z * 6.2832), sin(z * 6.2832)) * 0.02 * uTurbulence;
        float s = texture(sTD2DInputs[0], uv + off + vec2(0.0, z * 0.05)).r;
        float a = 1.0 - exp(-uDensity * s * 2.5);
        acc  += a * trans * s;
        trans *= (1.0 - a);
        if (trans < 0.01) break;
    }
    vec3 col = mix(PALETTE_LO[cm], PALETTE_HI[cm], clamp(acc, 0.0, 1.0));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`.trimStart();

export const createVolumetricFieldSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the volumetric_field baseCOMP is created."),
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .default("volumetric_field")
    .describe("Container name (must start with a letter, alphanumeric + underscore)."),
  density: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "How opaque/milky the field reads (0 = transparent, 1 = fully opaque). Maps to uDensity in the viewer shader.",
    ),
  turbulence: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe(
      "Noise evolution speed and swirl amplitude. Drives the displacement weight and noise period. 0 = flat/still field; skips the displace TOP.",
    ),
  color_map: z
    .enum(["smoke", "nebula", "ember", "ice", "toxic", "mono"])
    .default("smoke")
    .describe(
      "Palette baked into the viewer GLSL shader: smoke (grey haze), nebula (purple/magenta), ember (orange/red), ice (blue/cyan), toxic (green), mono (black→white).",
    ),
  slice_count: z
    .number()
    .int()
    .min(4)
    .max(32)
    .default(16)
    .describe(
      "Number of 2D z-slices stacked into the pseudo-volume. Build-time only — changing it rewires the cache stack. Higher = smoother depth but heavier cook (linear cost). Default 16 is the safe sweet spot.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose Density, Turbulence and ColorMap knobs on the container."),
});

export async function createVolumetricFieldImpl(ctx: ToolContext, args: unknown) {
  const parsed = createVolumetricFieldSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const a = parsed.data;
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, a.parent_path, a.name);

    // Noise period: higher turbulence → shorter period (busier field)
    const period = (1 - a.turbulence) * 6 + 1;

    // Primary 3D noise source — Simplex 3D (type=4), monochrome, z-evolving
    const noise1 = await builder.add("noiseTOP", "noise1", {
      type: 4,
      monochrome: 1,
      period,
    });

    let noiseFeed: string = noise1;

    // Displacement pass — skipped when turbulence === 0 to keep cook minimal
    if (a.turbulence > 0) {
      const dispNoise = await builder.add("noiseTOP", "disp_noise", {
        type: 4,
        monochrome: 1,
        period: period * 0.5,
      });
      const disp1 = await builder.add("displaceTOP", "disp1", {
        displaceweightx: a.turbulence * 0.1,
        displaceweighty: a.turbulence * 0.1,
      });
      await builder.connect(noise1, disp1, 0, 0);
      await builder.connect(dispNoise, disp1, 0, 1);
      noiseFeed = disp1;
    }

    // Blur softens the slices for a haze feel
    const blur1 = await builder.add("blurTOP", "blur1", { size: 2 });
    await builder.connect(noiseFeed, blur1);

    // CacheTOP holds the last slice_count frames — these ARE the z-slices of the volume.
    // The central spec trick: cache history substitutes for a 3D texture allocation.
    const sliceStack = await builder.add("cacheTOP", "slice_stack", {
      cachesize: a.slice_count,
      active: 1,
    });
    await builder.connect(blur1, sliceStack);

    // Viewer GLSL — Beer-Lambert accumulation across slices, with baked palette
    const viewerFrag = await builder.add("textDAT", "viewer_frag");
    const colorMapIdx = COLOR_MAP_INDEX[a.color_map] ?? 0;
    const viewer = await builder.add("glslTOP", "viewer");

    // Set shader via Python (same pattern as createFeedbackNetwork)
    await builder.python(
      `op(${q(viewerFrag)}).text = ${q(VIEWER_SHADER)}\nop(${q(viewer)}).par.pixeldat = op(${q(viewerFrag)}).name`,
    );
    await builder.connect(sliceStack, viewer);

    // Set uniforms via the vec sequence on the glslTOP
    // vec0 = uDensity, vec1 = uTurbulence, vec2 = uSliceCountF, vec3 = uColorMapF
    await builder.python(
      [
        `_v = op(${q(viewer)})`,
        `_v.seq.vec.numBlocks = max(_v.seq.vec.numBlocks, 4)`,
        `_v.par.vec0name = "uDensity"`,
        `_v.par.vec0valuex = ${a.density}`,
        `_v.par.vec1name = "uTurbulence"`,
        `_v.par.vec1valuex = ${a.turbulence}`,
        `_v.par.vec2name = "uSliceCountF"`,
        `_v.par.vec2valuex = ${a.slice_count}`,
        `_v.par.vec3name = "uColorMapF"`,
        `_v.par.vec3valuex = ${colorMapIdx}`,
      ].join("\n"),
    );

    // Output null
    const out1 = await builder.add("nullTOP", "out1");
    await builder.connect(viewer, out1);

    // Expose live controls on the container
    const controls: ControlSpec[] = a.expose_controls
      ? [
          {
            name: "Density",
            type: "float",
            min: 0,
            max: 1,
            default: a.density,
            bind_to: [`${viewer}.vec0valuex`],
          },
          {
            name: "Turbulence",
            type: "float",
            min: 0,
            max: 1,
            default: a.turbulence,
            bind_to: [`${viewer}.vec1valuex`],
          },
          {
            name: "ColorMap",
            type: "menu",
            default: a.color_map,
            menu_items: ["smoke", "nebula", "ember", "ice", "toxic", "mono"],
            bind_to: [`${viewer}.vec3valuex`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a volumetric field (color_map: ${a.color_map}, slices: ${a.slice_count}, density: ${a.density}, turbulence: ${a.turbulence}).`,
      builder,
      outputPath: out1,
      controls,
      extra: {
        color_map: a.color_map,
        slice_count: a.slice_count,
        density: a.density,
        turbulence: a.turbulence,
      },
    });
  });
}

export const registerCreateVolumetricField: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_volumetric_field",
    {
      title: "Create volumetric field",
      description: [
        "Build a stacked-slice fake-volumetric noise field: smoke, nebula, ember, ice, toxic or mono palettes.",
        "Architecture: Simplex 3D noiseTOP → optional displace+blur → cacheTOP (depth = slice_count) →",
        "viewer glslTOP (Beer-Lambert accumulation across slices, baked palette) → nullTOP output.",
        "NOTE: this is a stacked-2D-slice approximation, NOT a raymarched volume. There is no per-pixel ray",
        "traversal or SDF. For a true raymarcher see the planned create_volumetric_raymarch (L-effort follow-up).",
        "Cook cost scales roughly linearly with slice_count × resolution. Default 16 slices is the safe sweet spot;",
        "drop to 4–8 on integrated GPUs.",
        "Returns a summary JSON with container path, created node paths, the output path, exposed controls,",
        "any node errors, warnings, and an inline preview image.",
      ].join(" "),
      inputSchema: createVolumetricFieldSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVolumetricFieldImpl(ctx, args),
  );
};
