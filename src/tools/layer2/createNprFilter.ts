import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Non-photorealistic painterly filter — generalized Kuwahara → oil / pencil /
 * watercolor branch selected by `uMode`.
 *
 * GLSL gotchas honored:
 *   - Declares `out vec4 fragColor;`, writes via `TDOutputSwizzle(...)`.
 *   - Source = `sTD2DInputs[0]`; UV = `vUV.st`; texel size = `1.0 / uTD2DInfos[0].res.zw`
 *     (`.zw` is the resolution in pixels; `.xy` is the reciprocal — either works,
 *     but `1.0/.zw` matches the rest of this codebase's GLSL snippets).
 *   - No `uTime` built-in (this filter is non-temporal anyway).
 *   - Static loop bounds: outer `for (s = 0; s < 8; ++s) if (s >= N) break;` and
 *     `for (y = -12; y <= 12; ++y) if (y < -ri || y > ri) continue;` keep bounds
 *     compile-time-constant while clamping by uniform.
 *
 * Re-exported so `apply_post_processing` (Layer 1) can adopt this shader for the
 * `npr_oil` / `npr_pencil` / `npr_watercolor` mode keys without duplication.
 */
export const NPR_SHADER = `out vec4 fragColor;

uniform float uMode;        // 0=oil 1=pencil 2=watercolor
uniform float uSectors;     // 4 or 8
uniform float uRadius;      // 1..12 texels
uniform float uSmoothness;  // 0..1
uniform float uStrength;    // 0..1 wet/dry

vec4 sectorStats(vec2 uv, vec2 px, int s, int N, float R) {
    float a0 = 6.2831853 * (float(s)     / float(N));
    float a1 = 6.2831853 * (float(s + 1) / float(N));
    vec3 m = vec3(0.0); vec3 m2 = vec3(0.0); float n = 0.0;
    int ri = int(R);
    for (int y = -12; y <= 12; ++y) {
        if (y < -ri || y > ri) continue;
        for (int x = -12; x <= 12; ++x) {
            if (x < -ri || x > ri) continue;
            vec2 d = vec2(float(x), float(y));
            float r2 = dot(d, d);
            if (r2 > R*R || r2 < 0.001) continue;
            float ang = atan(d.y, d.x);
            if (ang < 0.0) ang += 6.2831853;
            if (ang < a0 || ang >= a1) continue;
            vec3 c = texture(sTD2DInputs[0], uv + d * px).rgb;
            m  += c;
            m2 += c * c;
            n  += 1.0;
        }
    }
    if (n < 1.0) { m = texture(sTD2DInputs[0], uv).rgb; return vec4(m, 1e6); }
    m  /= n;
    m2 /= n;
    float v = dot(m2 - m*m, vec3(1.0));
    return vec4(m, max(v, 0.0));
}

vec3 kuwahara(vec2 uv, vec2 px) {
    int N = int(uSectors);
    float R = max(uRadius, 1.0);
    vec3 accum = vec3(0.0);
    float wsum = 0.0;
    float minV = 1e6;
    vec3  minM = texture(sTD2DInputs[0], uv).rgb;
    for (int s = 0; s < 8; ++s) {
        if (s >= N) break;
        vec4 st = sectorStats(uv, px, s, N, R);
        if (st.w < minV) { minV = st.w; minM = st.rgb; }
        float w = 1.0 / (1e-4 + pow(st.w, 8.0));
        accum += st.rgb * w;
        wsum  += w;
    }
    vec3 soft = wsum > 0.0 ? accum / wsum : minM;
    return mix(minM, soft, clamp(uSmoothness, 0.0, 1.0));
}

void main() {
    vec2 uv = vUV.st;
    vec2 px = 1.0 / uTD2DInfos[0].res.zw;
    vec4 orig = texture(sTD2DInputs[0], uv);
    vec3 k = kuwahara(uv, px);

    int mode = int(uMode);
    vec3 outCol;

    if (mode == 0) {
        outCol = k;
    } else if (mode == 1) {
        float lum = dot(k, vec3(0.299, 0.587, 0.114));
        float lL = dot(texture(sTD2DInputs[0], uv - vec2(px.x, 0.0)).rgb, vec3(0.299,0.587,0.114));
        float lR = dot(texture(sTD2DInputs[0], uv + vec2(px.x, 0.0)).rgb, vec3(0.299,0.587,0.114));
        float lU = dot(texture(sTD2DInputs[0], uv - vec2(0.0, px.y)).rgb, vec3(0.299,0.587,0.114));
        float lD = dot(texture(sTD2DInputs[0], uv + vec2(0.0, px.y)).rgb, vec3(0.299,0.587,0.114));
        float edge = clamp(length(vec2(lR - lL, lD - lU)) * 4.0, 0.0, 1.0);
        float graphite = (1.0 - lum) * edge;
        outCol = vec3(1.0 - graphite);
    } else {
        vec3 qv = floor(k * 6.0) / 6.0;
        float bleedR = texture(sTD2DInputs[0], uv + vec2( 2.0, 0.0) * px).r;
        float bleedB = texture(sTD2DInputs[0], uv + vec2(-2.0, 0.0) * px).b;
        outCol = vec3(mix(qv.r, bleedR, 0.25), qv.g, mix(qv.b, bleedB, 0.25));
    }

    fragColor = TDOutputSwizzle(vec4(mix(orig.rgb, outCol, clamp(uStrength, 0.0, 1.0)), orig.a));
}
`;

export const createNprFilterSchema = z.object({
  source_path: z
    .string()
    .describe(
      "Absolute path of an existing TOP to filter (e.g. '/project1/render1'). Pulled in via a Select TOP (no cross-COMP wire).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path to create the glslTOP + textDAT + nullTOP inside."),
  name: z
    .string()
    .default("npr1")
    .describe(
      "Base name for the glslTOP (textDAT becomes `<name>_frag`, output becomes `<name>_out`, source select becomes `<name>_src`).",
    ),
  mode: z
    .enum(["oil", "pencil", "watercolor"])
    .default("oil")
    .describe(
      "Painterly look. oil: full Kuwahara → flat color regions with preserved edges. pencil: luminance + edge-mag → graphite sketch. watercolor: quantize chroma + low-freq bleed.",
    ),
  radius: z
    .number()
    .min(1)
    .max(12)
    .default(4)
    .describe("Sampling radius in texels. Cost is O(radius² · sectors) — keep modest on 4K."),
  sectors: z
    .enum(["4", "8"])
    .default("8")
    .transform(Number)
    .describe(
      "Number of generalized-Kuwahara sectors. 8 = smoother painterly; 4 = classic Kuwahara (cheaper).",
    ),
  smoothness: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Blend between hard min-variance sector pick (0) and softmax-weighted average across sectors (1). Live control.",
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .default(1.0)
    .describe("Wet/dry mix between source (0) and filtered output (1). Live control."),
  resolution: z
    .enum(["input", "720p", "1080p", "4K"])
    .default("input")
    .describe(
      "Output resolution: 'input' inherits from the source (default), or '720p' (1280x720), '1080p' (1920x1080), '4K' (3840x2160).",
    ),
});
type CreateNprFilterArgs = z.infer<typeof createNprFilterSchema>;

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

const MODE_INT: Record<string, number> = { oil: 0, pencil: 1, watercolor: 2 };

/** Convert a snake_case or camelCase name into a PascalCase prefix, e.g. "kuwa_oil" → "KuwaOil", "npr1" → "Npr1". */
function toParamPrefix(name: string): string {
  return name
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export async function createNprFilterImpl(ctx: ToolContext, args: CreateNprFilterArgs) {
  return guardTd(
    async () => {
      const baseName = args.name;
      const prefix = toParamPrefix(baseName); // e.g. "npr1" → "Npr1"
      const select = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "selectTOP",
        name: `${baseName}_src`,
      });
      const frag = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "textDAT",
        name: `${baseName}_frag`,
      });
      const glsl = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "glslTOP",
        name: baseName,
      });
      const out = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "nullTOP",
        name: `${baseName}_out`,
      });

      // Set source TOP, shader text, pixeldat, custom params on parent, and the
      // Vector-page uniforms. Best-effort: hasattr guards keep missing-param cases
      // non-fatal (e.g. when parent already exposes the same controls under a
      // higher-level system like apply_post_processing).
      const modeInt = MODE_INT[args.mode] ?? 0;
      const setup = [
        `op(${q(select.path)}).par.top = ${q(args.source_path)}`,
        `op(${q(frag.path)}).text = ${q(NPR_SHADER)}`,
        `_g = op(${q(glsl.path)})`,
        `_g.par.pixeldat = ${q(frag.name || `${baseName}_frag`)}`,
        // Best-effort add custom parameters on the parent COMP — namespaced by
        // prefix so multiple NPR filter instances under the same parent don't
        // collide (e.g. "Npr1_Radius" vs "KuwaOil_Radius").
        `_parent = op(${q(args.parent_path)})`,
        `_prefix = ${q(prefix)}`,
        "try:",
        "    _page = None",
        "    for _p in _parent.customPages:",
        "        if _p.name == 'NPR':",
        "            _page = _p",
        "            break",
        "    if _page is None:",
        "        _page = _parent.appendCustomPage('NPR')",
        `    if not hasattr(_parent.par, _prefix + 'Radius'):`,
        `        _pr = _page.appendFloat(_prefix + 'Radius'); _pr[0].default = ${args.radius}; _pr[0].val = ${args.radius}; _pr[0].normMin = 1; _pr[0].normMax = 12`,
        `    if not hasattr(_parent.par, _prefix + 'Smoothness'):`,
        `        _ps = _page.appendFloat(_prefix + 'Smoothness'); _ps[0].default = ${args.smoothness}; _ps[0].val = ${args.smoothness}; _ps[0].normMin = 0; _ps[0].normMax = 1`,
        `    if not hasattr(_parent.par, _prefix + 'Strength'):`,
        `        _pst = _page.appendFloat(_prefix + 'Strength'); _pst[0].default = ${args.strength}; _pst[0].val = ${args.strength}; _pst[0].normMin = 0; _pst[0].normMax = 1`,
        "except Exception:",
        "    pass",
        // Vector-page uniforms — expressions reference the namespaced parent params.
        "_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 5)",
        `_g.par.vec0name = 'uMode'`,
        `_g.par.vec0valuex = ${modeInt}`,
        `_g.par.vec1name = 'uSectors'`,
        `_g.par.vec1valuex = ${args.sectors}`,
        `_g.par.vec2name = 'uRadius'`,
        `_g.par.vec2valuex.expr = ${q(`(parent().par.${prefix}Radius.eval() if hasattr(parent().par, '${prefix}Radius') else ${args.radius})`)}`,
        `_g.par.vec2valuex.mode = type(_g.par.vec2valuex.mode).EXPRESSION`,
        `_g.par.vec3name = 'uSmoothness'`,
        `_g.par.vec3valuex.expr = ${q(`(parent().par.${prefix}Smoothness.eval() if hasattr(parent().par, '${prefix}Smoothness') else ${args.smoothness})`)}`,
        `_g.par.vec3valuex.mode = type(_g.par.vec3valuex.mode).EXPRESSION`,
        `_g.par.vec4name = 'uStrength'`,
        `_g.par.vec4valuex.expr = ${q(`(parent().par.${prefix}Strength.eval() if hasattr(parent().par, '${prefix}Strength') else ${args.strength})`)}`,
        `_g.par.vec4valuex.mode = type(_g.par.vec4valuex.mode).EXPRESSION`,
      ].join("\n");

      await ctx.client.executePythonScript(setup, false);

      // Wiring: select → glsl → null. connectNodes() tries the first-class
      // /api/connect endpoint and falls back to Python on the bridge side.
      await connectNodesViaBridge(ctx.client, select.path, glsl.path, 0, 0);
      await connectNodesViaBridge(ctx.client, glsl.path, out.path, 0, 0);

      if (args.resolution !== "input") {
        const [width, height] = RESOLUTIONS[args.resolution];
        await ctx.client.updateNodeParameters(glsl.path, {
          outputresolution: "custom",
          resolutionw: width,
          resolutionh: height,
        });
      }

      return {
        glsl_path: glsl.path,
        output_path: out.path,
        frag_dat: frag.path,
        source_select: select.path,
        controls: [`${prefix}Radius`, `${prefix}Smoothness`, `${prefix}Strength`],
        mode: args.mode,
        sectors: args.sectors,
        radius: args.radius,
        smoothness: args.smoothness,
        strength: args.strength,
        glsl_compile_verified: false,
      };
    },
    (result) =>
      jsonResult(
        `Created NPR (${result.mode}, sectors=${result.sectors}, radius=${result.radius}) filtering ${args.source_path} → ${result.output_path}. GLSL compile UNVERIFIED (TD offline at build time).`,
        result,
      ),
  );
}

export const registerCreateNprFilter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_npr_filter",
    {
      title: "Create NPR painterly filter",
      description:
        "Apply a non-photorealistic painterly filter to an existing TOP. A generalized Kuwahara (sector-based local variance smoothing) runs in a single GLSL TOP and branches into three looks selected by `mode`: oil (flat color regions, preserved edges), pencil (graphite sketch via luminance × edge magnitude), or watercolor (quantized chroma + low-frequency bleed). Creates a Select TOP → GLSL TOP → Null TOP chain under `parent_path` and exposes Radius / Smoothness / Strength as custom parent params bound by expression for live tweaking. Returns the GLSL TOP path, the bind-ready output null path, the fragment DAT path, exposed controls, and an `glsl_compile_verified` flag (always false offline — verify post-cook with `get_td_node_errors`).",
      inputSchema: createNprFilterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createNprFilterImpl(ctx, args),
  );
};
