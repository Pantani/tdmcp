import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Pixel-sort effect for TouchDesigner using a multi-pass odd-even transposition sort
 * implemented as a glslTOP + feedbackTOP + switchTOP chain.
 *
 * The shader compares each pixel with its neighbour along the chosen axis and swaps
 * when the sort key is out of order, gated by a luminance threshold mask. After N
 * iterations (via Feedback TOP) the buffer converges to the signature
 * Kim Asendorf–style horizontal/vertical streak aesthetic.
 *
 * GLSL gotchas honoured:
 *   - Declares `out vec4 fragColor;`, writes via TDOutputSwizzle().
 *   - No built-in uTime; uses absTime.frame expression for uPhase.
 *   - uTDOutputInfo.res.xy holds the texel size (1/width, 1/height).
 *   - sTD2DInputs[0] = feedback/switch output; sTD2DInputs[1] = original source for mask.
 */
const SORT_SHADER = `out vec4 fragColor;

uniform float uAxis;       // 0 = x (rows), 1 = y (cols)
uniform float uKey;        // 0 = luminance, 1 = hue, 2 = saturation
uniform float uDirection;  // 0 = ascending, 1 = descending
uniform float uThreshold;  // luminance gate [0..1]
uniform float uPhase;      // 0 or 1 — alternates per cook frame (odd/even pass)
uniform float uMix;

float lum(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

float hue(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float d = mx - mn;
    if (d <= 0.0) return 0.0;
    float h;
    if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    return h / 6.0;
}

float sat(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    return mx <= 0.0 ? 0.0 : (mx - mn) / mx;
}

float sortKey(vec3 c) {
    int k = int(uKey);
    if (k == 0) return lum(c);
    if (k == 1) return hue(c);
    return sat(c);
}

void main() {
    vec2 uv = vUV.st;
    vec2 px = uTDOutputInfo.res.xy;
    vec2 dir = (uAxis < 0.5) ? vec2(px.x, 0.0) : vec2(0.0, px.y);

    vec4 self = texture(sTD2DInputs[0], uv);
    float idx = (uAxis < 0.5) ? floor(uv.x / px.x) : floor(uv.y / px.y);
    float parity = mod(idx, 2.0);
    float lookForward = (parity == uPhase) ? 1.0 : -1.0;
    vec2 partnerUV = clamp(uv + dir * lookForward, vec2(0.0), vec2(1.0));
    vec4 partner = texture(sTD2DInputs[0], partnerUV);

    // Threshold mask using sTD2DInputs[1] (original source)
    vec4 origSelf    = texture(sTD2DInputs[1], uv);
    vec4 origPartner = texture(sTD2DInputs[1], partnerUV);
    float maskSelf    = step(uThreshold, lum(origSelf.rgb));
    float maskPartner = step(uThreshold, lum(origPartner.rgb));
    float canSwap = maskSelf * maskPartner;

    float ks = sortKey(self.rgb);
    float kp = sortKey(partner.rgb);
    bool doSwap;
    if (uDirection < 0.5) {
        // ascending: smaller index gets lower key
        doSwap = (lookForward > 0.0) ? (ks > kp) : (ks < kp);
    } else {
        // descending: smaller index gets higher key (bright first = Asendorf look)
        doSwap = (lookForward > 0.0) ? (ks < kp) : (ks > kp);
    }
    vec4 sorted = (canSwap > 0.5 && doSwap) ? partner : self;
    fragColor = TDOutputSwizzle(mix(self, sorted, uMix));
}
`;

export const createPixelSortSchema = z.object({
  name: z.string().default("pixel_sort").describe("Base name for the created baseCOMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path. The pixel-sort container is created inside this path."),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to an existing TOP (e.g. '/project1/movie1'). Pulled in via a Select TOP. " +
        "If omitted, a self-contained animated noiseTOP source is used (no device permissions).",
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Luminance gate [0..1]. Pixels with luminance >= threshold are sortable; " +
        "others are locked in place. Live-tweakable.",
    ),
  axis: z
    .enum(["x", "y"])
    .default("x")
    .describe("x = sort along rows (horizontal streaks), y = along columns (vertical streaks)."),
  sort_by: z
    .enum(["luminance", "hue", "saturation"])
    .default("luminance")
    .describe("Sort key: the channel the odd-even transposition sort compares on."),
  direction: z
    .enum(["ascending", "descending"])
    .default("descending")
    .describe(
      "descending puts bright/saturated pixels first — the canonical Asendorf look. Live-tweakable.",
    ),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(256)
    .default(64)
    .describe(
      "Number of odd-even sort passes to run via the Feedback TOP. " +
        "Higher = closer to fully sorted but heavier cook. Live-tweakable.",
    ),
  mix: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Blend between original (0) and sorted output (1). Live-tweakable."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
});
export type CreatePixelSortArgs = z.infer<typeof createPixelSortSchema>;

const AXIS_INT: Record<string, number> = { x: 0, y: 1 };
const KEY_INT: Record<string, number> = { luminance: 0, hue: 1, saturation: 2 };
const DIR_INT: Record<string, number> = { ascending: 0, descending: 1 };

async function buildSource(builder: NetworkBuilder, args: CreatePixelSortArgs): Promise<string> {
  if (args.source_top_path) {
    const sel = await builder.add("selectTOP", "source");
    await builder.setParams(sel, { top: args.source_top_path });
    return sel;
  }
  const src = await builder.add("noiseTOP", "source", { monochrome: 0, period: 3 });
  await builder.python(
    `_p = op(${q(src)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q("absTime.seconds * 0.1")}\n_p.mode = _PM.EXPRESSION`,
  );
  return src;
}

export async function createPixelSortImpl(ctx: ToolContext, args: CreatePixelSortArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // 1. Source
    const source = await buildSource(builder, args);

    // 2. Switch TOP — seeds from source on frame 0, iterates via feedback after
    const sw = await builder.add("switchTOP", "switch1", { outputresolution: "custom" });
    await builder.setParams(sw, {
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });

    // 3. GLSL TOP — receives [switch output, original source]
    const glsl = await builder.add("glslTOP", "sort_glsl", {
      outputresolution: "custom",
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });

    // 4. Shader DAT
    const frag = await builder.add("textDAT", "sort_frag");

    // 5. Feedback TOP — feeds back sort_glsl output into switch1 input 1
    const fb = await builder.add("feedbackTOP", "feedback1", { outputresolution: "custom" });
    await builder.setParams(fb, {
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });

    // 6. Output null
    const out = await builder.add("nullTOP", "out1");

    // Wiring:
    //   source → switch1 (input 0)
    //   switch1 → sort_glsl (input 0)
    //   source → sort_glsl (input 1, for original mask reference)
    //   sort_glsl → feedback1
    //   feedback1 → switch1 (input 1, closes the loop)
    //   sort_glsl → out1
    await builder.connect(source, sw);
    await builder.connect(sw, glsl);
    await builder.connect(source, glsl); // second input for mask
    await builder.connect(glsl, fb);
    await builder.connect(fb, sw); // closes feedback loop
    await builder.connect(glsl, out);

    // Set shader text and bind pixeldat
    await builder.python(
      `op(${q(frag)}).text = ${q(SORT_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
    );

    // Bind uniforms via seq.vec
    const axisInt = AXIS_INT[args.axis] ?? 0;
    const keyInt = KEY_INT[args.sort_by] ?? 0;
    const dirInt = DIR_INT[args.direction] ?? 1;

    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 6)`,
        // vec0: uAxis — build-time constant
        `_g.par.vec0name = 'uAxis'`,
        `_g.par.vec0valuex = ${axisInt}`,
        // vec1: uKey — build-time constant
        `_g.par.vec1name = 'uKey'`,
        `_g.par.vec1valuex = ${keyInt}`,
        // vec2: uDirection — live control (Direction par is 0/1)
        `_g.par.vec2name = 'uDirection'`,
        `_g.par.vec2valuex.expr = ${q(`(parent().par.Direction.eval() if hasattr(parent().par, 'Direction') else ${dirInt})`)}`,
        `_g.par.vec2valuex.mode = type(_g.par.vec2valuex.mode).EXPRESSION`,
        // vec3: uThreshold — live control
        `_g.par.vec3name = 'uThreshold'`,
        `_g.par.vec3valuex.expr = ${q(`(parent().par.Threshold.eval() if hasattr(parent().par, 'Threshold') else ${args.threshold})`)}`,
        `_g.par.vec3valuex.mode = type(_g.par.vec3valuex.mode).EXPRESSION`,
        // vec4: uPhase — alternates per frame from absTime
        `_g.par.vec4name = 'uPhase'`,
        `_g.par.vec4valuex.expr = ${q("int(absTime.frame) % 2")}`,
        `_g.par.vec4valuex.mode = type(_g.par.vec4valuex.mode).EXPRESSION`,
        // vec5: uMix — live control
        `_g.par.vec5name = 'uMix'`,
        `_g.par.vec5valuex.expr = ${q(`(parent().par.Mix.eval() if hasattr(parent().par, 'Mix') else ${args.mix})`)}`,
        `_g.par.vec5valuex.mode = type(_g.par.vec5valuex.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Wire switch iteration latch: frame < Iterations → iterate; else hold
    await builder.python(
      [
        `_sw = op(${q(sw)})`,
        `_sw.par.index.expr = ${q("1 if me.time.frame < parent().par.Iterations else 0")}`,
        `_sw.par.index.mode = type(_sw.par.index.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Feedback target must point at the switch
    await builder.python(`op(${q(fb)}).par.top = op(${q(sw)}).name`);

    const controls: ControlSpec[] = [
      { name: "Mix", type: "float", min: 0, max: 1, default: args.mix, bind_to: [] },
      {
        name: "Threshold",
        type: "float",
        min: 0,
        max: 1,
        default: args.threshold,
        bind_to: [],
      },
      {
        name: "Iterations",
        type: "int",
        min: 1,
        max: 256,
        default: args.iterations,
        bind_to: [],
      },
      {
        name: "Direction",
        type: "float",
        min: 0,
        max: 1,
        default: dirInt,
        bind_to: [],
      },
      { name: "Reset", type: "float", min: 0, max: 1, default: 0, bind_to: [] },
    ];

    const sourceLabel = args.source_top_path ?? "noise";

    return finalize(ctx, {
      summary:
        `Created pixel_sort system (source: ${sourceLabel}, axis: ${args.axis}, ` +
        `sort_by: ${args.sort_by}, direction: ${args.direction}, threshold: ${args.threshold}, ` +
        `iterations: ${args.iterations}, mix: ${args.mix}) → ${out}. ` +
        `GLSL compile UNVERIFIED (TD offline at build time).`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        axis: args.axis,
        sort_by: args.sort_by,
        direction: args.direction,
        threshold: args.threshold,
        iterations: args.iterations,
        source: sourceLabel,
        glsl_compile_verified: false,
        approximation: "odd-even transposition sort, multi-pass feedback",
      },
    });
  });
}

export const registerCreatePixelSort: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_pixel_sort",
    {
      title: "Create pixel sort",
      description:
        "Build a glitch-art pixel-sort effect that sorts pixels along rows or columns within " +
        "luminance-thresholded regions, creating the signature Kim Asendorf–style horizontal/vertical " +
        "streak aesthetic. Uses a multi-pass odd-even transposition sort over a glslTOP feedback chain. " +
        "Sort key: luminance, hue, or saturation. Exposes Mix, Threshold, Iterations, Direction, and " +
        "Reset for live tweaking. Defaults to a self-contained noiseTOP source when no input TOP is provided.",
      inputSchema: createPixelSortSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPixelSortImpl(ctx, args),
  );
};
