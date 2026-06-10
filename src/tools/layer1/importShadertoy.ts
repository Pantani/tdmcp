import { z } from "zod";
import {
  applyGlslTopMapping,
  applyShadertoyUniforms,
  type ShaderProvenance,
} from "../foundation/glslTopMapping.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema (spec §3)
// ─────────────────────────────────────────────────────────────────────────────

const channelOverrideSchema = z.object({
  index: z.number().int().min(0).max(3),
  source: z
    .union([
      z.string(),
      z.object({
        kind: z.literal("noise"),
        resolution: z.tuple([z.number(), z.number()]).optional(),
      }),
      z.object({
        kind: z.literal("ramp"),
        resolution: z.tuple([z.number(), z.number()]).optional(),
      }),
      z.object({
        kind: z.literal("constant"),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      }),
    ])
    .optional(),
  filter: z.enum(["nearest", "linear", "mipmap"]).optional(),
  extend: z.enum(["hold", "zero", "repeat", "mirror"]).optional(),
});

const provenanceOverrideSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  url: z.string().optional(),
});

/** Base object schema (used by registerTool for `.shape`). */
export const importShadertoyBaseSchema = z.object({
  shader_id: z.string().optional().describe("Shadertoy 6-char ID, e.g. 'XsXXDn'."),
  url: z.string().optional().describe("Full Shadertoy URL: https://www.shadertoy.com/view/<id>."),
  raw_source: z
    .string()
    .optional()
    .describe("Pasted Shadertoy-style fragment (must contain mainImage). Offline-safe."),
  parent_path: z.string().default("/project1"),
  name: z.string().default("shadertoy"),
  resolution: z.tuple([z.number().int(), z.number().int()]).default([1280, 720]),
  pixel_format: z.enum(["rgba8", "rgba16", "rgba32"]).default("rgba8"),
  channels: z.array(channelOverrideSchema).max(4).default([]),
  expose_mouse_control: z.boolean().default(false),
  expose_speed_control: z.boolean().default(true),
  capture_preview: z.boolean().default(true),
  provenance_override: provenanceOverrideSchema.optional(),
});

/** Refined schema enforcing the XOR rule on shader_id/url/raw_source. */
export const importShadertoySchema = importShadertoyBaseSchema.refine(
  (v) => [v.shader_id, v.url, v.raw_source].filter((x) => x !== undefined && x !== "").length === 1,
  {
    message:
      "Provide exactly one of `shader_id`, `url`, or `raw_source` (mutually exclusive, one required).",
  },
);

export type ImportShadertoyArgs = z.infer<typeof importShadertoyBaseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Resolver (spec §4)
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedShader {
  fragment: string;
  provenance: ShaderProvenance;
  warnings: string[];
}

class ResolveError extends Error {}

const SHADER_ID_RE = /\/view\/([A-Za-z0-9]{4,8})/;

function mergeProvenanceOverride(
  base: ShaderProvenance,
  override: ImportShadertoyArgs["provenance_override"],
): ShaderProvenance {
  if (!override) return base;
  return {
    ...base,
    ...(override.title !== undefined ? { sourceTitle: override.title } : {}),
    ...(override.author !== undefined ? { sourceAuthor: override.author } : {}),
    ...(override.license !== undefined ? { license: override.license } : {}),
    ...(override.url !== undefined ? { sourceUrl: override.url } : {}),
  };
}

async function fetchShaderById(
  shaderId: string,
  ctx: ToolContext,
): Promise<{
  fragment: string;
  provenance: ShaderProvenance;
  warnings: string[];
}> {
  if (process.env.TDMCP_OFFLINE === "1") {
    throw new ResolveError(
      "Shadertoy fetch disabled by TDMCP_OFFLINE. Paste the GLSL into `raw_source` instead.",
    );
  }

  const apiKey = process.env.TDMCP_SHADERTOY_KEY;
  const url = apiKey
    ? `https://www.shadertoy.com/api/v1/shaders/${encodeURIComponent(shaderId)}?key=${encodeURIComponent(apiKey)}`
    : `https://www.shadertoy.com/api/v1/shaders/${encodeURIComponent(shaderId)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    ctx.logger.debug("shadertoy fetch failed", { err: String(err) });
    throw new ResolveError(
      "Could not reach the Shadertoy API. Paste the GLSL into `raw_source` instead, or set TDMCP_SHADERTOY_KEY and retry.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ResolveError(
      `Shadertoy API returned ${response.status}. Paste the GLSL into \`raw_source\` instead, or set TDMCP_SHADERTOY_KEY and retry.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new ResolveError(
      "Shadertoy API returned a non-JSON response (likely rate-limited or missing key). Paste the GLSL into `raw_source` instead.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    ctx.logger.debug("shadertoy json parse failed", { err: String(err) });
    throw new ResolveError(
      "Could not parse Shadertoy API response. Paste the GLSL into `raw_source` instead.",
    );
  }

  const shader = (payload as { Shader?: unknown })?.Shader as
    | {
        info?: { name?: string; username?: string };
        renderpass?: Array<{ code?: string; type?: string; name?: string }>;
      }
    | undefined;
  if (!shader || !Array.isArray(shader.renderpass) || shader.renderpass.length === 0) {
    throw new ResolveError(
      "Shadertoy API response had no renderpasses. Paste the GLSL into `raw_source` instead.",
    );
  }

  const passes = shader.renderpass;
  const first = passes[0];
  const code = first?.code;
  if (!code || typeof code !== "string") {
    throw new ResolveError(
      "Shadertoy renderpass[0] is missing fragment code. Paste the GLSL into `raw_source` instead.",
    );
  }

  if (/\bmainSound\s*\(/.test(code)) {
    throw new ResolveError("Shadertoy sound shaders are not yet supported; use the Image pass.");
  }

  const warnings: string[] = [];
  if (passes.length > 1) {
    warnings.push(
      `multi-pass shader: dropped ${passes.length - 1} additional passes (wave 1 supports the Image pass only).`,
    );
  }

  const provenance: ShaderProvenance = {
    dialect: "shadertoy",
    sourceUrl: `https://www.shadertoy.com/view/${shaderId}`,
    ...(shader.info?.name ? { sourceTitle: shader.info.name } : {}),
    ...(shader.info?.username ? { sourceAuthor: shader.info.username } : {}),
    license: "CC BY-NC-SA 3.0 (Shadertoy default — verify)",
  };

  return { fragment: code, provenance, warnings };
}

export async function resolveShadertoySource(
  args: Pick<ImportShadertoyArgs, "shader_id" | "url" | "raw_source" | "provenance_override">,
  ctx: ToolContext,
): Promise<ResolvedShader> {
  if (args.raw_source) {
    const provenance = mergeProvenanceOverride({ dialect: "shadertoy" }, args.provenance_override);
    return { fragment: args.raw_source, provenance, warnings: [] };
  }

  let shaderId: string | undefined = args.shader_id;
  if (!shaderId && args.url) {
    const match = SHADER_ID_RE.exec(args.url);
    if (!match?.[1]) {
      throw new ResolveError(
        `Could not extract a Shadertoy ID from URL: ${args.url}. Expected https://www.shadertoy.com/view/<id>.`,
      );
    }
    shaderId = match[1];
  }
  if (!shaderId) {
    throw new ResolveError("Provide exactly one of `shader_id`, `url`, or `raw_source`.");
  }

  const fetched = await fetchShaderById(shaderId, ctx);
  const provenance = mergeProvenanceOverride(fetched.provenance, args.provenance_override);
  return { fragment: fetched.fragment, provenance, warnings: fetched.warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Impl (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

export async function importShadertoyImpl(ctx: ToolContext, args: ImportShadertoyArgs) {
  let resolved: ResolvedShader;
  try {
    resolved = await resolveShadertoySource(args, ctx);
  } catch (err) {
    if (err instanceof ResolveError) return errorResult(err.message);
    return errorResult(`Failed to resolve Shadertoy source: ${String(err)}`);
  }

  return runBuild(async () => {
    const mapping = applyShadertoyUniforms({
      fragment: resolved.fragment,
      channels: args.channels,
      exposeSpeedControl: args.expose_speed_control,
      exposeMouseControl: args.expose_mouse_control,
      provenance: resolved.provenance,
    });
    mapping.warnings.unshift(...resolved.warnings);

    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const { glslPath, outputPath, resolvedControls } = await applyGlslTopMapping(builder, mapping, {
      resolution: args.resolution,
      pixelFormat: args.pixel_format,
    });

    const titleLabel = resolved.provenance.sourceTitle ?? "(raw)";
    return finalize(ctx, {
      summary: `Imported Shadertoy ${titleLabel} as GLSL TOP.`,
      builder,
      outputPath,
      controls: resolvedControls,
      capturePreviewImage: args.capture_preview,
      extra: {
        glslPath,
        provenance: resolved.provenance,
        mappingWarnings: mapping.warnings,
      },
    });
  });
}

export const registerImportShadertoy: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "import_shadertoy",
    {
      title: "Import Shadertoy",
      description:
        "Build a GLSL TOP from a Shadertoy URL, ID, or pasted source. Wires iChannels (defaulting to noise placeholders), exposes Speed (and optional Mouse) controls, and captures a preview. First fetch on macOS may trigger an outgoing-connection permission prompt. Set TDMCP_SHADERTOY_KEY for reliable fetches; paste into raw_source to stay offline.",
      inputSchema: importShadertoyBaseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => importShadertoyImpl(ctx, args),
  );
};
