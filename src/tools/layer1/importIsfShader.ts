import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  applyGlslTopMapping,
  buildIsfMapping,
  type IsfInput,
} from "../foundation/glslTopMapping.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const channelOverrideSchema = z.object({
  index: z.number().int().min(0).max(3),
  source_path: z.string().min(1),
});

export const importIsfShaderSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe("ISF (.fs) source: raw shader text, a local file path, or an http(s) URL."),
  source_kind: z
    .enum(["auto", "raw", "file", "url"])
    .default("auto")
    .describe("Override the source sniffer; 'raw' skips IO."),
  parent_path: z.string().default("/project1").describe("Container parent COMP path."),
  name: z
    .string()
    .optional()
    .describe("System container name (sanitized). Defaults to ISF DESCRIPTION or 'isf_shader'."),
  resolution: z
    .tuple([z.number().int().min(2).max(16384), z.number().int().min(2).max(16384)])
    .default([1280, 720])
    .describe("GLSL TOP output resolution [width, height]."),
  pixel_format: z.enum(["rgba8", "rgba16", "rgba32"]).default("rgba8"),
  channel_overrides: z
    .array(channelOverrideSchema)
    .default([])
    .describe("Override default placeholder noise for ISF image/audio inputs."),
  control_defaults: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Override the ISF DEFAULT for any input at build time."),
  expose_controls: z.boolean().default(true),
  capture_preview: z.boolean().default(true),
  fetch_timeout_ms: z.number().int().min(100).max(120000).default(8000),
});

type Args = z.infer<typeof importIsfShaderSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Loose ISF header shape (Zod, optional fields pass-through)
// ─────────────────────────────────────────────────────────────────────────────

const isfHeaderSchema = z
  .object({
    DESCRIPTION: z.string().optional(),
    CREDIT: z.string().optional(),
    CATEGORIES: z.array(z.string()).optional(),
    VSN: z.string().optional(),
    ISFVSN: z.string().optional(),
    INPUTS: z.array(z.unknown()).optional(),
    PASSES: z.array(z.unknown()).optional(),
    IMPORTED: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface IsfHeader {
  DESCRIPTION?: string;
  CREDIT?: string;
  CATEGORIES?: string[];
  VSN?: string;
  ISFVSN?: string;
  INPUTS?: IsfInput[];
  PASSES?: unknown[];
  IMPORTED?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header parser (hand-written, char-scanner, NOT regex)
// ─────────────────────────────────────────────────────────────────────────────

export type ExtractIsfHeaderResult =
  | {
      ok: true;
      header: IsfHeader;
      body: string;
      rawJson: string;
      headerSpan: [number, number];
      warnings: string[];
    }
  | { ok: false; error: string };

export function extractIsfHeader(source: string): ExtractIsfHeaderResult {
  // Strip UTF-8 BOM if present.
  let src = source;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const len = src.length;
  let i = 0;

  // 1. Skip leading whitespace + line comments.
  while (i < len) {
    const c = src.charCodeAt(i);
    // whitespace (space, tab, CR, LF)
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i += 1;
      continue;
    }
    // "//" line comment
    if (c === 0x2f && src.charCodeAt(i + 1) === 0x2f) {
      i += 2;
      while (i < len && src.charCodeAt(i) !== 0x0a) i += 1;
      continue;
    }
    break;
  }

  // 2. Require `/*` followed (after optional whitespace) by `{`.
  if (i >= len || src.charCodeAt(i) !== 0x2f || src.charCodeAt(i + 1) !== 0x2a) {
    return {
      ok: false,
      error: "ISF metadata block /*{...}*/ not found at top of source",
    };
  }
  const blockStart = i;
  i += 2; // skip "/*"
  // skip whitespace between "/*" and "{"
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= len || src.charCodeAt(i) !== 0x7b) {
    return {
      ok: false,
      error: "ISF metadata block /*{...}*/ not found at top of source",
    };
  }

  // 3. Scan to matching `}*/`, tracking brace depth + string state.
  const jsonStart = i; // points at the opening "{"
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonEnd = -1; // exclusive — points just past the matching `}`
  for (; i < len; i += 1) {
    const ch = src.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === 0x5c) {
        escaped = true;
        continue;
      }
      if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) {
      inString = true;
      continue;
    }
    if (ch === 0x7b) {
      depth += 1;
      continue;
    }
    if (ch === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        i += 1;
        break;
      }
    }
  }
  if (jsonEnd < 0) {
    return {
      ok: false,
      error: "ISF metadata block /*{...}*/ not found at top of source (unterminated JSON)",
    };
  }
  // Skip whitespace, expect `*/`.
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i += 1;
      continue;
    }
    break;
  }
  if (i + 1 >= len || src.charCodeAt(i) !== 0x2a || src.charCodeAt(i + 1) !== 0x2f) {
    return {
      ok: false,
      error: "ISF metadata block /*{...}*/ not found at top of source (missing closing */)",
    };
  }
  const blockEnd = i + 2;

  // 4. Slice + parse JSON.
  const rawJson = src.slice(jsonStart, jsonEnd);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ISF JSON header parse failed: ${msg}` };
  }

  // 5. Validate shape (loose).
  const validated = isfHeaderSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      error: `ISF JSON header parse failed: ${validated.error.message}`,
    };
  }
  const header = validated.data as IsfHeader;

  // 6. Build warnings.
  const warnings: string[] = [];
  if (Array.isArray(header.PASSES) && header.PASSES.length > 1) {
    warnings.push(
      "Multi-pass ISF shader: only the final pass is rendered (multi-pass support deferred).",
    );
  }
  if (header.IMPORTED && Object.keys(header.IMPORTED).length > 0) {
    warnings.push("ISF IMPORTED textures not yet supported; provide channel_overrides instead.");
  }
  const validInputs: IsfInput[] = [];
  const allowedTypes = new Set([
    "float",
    "long",
    "bool",
    "color",
    "point2D",
    "event",
    "image",
    "audio",
    "audioFFT",
  ]);
  for (const raw of header.INPUTS ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const inp = raw as unknown as Record<string, unknown>;
    const name = typeof inp.NAME === "string" ? inp.NAME : undefined;
    const type = typeof inp.TYPE === "string" ? inp.TYPE : undefined;
    if (!name || !type) continue;
    if (!allowedTypes.has(type)) {
      warnings.push(`Unsupported ISF input type '${type}' on '${name}' — control omitted.`);
      continue;
    }
    if (type === "audio" || type === "audioFFT") {
      warnings.push(
        `ISF audio input '${name}' wired as a placeholder; live audio routing deferred.`,
      );
      // Treat as image-channel placeholder for the foundation mapper.
      validInputs.push({ ...(inp as unknown as IsfInput), NAME: name, TYPE: "image" });
      continue;
    }
    validInputs.push(inp as unknown as IsfInput);
  }
  header.INPUTS = validInputs;

  const body = src.slice(blockEnd);
  return {
    ok: true,
    header,
    body,
    rawJson,
    headerSpan: [blockStart, blockEnd],
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Control-default merging (in-place override of INPUTS[].DEFAULT)
// ─────────────────────────────────────────────────────────────────────────────

export function applyControlDefaults(
  inputs: ReadonlyArray<IsfInput>,
  overrides: Record<string, unknown>,
): { inputs: IsfInput[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: IsfInput[] = inputs.map((i) => ({ ...i }));
  for (const [key, raw] of Object.entries(overrides)) {
    const target = out.find((i) => i.NAME === key);
    if (!target) {
      warnings.push(`control_defaults: input '${key}' not declared by ISF header — ignored.`);
      continue;
    }
    if (!isCompatibleDefault(target.TYPE, raw)) {
      warnings.push(
        `control_defaults: value for '${key}' does not match TYPE '${target.TYPE}' — ignored.`,
      );
      continue;
    }
    target.DEFAULT = raw as IsfInput["DEFAULT"];
  }
  return { inputs: out, warnings };
}

function isCompatibleDefault(type: IsfInput["TYPE"], value: unknown): boolean {
  switch (type) {
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "long":
      return typeof value === "number" && Number.isInteger(value);
    case "bool":
      return typeof value === "boolean";
    case "color":
      return (
        Array.isArray(value) &&
        (value.length === 3 || value.length === 4) &&
        value.every((v) => typeof v === "number")
      );
    case "point2D":
      return (
        Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")
      );
    case "event":
    case "image":
      return false;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source resolution
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedSource {
  raw: string;
  provenance: { sourceUrl?: string; sourceTitle?: string; sourceAuthor?: string };
}

async function resolveIsfSource(args: Args): Promise<ResolvedSource> {
  const kind = sniffSourceKind(args.source, args.source_kind);
  if (kind === "raw") {
    return { raw: args.source, provenance: {} };
  }
  if (kind === "file") {
    const abs = path.isAbsolute(args.source) ? args.source : path.resolve(args.source);
    const raw = await fs.readFile(abs, "utf8");
    return { raw, provenance: { sourceUrl: `file://${abs}` } };
  }
  // url
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
  const timeoutCtor = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeoutCtor === "function") {
    signal = timeoutCtor(args.fetch_timeout_ms);
  } else {
    controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), args.fetch_timeout_ms);
    signal = controller.signal;
  }
  try {
    const res = await fetch(args.source, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ISF source from ${args.source}`);
    }
    const raw = await res.text();
    return { raw, provenance: { sourceUrl: args.source } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sniffSourceKind(source: string, kind: Args["source_kind"]): "raw" | "file" | "url" {
  if (kind === "raw" || kind === "file" || kind === "url") return kind;
  if (source.startsWith("http://") || source.startsWith("https://")) return "url";
  const hasBlock = source.includes("/*{");
  const hasMain = /void\s+main/.test(source);
  if (hasBlock && hasMain) return "raw";
  if (source.startsWith("/") || (source.includes(".fs") && !hasMain)) return "file";
  if (hasBlock) return "raw";
  throw new Error("Could not detect ISF source kind; pass source_kind explicitly.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Name sanitization
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  let out = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
  out = out.replace(/^_+|_+$/g, "");
  if (!out) out = "isf_shader";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out.slice(0, 64);
}

// ─────────────────────────────────────────────────────────────────────────────
// Impl
// ─────────────────────────────────────────────────────────────────────────────

export async function importIsfShaderImpl(ctx: ToolContext, args: Args) {
  let resolved: ResolvedSource;
  try {
    resolved = await resolveIsfSource(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to resolve ISF source: ${msg}`);
  }

  const parsed = extractIsfHeader(resolved.raw);
  if (!parsed.ok) {
    return errorResult(parsed.error);
  }
  const { header, body, warnings: parseWarnings } = parsed;
  const merged = applyControlDefaults(header.INPUTS ?? [], args.control_defaults);

  return runBuild(async () => {
    const mapping = buildIsfMapping({
      fragment: body,
      inputs: merged.inputs,
      channelOverrides: args.channel_overrides.map((o) => ({
        index: o.index,
        source: o.source_path,
      })),
      provenance: {
        dialect: "isf",
        sourceUrl: resolved.provenance.sourceUrl,
        sourceTitle: header.DESCRIPTION ?? resolved.provenance.sourceTitle,
        sourceAuthor: header.CREDIT ?? resolved.provenance.sourceAuthor,
      },
    });
    mapping.warnings.push(...parseWarnings, ...merged.warnings);

    const name = sanitizeName(args.name ?? header.DESCRIPTION ?? "isf_shader");
    const builder = await createSystemContainer(ctx, args.parent_path, name);
    const { glslPath, outputPath, resolvedControls } = await applyGlslTopMapping(builder, mapping, {
      resolution: args.resolution,
      pixelFormat: args.pixel_format,
    });
    return finalize(ctx, {
      summary: `Imported ISF shader '${header.DESCRIPTION ?? name}'.`,
      builder,
      outputPath,
      controls: args.expose_controls ? resolvedControls : [],
      capturePreviewImage: args.capture_preview,
      extra: {
        glslPath,
        provenance: mapping.provenance,
        mappingWarnings: mapping.warnings,
        inputsCount: merged.inputs.length,
      },
    });
  });
}

export const registerImportIsfShader: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "import_isf_shader",
    {
      title: "Import ISF shader",
      description:
        "Import an ISF (.fs) shader into TouchDesigner as a GLSL TOP with auto-generated controls. Accepts raw source, a local file path, or an http(s) URL.",
      inputSchema: importIsfShaderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => importIsfShaderImpl(ctx, args),
  );
};
