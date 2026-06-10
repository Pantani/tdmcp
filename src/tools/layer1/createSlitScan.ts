import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Slit-scan GLSL shader: samples cacheTOP's frame ring as a 2D-array texture.
 * Each row (axis=y) or column (axis=x) samples a different past frame, producing
 * the classic "time-as-space" stretched-time look.
 *
 * NOTE (probe-first risk): cacheTOP must expose its ring buffer via sTD2DArrayInputs.
 * If the installed TD build doesn't support the array path, QA should switch to
 * a cacheselect-per-slice fallback (see spec). GLSL compile is UNVERIFIED offline.
 */
const SLIT_SHADER = `uniform float uDepth;
uniform float uAxis;
uniform float uDir;
out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float t = (uAxis > 0.5 ? uv.y : uv.x);
    if (uDir < 0.0) t = 1.0 - t;
    int idx = int(clamp(t * (uDepth - 1.0), 0.0, uDepth - 1.0));
    fragColor = TDOutputSwizzle(texelFetch(sTD2DArrayInputs[0], ivec3(ivec2(gl_FragCoord.xy), idx), 0));
}
`;

export const createSlitScanSchema = z
  .object({
    parent_path: z
      .string()
      .default("/project1")
      .describe("Parent network where the slit-scan container is created (default '/project1')."),
    name: z
      .string()
      .default("slit_scan")
      .describe("Container name for the slit-scan system (default 'slit_scan')."),
    source_top_path: z
      .string()
      .optional()
      .describe(
        "Optional path to an existing TOP to scan (e.g. '/project1/videodevicein1'). When omitted a synthetic noiseTOP seed is created inside the container so the tool runs headless / on CI without camera permission.",
      ),
    cache_depth: z.coerce
      .number()
      .int()
      .min(1)
      .max(600)
      .default(60)
      .describe(
        "Number of frames stored in the Cache TOP ring buffer (1–600, default 60). Memory cost: ~depth × W × H × 16 B at RGBA16. At 1080p, 600 frames ≈ 5 GB VRAM.",
      ),
    axis: z
      .enum(["x", "y"])
      .default("y")
      .describe(
        "Screen axis that carries time. 'y' = each row is a different past frame; 'x' = each column (default 'y').",
      ),
    direction: z
      .enum(["+y", "-y", "+x", "-x"])
      .default("+y")
      .describe(
        "Which end of the axis is 'now'. '+y' = bottom row is the latest frame, top is oldest; '-y' reverses it. Must be compatible with axis (default '+y').",
      ),
    expose_controls: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), expose a live 'Depth' knob on the container bound to cache.cachesize.",
      ),
  })
  .refine(
    (v) => {
      if (v.direction === "+x" || v.direction === "-x") return v.axis === "x";
      if (v.direction === "+y" || v.direction === "-y") return v.axis === "y";
      return true;
    },
    { message: "direction must match axis (use '+y'/'-y' with axis='y', '+x'/'-x' with axis='x')" },
  );

type CreateSlitScanArgs = z.infer<typeof createSlitScanSchema>;

export async function createSlitScanImpl(ctx: ToolContext, args: CreateSlitScanArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // Source: synthetic noiseTOP or external TOP via selectTOP
    let sourcePath: string;
    if (args.source_top_path) {
      // Route external TOP through a selectTOP — no cross-container wires.
      const sel = await builder.add("selectTOP", "source");
      await builder.setParams(sel, { top: args.source_top_path });
      sourcePath = sel;
    } else {
      // Synthetic seed: animated monochrome noise, runs headless/CI.
      sourcePath = await builder.add("noiseTOP", "source", { monochrome: 0, period: 4 });
    }

    // Cache TOP: ring buffer. Active=1, Record=1 (auto-records every cook frame).
    // output param set to "all" so the ring is exposed as a 2D-array texture to GLSL.
    const cache = await builder.add("cacheTOP", "cache", {
      cachesize: args.cache_depth,
      active: 1,
      record: 1,
    });
    await builder.connect(sourcePath, cache);

    // textDAT holds the slit shader
    const fragDat = await builder.add("textDAT", "slit_frag");

    // glslTOP reads the cache ring via sTD2DArrayInputs[0]
    const axisInt = args.axis === "y" ? 1 : 0;
    const dirInt = args.direction.startsWith("-") ? -1 : 1;

    const glsl = await builder.add("glslTOP", "slit_glsl");
    await builder.connect(cache, glsl, 0, 0);

    // Wire shader text and pixeldat via Python (same pattern as createFeedbackNetwork)
    await builder.python(
      `op(${q(fragDat)}).text = ${q(SLIT_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(fragDat)}).name`,
    );

    // Set uniforms on the glslTOP via vec sequence (float uniforms → vec page)
    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
        `_g.par.vec0name = 'uDepth'`,
        `_g.par.vec0valuex = ${args.cache_depth}`,
        `_g.par.vec1name = 'uAxis'`,
        `_g.par.vec1valuex = ${axisInt}`,
        `_g.par.vec2name = 'uDir'`,
        `_g.par.vec2valuex = ${dirInt}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    const sourceLabel = args.source_top_path ? `external: ${args.source_top_path}` : "synthetic";

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Depth",
            type: "float",
            min: 1,
            max: 600,
            default: args.cache_depth,
            bind_to: [`${cache}.cachesize`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a slit-scan (axis: ${args.axis}, depth: ${args.cache_depth}, source: ${sourceLabel}). GLSL compile UNVERIFIED offline — cacheTOP array binding must be validated live.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        axis: args.axis,
        cache_depth: args.cache_depth,
        direction: args.direction,
        source_top_path: args.source_top_path ?? null,
      },
    });
  });
}

export const registerCreateSlitScan: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_slit_scan",
    {
      title: "Create slit-scan",
      description:
        "Build a slit-scan visual system: each row (or column) of the output samples a different past frame from a Cache TOP ring buffer, producing the classic 'time-as-space' stretched-time look (Floris Kaayk / Adam Magyar style). Creates a new baseCOMP under `parent_path` holding a source TOP, a Cache TOP ring buffer, a slit GLSL shader, and a Null output. When no `source_top_path` is given, a synthetic Noise TOP is used so the tool works headless / on CI without camera permission. Exposes a live 'Depth' knob. Note: GLSL compile is UNVERIFIED offline; cacheTOP 2D-array binding must be validated live in TouchDesigner. Memory cost at 1080p RGBA16 is ~depth × 32 MB; depth 600 ≈ 5 GB VRAM. Output freezes when the timeline is paused (cacheTOP stops recording — expected behaviour). Returns a summary plus a JSON block with the container path, created node paths, output path, exposed controls, warnings, and an inline preview image.",
      inputSchema: createSlitScanSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSlitScanImpl(ctx, args),
  );
};
