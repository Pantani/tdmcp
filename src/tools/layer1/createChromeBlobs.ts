import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const METAL_COLORS: Record<string, [number, number, number]> = {
  silver: [0.85, 0.85, 0.9],
  gold: [0.95, 0.8, 0.3],
  copper: [0.9, 0.55, 0.35],
  chrome_blue: [0.4, 0.6, 0.95],
  gunmetal: [0.35, 0.38, 0.42],
};

const BACKGROUND_INDEX: Record<string, number> = {
  black: 0,
  white: 1,
  studio: 2,
  gradient: 3,
};

/** Chrome / Y2K environment-map GLSL fragment shader. */
const CHROME_FRAG = `
uniform vec3  uMetalColor;
uniform int   uBackground;
uniform float uTime;
out vec4 fragColor;

vec3 envSample(vec2 dir) {
  // Procedural vertical-stripe HDR studio proxy
  float stripe = 0.5 + 0.5 * sin(dir.y * 6.2831 * 3.0 + uTime * 0.5);
  float horiz  = 0.5 + 0.5 * cos(dir.x * 6.2831 * 2.0);
  return vec3(stripe * 0.8 + horiz * 0.2);
}

void main() {
  vec2 uv = vUV.st;
  // Sample blob field to derive a fake normal via Sobel
  float d  = texture(sTD2DInputs[0], uv).r;
  float px = 1.0 / uTD2DInfos[0].res.z;
  float py = 1.0 / uTD2DInfos[0].res.w;
  float dx = texture(sTD2DInputs[0], uv + vec2(px, 0.0)).r
           - texture(sTD2DInputs[0], uv - vec2(px, 0.0)).r;
  float dy = texture(sTD2DInputs[0], uv + vec2(0.0, py)).r
           - texture(sTD2DInputs[0], uv - vec2(0.0, py)).r;
  vec3 normal = normalize(vec3(dx, dy, 0.2));

  // Reflection vector into fake env
  vec2 reflDir = normal.xy * 2.0;
  vec3 env = envSample(reflDir);

  // Moving specular highlight
  vec2 sunDir = vec2(cos(uTime * 0.7), sin(uTime * 0.4)) * 0.5 + 0.5;
  float spec = pow(max(0.0, dot(normalize(normal.xy), normalize(sunDir - uv))), 24.0);

  vec3 chrome = env * uMetalColor + vec3(spec * 0.9);

  // Background alpha for blob shape
  float blobMask = smoothstep(0.1, 0.4, d);

  // Background colour
  vec3 bg = vec3(0.0);
  if (uBackground == 1) bg = vec3(1.0);
  else if (uBackground == 2) bg = vec3(0.2 + 0.3 * (1.0 - length(uv - 0.5)));
  else if (uBackground == 3) bg = mix(vec3(0.05, 0.05, 0.1), vec3(0.7, 0.75, 0.8), uv.y);

  vec3 col = mix(bg, chrome, blobMask);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`.trim();

export const createChromeBlobsSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the chrome-blobs COMP is created (default '/project1')."),
  name: z
    .string()
    .default("chrome_blobs")
    .describe("Name for the system container COMP (default 'chrome_blobs')."),
  source_top_path: z
    .string()
    .optional()
    .describe(
      "Optional external TOP to use as the blob field (pulls in via Select TOP). When omitted, an animated Noise TOP generates the blobs.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(8)
    .describe(
      "Logical blob count — drives noise harmonics + blur/threshold params (1–32, default 8).",
    ),
  speed: z
    .number()
    .min(0)
    .max(4)
    .default(0.5)
    .describe(
      "Noise animation speed — controls the absTime.seconds multiplier on noise TX/TZ (0–4, default 0.5).",
    ),
  metal_color: z
    .enum(["silver", "gold", "copper", "chrome_blue", "gunmetal"])
    .default("silver")
    .describe("Chrome tint palette for the GLSL environment-map shader (default 'silver')."),
  background: z
    .enum(["black", "white", "studio", "gradient"])
    .default("black")
    .describe(
      "Background behind the chrome blobs — black, white, studio (soft radial), or gradient (vertical chrome studio) (default 'black').",
    ),
});

type CreateChromeBlobsArgs = z.infer<typeof createChromeBlobsSchema>;

export async function createChromeBlobsImpl(ctx: ToolContext, args: CreateChromeBlobsArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // Blur size formula: larger count → smaller blobs → less blur needed
    const blur1Size = Math.round(8 + 32 / args.count);
    // Threshold shifts towards 0.6 as count grows (more blobs → higher base threshold)
    const thresholdVal = Math.min(0.4 + args.count * 0.01, 0.7);

    let blobSource: string;

    if (args.source_top_path) {
      // Pull in external source via Select TOP (no cross-container wires)
      const sel = await builder.add("selectTOP", "select1");
      await builder.setParams(sel, { top: args.source_top_path });
      blobSource = sel;
    } else {
      // Animated Noise TOP — harmonics driven by count
      const noise = await builder.add("noiseTOP", "noise1", {
        harmonics: Math.min(args.count, 8),
        period: 1.0,
      });
      // Animate noise position via Python expressions on the par
      await builder.python(
        [
          `_n = op(${q(noise)})`,
          `_n.par.tx.expr = 'absTime.seconds * ${args.speed}'`,
          `_n.par.tz.expr = 'absTime.seconds * ${args.speed * 0.6}'`,
        ].join("\n"),
      );
      blobSource = noise;
    }

    // Blur → Level → Threshold → Blur2 chain
    const blur1 = await builder.add("blurTOP", "blur1", { size: blur1Size });
    await builder.connect(blobSource, blur1);

    const level1 = await builder.add("levelTOP", "level1", { gamma1: 0.5, brightness1: 1.1 });
    await builder.connect(blur1, level1);

    const thresh = await builder.add("thresholdTOP", "threshold1", { threshold: thresholdVal });
    await builder.connect(level1, thresh);

    const blur2 = await builder.add("blurTOP", "blur2", { size: 4 });
    await builder.connect(thresh, blur2);

    // GLSL chrome shader — set up via textDAT + pixeldat pattern
    const glsl = await builder.add("glslTOP", "glsl_chrome");
    const frag = await builder.add("textDAT", "chrome_frag");

    const metalRgb = METAL_COLORS[args.metal_color] ?? METAL_COLORS.silver ?? [0.85, 0.85, 0.9];
    const bgIndex = BACKGROUND_INDEX[args.background] ?? 0;

    await builder.python(
      [
        `op(${q(frag)}).text = ${q(CHROME_FRAG)}`,
        `_g = op(${q(glsl)})`,
        `_g.par.pixeldat = op(${q(frag)}).name`,
        // Raise the vec sequence block count before setting per-block pars
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
        // uMetalColor (vec3) at block 0
        `_g.par.vec0name = 'uMetalColor'`,
        `_g.par.vec0valuex = ${metalRgb[0]}`,
        `_g.par.vec0valuey = ${metalRgb[1]}`,
        `_g.par.vec0valuez = ${metalRgb[2]}`,
        // uBackground (int) at block 1
        `_g.par.vec1name = 'uBackground'`,
        `_g.par.vec1valuex = ${bgIndex}`,
        // uTime (float) at block 2 — driven by me.time.seconds expression
        `_g.par.vec2name = 'uTime'`,
        `_g.par.vec2valuex.expr = 'me.time.seconds'`,
      ].join("\n"),
    );

    await builder.connect(blur2, glsl);

    // Background source (constantTOP or rampTOP)
    let bgNode: string;
    if (args.background === "gradient") {
      bgNode = await builder.add("rampTOP", "ramp_bg", { type: 0 }); // 0 = vertical
    } else {
      const bgColor = args.background === "white" ? { r: 1, g: 1, b: 1 } : { r: 0, g: 0, b: 0 };
      bgNode = await builder.add("constantTOP", "const_bg", bgColor);
    }

    // Composite chrome over background (over mode)
    const comp = await builder.add("compositeTOP", "comp_bg", { operand: 14 }); // 14 = Over
    await builder.connect(glsl, comp, 0, 0);
    await builder.connect(bgNode, comp, 0, 1);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(comp, out);

    return finalize(ctx, {
      summary: `Created liquid-chrome blob generator '${args.name}' with ${args.metal_color} tint, ${args.count} blobs, speed ${args.speed}, ${args.background} background.`,
      builder,
      outputPath: out,
      controls: [
        {
          name: "Speed",
          type: "float" as const,
          default: args.speed,
          min: 0,
          max: 4,
          bind_to: [],
        },
        {
          name: "Blob_Count",
          type: "int" as const,
          default: args.count,
          min: 1,
          max: 32,
          bind_to: [],
        },
        {
          name: "Metal_Color",
          type: "menu" as const,
          default: 0,
          menu_items: ["silver", "gold", "copper", "chrome_blue", "gunmetal"],
          bind_to: [],
        },
        {
          name: "Background",
          type: "menu" as const,
          default: 0,
          menu_items: ["black", "white", "studio", "gradient"],
          bind_to: [],
        },
      ],
      extra: {
        metal_color: args.metal_color,
        background: args.background,
        count: args.count,
      },
    });
  });
}

export const registerCreateChromeBlobs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_chrome_blobs",
    {
      title: "Create Chrome Blobs",
      description:
        "Builds a liquid-chrome / Y2K metaball generator: an animated Noise TOP (or external source) is blurred, thresholded into soft blobs, then a GLSL TOP renders a procedural environment-map chrome look (greyscale ramp + moving specular highlight) with 5 metal tints and 4 background modes. Creates a self-contained baseCOMP with Speed, Blob_Count, Metal_Color, and Background controls exposed on the container.",
      inputSchema: createChromeBlobsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createChromeBlobsImpl(ctx, args),
  );
};
