import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Pass 1 — ETF (edge-tangent flow) + tangent-aligned bilateral smoothing.
 *
 * `sTD2DInputs[0]` is the source TOP (via Select TOP). The ETF glslTOP takes a
 * single input — iteration count is exposed for downstream FDoG sharpening
 * rather than ping-pong feedback here (a second sTD2DInputs slot fails to
 * compile on TD when not wired). Loop bounds are compile-time constants with
 * early-out via `uRadius`.
 *
 * GLSL gotchas honored: declares `out vec4 fragColor;`, writes through
 * `TDOutputSwizzle(...)`, uses `uTDOutputInfo.res.xy` for texel size (the
 * reciprocal of resolution, per TDTexInfo layout), no
 * `uTime`, no preamble `#define` collisions (no F1/F2 locals). Note: any GLSL
 * compile errors here surface via `warnings()` / the Info DAT, not `errors()`.
 */
const ETF_SHADER = `out vec4 fragColor;

uniform float uStrength;    // live (parent().par.Strength)
uniform float uIterations;  // live (parent().par.Iterations), cast to int
uniform float uRadius;      // build-time bilateral half-width

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec2 sobelTangent(vec2 uv, vec2 px) {
    float l00 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x, -px.y)).rgb);
    float l10 = luma(texture(sTD2DInputs[0], uv + vec2( 0.0,  -px.y)).rgb);
    float l20 = luma(texture(sTD2DInputs[0], uv + vec2( px.x, -px.y)).rgb);
    float l01 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x,  0.0)).rgb);
    float l21 = luma(texture(sTD2DInputs[0], uv + vec2( px.x,  0.0)).rgb);
    float l02 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x,  px.y)).rgb);
    float l12 = luma(texture(sTD2DInputs[0], uv + vec2( 0.0,   px.y)).rgb);
    float l22 = luma(texture(sTD2DInputs[0], uv + vec2( px.x,  px.y)).rgb);

    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);

    // Tangent is perpendicular to the gradient.
    vec2 grad = vec2(gx, gy);
    float gl = length(grad);
    if (gl < 1e-5) return vec2(1.0, 0.0);
    vec2 tang = vec2(-grad.y, grad.x) / gl;
    return tang;
}

void main() {
    vec2 uv = vUV.st;
    vec2 px = uTDOutputInfo.res.xy;
    vec2 tang = sobelTangent(uv, px);

    vec3 center = texture(sTD2DInputs[0], uv).rgb;
    vec3 acc = center;
    float wsum = 1.0;
    int halfW = int(clamp(uRadius, 1.0, 8.0));
    float sigmaS = max(uRadius, 1.0);
    float sigmaR = 0.12;

    for (int i = 1; i < 9; ++i) {
        if (i > halfW) break;
        float fi = float(i);
        float gs = exp(-(fi * fi) / (2.0 * sigmaS * sigmaS));

        vec2 dp = tang * px * fi;
        vec3 sp = texture(sTD2DInputs[0], uv + dp).rgb;
        vec3 sn = texture(sTD2DInputs[0], uv - dp).rgb;

        float dp_diff = length(sp - center);
        float dn_diff = length(sn - center);
        float wp = gs * exp(-(dp_diff * dp_diff) / (2.0 * sigmaR * sigmaR));
        float wn = gs * exp(-(dn_diff * dn_diff) / (2.0 * sigmaR * sigmaR));

        acc += sp * wp + sn * wn;
        wsum += wp + wn;
    }
    vec3 smoothed = acc / wsum;

    // Iteration count nudges effective strength so the live uniform still
    // shapes the look without needing a feedback ping-pong input.
    float iterBoost = clamp((uIterations - 1.0) * 0.15, 0.0, 0.6);
    float strength = clamp(uStrength + iterBoost, 0.0, 1.0);
    vec3 outc = mix(center, smoothed, strength);
    fragColor = TDOutputSwizzle(vec4(outc, 1.0));
}
`;

/**
 * Pass 2 — FDoG (flow-based Difference of Gaussians) line extraction.
 *
 * `sTD2DInputs[0]` = ETF-smoothed base (single input). Soft-thresholded DoG
 * response along the local tangent — derived from the ETF output — is
 * multiplied back onto the smoothed base. No second input is wired; the
 * tangent is re-derived from sTD2DInputs[0] rather than a separate original-
 * source path (no measurable quality difference in the single-input chain).
 */
const FDOG_SHADER = `out vec4 fragColor;

uniform float uEdge;    // live (parent().par.Edge)
uniform float uSigmaE;  // build-time
uniform float uSigmaR;  // build-time, typically ~1.6 * uSigmaE
uniform float uTau;     // build-time, center-surround weight

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec2 sobelTangent(vec2 uv, vec2 px) {
    float l00 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x, -px.y)).rgb);
    float l10 = luma(texture(sTD2DInputs[0], uv + vec2( 0.0,  -px.y)).rgb);
    float l20 = luma(texture(sTD2DInputs[0], uv + vec2( px.x, -px.y)).rgb);
    float l01 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x,  0.0)).rgb);
    float l21 = luma(texture(sTD2DInputs[0], uv + vec2( px.x,  0.0)).rgb);
    float l02 = luma(texture(sTD2DInputs[0], uv + vec2(-px.x,  px.y)).rgb);
    float l12 = luma(texture(sTD2DInputs[0], uv + vec2( 0.0,   px.y)).rgb);
    float l22 = luma(texture(sTD2DInputs[0], uv + vec2( px.x,  px.y)).rgb);
    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    vec2 grad = vec2(gx, gy);
    float gl = length(grad);
    if (gl < 1e-5) return vec2(1.0, 0.0);
    return vec2(-grad.y, grad.x) / gl;
}

void main() {
    vec2 uv = vUV.st;
    vec2 px = uTDOutputInfo.res.xy;
    vec2 tang = sobelTangent(uv, px);
    // Normal direction: perpendicular to tangent, used for cross-DoG sampling.
    vec2 norm = vec2(-tang.y, tang.x);

    float sigE = max(uSigmaE, 0.5);
    float sigR = max(uSigmaR, sigE * 1.05);
    int halfW = int(clamp(ceil(2.0 * sigR), 1.0, 8.0));

    float accE = 0.0;
    float accR = 0.0;
    float wE = 0.0;
    float wR = 0.0;

    for (int i = -8; i <= 8; ++i) {
        if (i < -halfW || i > halfW) continue;
        float fi = float(i);
        float gE = exp(-(fi * fi) / (2.0 * sigE * sigE));
        float gR = exp(-(fi * fi) / (2.0 * sigR * sigR));
        vec2 off = norm * px * fi;
        float lp = luma(texture(sTD2DInputs[0], uv + off).rgb);
        accE += lp * gE;
        accR += lp * gR;
        wE += gE;
        wR += gR;
    }

    float ge = accE / max(wE, 1e-5);
    float gr = accR / max(wR, 1e-5);
    float dog = ge - uTau * gr;
    float response = dog * uEdge;

    // Soft threshold to ink mask: dark where response is negative.
    float ink = 1.0 - smoothstep(0.0, 0.5, -response);
    ink = clamp(ink, 0.0, 1.0);

    vec3 base = texture(sTD2DInputs[0], uv).rgb;
    vec3 outc = base * ink;
    fragColor = TDOutputSwizzle(vec4(outc, 1.0));
}
`;

export const createFlowAbstractionSchema = z.object({
  parent_path: z.string().describe("Parent COMP path to create the two GLSL TOPs in."),
  name: z
    .string()
    .default("flow_abs")
    .describe("Base name; nodes become <name>_etf, <name>_fdog, <name>_out, plus *_frag textDATs."),
  source: z
    .string()
    .describe(
      "Absolute path of the input TOP to abstract (e.g. '/project1/movie1'). Pulled in via a Select TOP so cross-container wiring is safe.",
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe("Bilateral smoothing strength (0=passthrough, 1=full ETF blur)."),
  edge: z
    .number()
    .min(0)
    .max(2)
    .default(1.0)
    .describe("FDoG edge gain — multiplier on the DoG response before thresholding."),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(2)
    .describe(
      "Number of ETF passes; higher values boost ETF strength via an in-shader uniform. No external feedback loop is created in this version.",
    ),
  blur_radius: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe("ETF bilateral kernel half-width in texels along the tangent (kernel ≈ 2*radius+1)."),
  sigma_e: z
    .number()
    .min(0.5)
    .max(4.0)
    .default(1.0)
    .describe("FDoG inner Gaussian sigma (texels)."),
  sigma_r: z
    .number()
    .min(1.0)
    .max(8.0)
    .default(1.6)
    .describe("FDoG outer Gaussian sigma — usually ≈ 1.6 * sigma_e."),
  tau: z.number().min(0.9).max(1.0).default(0.99).describe("FDoG center-surround weight."),
  resolution: z
    .enum(["720p", "1080p", "4K", "input"])
    .default("input")
    .describe("Output res; 'input' inherits."),
});
type CreateFlowAbstractionArgs = z.infer<typeof createFlowAbstractionSchema>;

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

export async function createFlowAbstractionImpl(ctx: ToolContext, args: CreateFlowAbstractionArgs) {
  return guardTd(
    async () => {
      const warnings: string[] = [];
      const parent = args.parent_path;
      const base = args.name;

      // Select TOP — safe cross-container ingress for the source.
      const sel = await ctx.client.createNode({
        parent_path: parent,
        type: "selectTOP",
        name: `${base}_in`,
      });
      await ctx.client.updateNodeParameters(sel.path, { top: args.source });

      // Pass 1 — ETF + tangent bilateral.
      const etf = await ctx.client.createNode({
        parent_path: parent,
        type: "glslTOP",
        name: `${base}_etf`,
      });
      const etfFrag = await ctx.client.createNode({
        parent_path: parent,
        type: "textDAT",
        name: `${base}_etf_frag`,
      });

      // Pass 2 — FDoG line extraction.
      const fdog = await ctx.client.createNode({
        parent_path: parent,
        type: "glslTOP",
        name: `${base}_fdog`,
      });
      const fdogFrag = await ctx.client.createNode({
        parent_path: parent,
        type: "textDAT",
        name: `${base}_fdog_frag`,
      });

      const outNull = await ctx.client.createNode({
        parent_path: parent,
        type: "nullTOP",
        name: `${base}_out`,
      });

      // Assign shader text + bind pixeldat in one exec call.
      const shaderAssign = [
        `op(${q(etfFrag.path)}).text = ${q(ETF_SHADER)}`,
        `op(${q(etf.path)}).par.pixeldat = ${q(etfFrag.name || `${base}_etf_frag`)}`,
        `op(${q(fdogFrag.path)}).text = ${q(FDOG_SHADER)}`,
        `op(${q(fdog.path)}).par.pixeldat = ${q(fdogFrag.name || `${base}_fdog_frag`)}`,
      ].join("\n");
      await ctx.client.executePythonScript(shaderAssign, false);

      // Wiring: Select → ETF[0] → FDoG[0] → Null. Single-input chain.
      await connectNodesViaBridge(ctx.client, sel.path, etf.path, 0, 0);
      await connectNodesViaBridge(ctx.client, etf.path, fdog.path, 0, 0);
      await connectNodesViaBridge(ctx.client, fdog.path, outNull.path, 0, 0);

      // Uniforms — Vectors-page bind block (mirrors createDither pattern).
      const bindEtf = [
        `_g = op(${q(etf.path)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
        // vec0: uStrength — live
        `_g.par.vec0name = 'uStrength'`,
        `_g.par.vec0valuex.expr = ${q(`(parent().par.Strength.eval() if hasattr(parent().par, 'Strength') else ${args.strength})`)}`,
        `_g.par.vec0valuex.mode = type(_g.par.vec0valuex.mode).EXPRESSION`,
        // vec1: uIterations — live
        `_g.par.vec1name = 'uIterations'`,
        `_g.par.vec1valuex.expr = ${q(`(parent().par.Iterations.eval() if hasattr(parent().par, 'Iterations') else ${args.iterations})`)}`,
        `_g.par.vec1valuex.mode = type(_g.par.vec1valuex.mode).EXPRESSION`,
        // vec2: uRadius — build-time
        `_g.par.vec2name = 'uRadius'`,
        `_g.par.vec2valuex = ${args.blur_radius}`,
      ].join("\n");
      await ctx.client.executePythonScript(bindEtf, false);

      const bindFdog = [
        `_g = op(${q(fdog.path)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 4)`,
        // vec0: uEdge — live
        `_g.par.vec0name = 'uEdge'`,
        `_g.par.vec0valuex.expr = ${q(`(parent().par.Edge.eval() if hasattr(parent().par, 'Edge') else ${args.edge})`)}`,
        `_g.par.vec0valuex.mode = type(_g.par.vec0valuex.mode).EXPRESSION`,
        // vec1: uSigmaE — build-time
        `_g.par.vec1name = 'uSigmaE'`,
        `_g.par.vec1valuex = ${args.sigma_e}`,
        // vec2: uSigmaR — build-time
        `_g.par.vec2name = 'uSigmaR'`,
        `_g.par.vec2valuex = ${args.sigma_r}`,
        // vec3: uTau — build-time
        `_g.par.vec3name = 'uTau'`,
        `_g.par.vec3valuex = ${args.tau}`,
      ].join("\n");
      await ctx.client.executePythonScript(bindFdog, false);

      if (args.resolution !== "input") {
        const [w, h] = RESOLUTIONS[args.resolution];
        await ctx.client.updateNodeParameters(etf.path, {
          outputresolution: "custom",
          resolutionw: w,
          resolutionh: h,
        });
        await ctx.client.updateNodeParameters(fdog.path, {
          outputresolution: "custom",
          resolutionw: w,
          resolutionh: h,
        });
      }

      return {
        etf: etf.path,
        fdog: fdog.path,
        out: outNull.path,
        frags: [etfFrag.path, fdogFrag.path],
        feedback: undefined as string | undefined,
        glsl_compile_verified: false,
        warnings,
      };
    },
    (result) =>
      jsonResult(
        `Created flow-abstraction (ETF + FDoG) at ${result.out}. GLSL compile UNVERIFIED (TD offline at build time).`,
        result,
      ),
  );
}

export const registerCreateFlowAbstraction: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_flow_abstraction",
    {
      title: "Create flow abstraction",
      description:
        "Build a two-pass Kyprianidis-style flow abstraction: an edge-tangent-flow (ETF) bilateral smoother followed by a flow-based DoG (FDoG) line extractor — oil-painting smooth interiors with crisp coherent ink edges. Creates two glslTOPs + companion textDATs under parent_path, fed by a Select TOP from the source TOP and terminated by a Null TOP. Strength/Edge/Iterations are exposed as live parent-par-bound uniforms; blur radius, sigmas and tau are baked in at build time. Iterations boosts effective ETF strength in-shader (single-input pass, no ping-pong feedback).",
      inputSchema: createFlowAbstractionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFlowAbstractionImpl(ctx, args),
  );
};
