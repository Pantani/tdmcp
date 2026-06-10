import { z } from "zod";
import { createSystemContainer, finalize, type NetworkBuilder } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

// ── Era preset table ──────────────────────────────────────────────────────────
const PRESETS = {
  super8: {
    distortion_strength: 0.18,
    ca_strength: 0.012,
    vignette_strength: 0.55,
    grain_amount: 0.18,
  },
  vhs: { distortion_strength: 0.08, ca_strength: 0.02, vignette_strength: 0.3, grain_amount: 0.12 },
  "16mm": {
    distortion_strength: 0.1,
    ca_strength: 0.006,
    vignette_strength: 0.4,
    grain_amount: 0.1,
  },
  "80s_camcorder": {
    distortion_strength: 0.05,
    ca_strength: 0.015,
    vignette_strength: 0.45,
    grain_amount: 0.14,
  },
} as const;

type Era = keyof typeof PRESETS;

// ── Shader bodies ─────────────────────────────────────────────────────────────

const BARREL_FRAG = `out vec4 fragColor;
uniform float uK;
void main(){
  vec2 uv = vUV.st - 0.5;
  float r2 = dot(uv, uv);
  uv = uv * (1.0 + uK * r2) + 0.5;
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){
    fragColor = TDOutputSwizzle(vec4(0.0));
  } else {
    fragColor = TDOutputSwizzle(texture(sTD2DInputs[0], uv));
  }
}
`;

const CA_FRAG = `out vec4 fragColor;
uniform float uOffset;
void main(){
  vec2 uv = vUV.st;
  vec2 o = (uv - 0.5) * uOffset;
  float r = texture(sTD2DInputs[0], uv + o).r;
  float g = texture(sTD2DInputs[0], uv).g;
  float b = texture(sTD2DInputs[0], uv - o).b;
  fragColor = TDOutputSwizzle(vec4(r, g, b, 1.0));
}
`;

const VIGNETTE_FRAG = `out vec4 fragColor;
uniform float uVignette;
void main(){
  vec2 uv = vUV.st;
  vec4 c = texture(sTD2DInputs[0], uv);
  float v = smoothstep(0.8, 0.35, distance(uv, vec2(0.5)));
  fragColor = TDOutputSwizzle(vec4(c.rgb * mix(1.0, v, uVignette), c.a));
}
`;

const GRAIN_FRAG = `out vec4 fragColor;
uniform float uAmount;
uniform float uTime;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUV.st;
  vec4 c = texture(sTD2DInputs[0], uv);
  float g = hash(uv + uTime) * uAmount - uAmount * 0.5;
  fragColor = TDOutputSwizzle(vec4(c.rgb + g, c.a));
}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function addGlslWithUniform(
  builder: NetworkBuilder,
  name: string,
  fragment: string,
  uniformName: string,
  uniformValue: number,
): Promise<string> {
  const glsl = await builder.add("glslTOP", name);
  const frag = await builder.add("textDAT", `${name}_frag`);
  const setup = [
    `op(${q(frag)}).text = ${q(fragment)}`,
    `_g = op(${q(glsl)})`,
    `_g.par.pixeldat = op(${q(frag)}).name`,
    `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 1)`,
    `_g.par.vec0name = ${q(uniformName)}`,
    `_g.par.vec0valuex = ${uniformValue}`,
  ].join("\n");
  await builder.python(setup);
  return glsl;
}

async function addGrainPass(
  builder: NetworkBuilder,
  name: string,
  grainAmount: number,
): Promise<string> {
  const glsl = await builder.add("glslTOP", name);
  const frag = await builder.add("textDAT", `${name}_frag`);
  const setup = [
    `op(${q(frag)}).text = ${q(GRAIN_FRAG)}`,
    `_g = op(${q(glsl)})`,
    `_g.par.pixeldat = op(${q(frag)}).name`,
    `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 2)`,
    `_g.par.vec0name = 'uAmount'`,
    `_g.par.vec0valuex = ${grainAmount * 0.25}`,
    `_g.par.vec1name = 'uTime'`,
    `_g.par.vec1valuex = 0`,
  ].join("\n");
  await builder.python(setup);
  return glsl;
}

// ── Schema ────────────────────────────────────────────────────────────────────

export const createVintageLensSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the vintage-lens container is created (default '/project1')."),
  name: z
    .string()
    .default("vintage_lens")
    .describe("Name suffix for the baseCOMP (default 'vintage_lens')."),
  source_top_path: z
    .string()
    .describe("Path of the existing TOP to grade (e.g. '/project1/render1')."),
  era: z
    .enum(["super8", "vhs", "16mm", "80s_camcorder"])
    .default("super8")
    .describe("Era preset that sets default strength values; per-param overrides win."),
  distortion_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Barrel-distortion coefficient (UV warped from center). Overrides preset."),
  ca_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("RGB-split offset magnitude (radial from center). Overrides preset."),
  vignette_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Edge darkening amount; 0 disables. Overrides preset."),
  grain_amount: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Per-pixel noise amplitude. Overrides preset."),
});

export type CreateVintageLensArgs = z.infer<typeof createVintageLensSchema>;

// ── Impl ──────────────────────────────────────────────────────────────────────

export async function createVintageLensImpl(ctx: ToolContext, args: CreateVintageLensArgs) {
  const preset = PRESETS[args.era as Era];
  const resolved = {
    distortion_strength: args.distortion_strength ?? preset.distortion_strength,
    ca_strength: args.ca_strength ?? preset.ca_strength,
    vignette_strength: args.vignette_strength ?? preset.vignette_strength,
    grain_amount: args.grain_amount ?? preset.grain_amount,
  };

  // Verify source exists before building the network.
  try {
    await ctx.client.getNode(args.source_top_path);
  } catch {
    return errorResult(`Source TOP not found: ${args.source_top_path}`, {
      source_top_path: args.source_top_path,
    });
  }

  try {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // Pull source in via selectTOP (no cross-container wires).
    const source = await builder.add("selectTOP", "source");
    await builder.setParams(source, { top: args.source_top_path });

    // 4 GLSL passes in fixed order.
    const barrel = await addGlslWithUniform(
      builder,
      "barrel",
      BARREL_FRAG,
      "uK",
      resolved.distortion_strength * 0.6,
    );
    const ca = await addGlslWithUniform(builder, "ca", CA_FRAG, "uOffset", resolved.ca_strength);
    const vignette = await addGlslWithUniform(
      builder,
      "vignette",
      VIGNETTE_FRAG,
      "uVignette",
      resolved.vignette_strength,
    );
    const grain = await addGrainPass(builder, "grain", resolved.grain_amount);

    // Wire the chain.
    await builder.connect(source, barrel);
    await builder.connect(barrel, ca);
    await builder.connect(ca, vignette);
    await builder.connect(vignette, grain);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(grain, out);

    return finalize(ctx, {
      summary: `Created vintage lens (${args.era}) over ${args.source_top_path}.`,
      builder,
      outputPath: out,
      extra: {
        source_top_path: args.source_top_path,
        era: args.era,
        resolved,
      },
    });
  } catch (err) {
    const { friendlyTdError } = await import("../../td-client/types.js");
    return errorResult(friendlyTdError(err));
  }
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerCreateVintageLens: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vintage_lens",
    {
      title: "Create Vintage Lens",
      description:
        "Drape a vintage analog-film aesthetic over any TOP in one call. Chains barrel/pincushion lens distortion → chromatic aberration → vignette → film grain as four inline GLSL passes inside a new baseCOMP. Era presets (super8, vhs, 16mm, 80s_camcorder) load era-correct strength defaults; any per-param override wins. Returns a standard Layer 1 envelope with container path, node paths, output path, preview image, warnings, and the resolved strength values.",
      inputSchema: createVintageLensSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVintageLensImpl(ctx, args),
  );
};
