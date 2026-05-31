import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ImagePart, LlmClientLike } from "../../llm/client.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { applyPostProcessingImpl, applyPostProcessingSchema } from "./applyPostProcessing.js";
import { createAudioReactiveImpl, createAudioReactiveSchema } from "./createAudioReactive.js";
import { createFeedbackTunnelImpl, createFeedbackTunnelSchema } from "./createFeedbackTunnel.js";
import { createGenerativeArtImpl, createGenerativeArtSchema } from "./createGenerativeArt.js";
import {
  createGpuParticleFieldImpl,
  createGpuParticleFieldSchema,
} from "./createGpuParticleField.js";
import { createParticleFlockImpl, createParticleFlockSchema } from "./createParticleFlock.js";

/**
 * moodboard_to_system — multimodal LLM-grounded system generator.
 *
 * Reads 1..6 moodboard images, asks a vision-capable LLM for a palette + motion
 * descriptors + generator pick, then orchestrates the chosen Layer-1 generator
 * (and optional post-processing). Falls back to a deterministic grammar when no
 * LLM is configured / the call fails / the JSON is invalid.
 *
 * Note: no in-process pixel decoder is bundled (would require `sharp` or a pure-JS
 * decoder dep). The grammar palette therefore returns a fixed neutral 5-color
 * palette when no LLM ran; integrator may add a pure-JS decoder later.
 */

const GENERATORS = [
  "audio_reactive",
  "generative_art",
  "particle_flock",
  "feedback_tunnel",
  "gpu_particle_field",
] as const;
type Generator = (typeof GENERATORS)[number];

const TECHNIQUES = [
  "fractal",
  "flow_field",
  "lissajous",
  "voronoi",
  "reaction_diffusion",
  "wave",
] as const;
type Technique = (typeof TECHNIQUES)[number];

const POST_FX = [
  "bloom",
  "chromatic_aberration",
  "film_grain",
  "color_grade",
  "vignette",
  "feedback_trail",
] as const;
type PostFx = (typeof POST_FX)[number];

const STYLES = ["auto", "cinematic", "minimal", "glitch", "organic", "retro", "brutalist"] as const;

export const moodboardToSystemSchema = z.object({
  images: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe(
      "Image paths (absolute or cwd-relative). Vault refs allowed when TDMCP_VAULT_PATH is set: e.g. 'Moodboards/foo.png'.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to build the generated subsystem in."),
  style: z.enum(STYLES).default("auto").describe("Hint that biases generator + post-FX choice."),
  intensity: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("Drives evolution_speed / particle counts / feedback gain on the chosen generator."),
  includePostFx: z
    .boolean()
    .default(true)
    .describe("Chain apply_post_processing with picked effects after the generator builds."),
  generator: z
    .enum(["auto", ...GENERATORS])
    .default("auto")
    .describe("Force a generator. 'auto' lets the LLM/grammar pick."),
  preferLlm: z
    .boolean()
    .default(true)
    .describe("When false, skip the LLM entirely and use the deterministic grammar."),
});

export type MoodboardToSystemArgs = z.infer<typeof moodboardToSystemSchema>;

type Source = "llm" | "grammar" | "llm-fallback-to-grammar";

interface MoodboardPlan {
  palette: string[];
  mood: string;
  motion: "still" | "drift" | "pulse" | "chaos" | "flow";
  texture: "smooth" | "grain" | "glitch" | "organic" | "geometric";
  generator: Generator;
  technique: Technique;
  evolution_speed: number;
  post_fx: PostFx[];
}

interface ResultPayload {
  source: Source;
  plan: MoodboardPlan;
  generator: Generator;
  palette: string[];
  post_fx_applied: PostFx[];
  systemPath?: string;
  warnings: string[];
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PALETTE = ["#0a0a0a", "#f2f2f2", "#ff5e3a", "#2a6cff", "#94f0c8"];

const MoodboardPlanSchema = z.object({
  palette: z
    .array(z.string().regex(/^#?[0-9a-fA-F]{6}$/))
    .min(3)
    .max(6),
  mood: z.string().max(80).default(""),
  motion: z.enum(["still", "drift", "pulse", "chaos", "flow"]).default("drift"),
  texture: z.enum(["smooth", "grain", "glitch", "organic", "geometric"]).default("smooth"),
  generator: z.enum(GENERATORS),
  technique: z.enum(TECHNIQUES).default("flow_field"),
  evolution_speed: z.number().min(0).max(1).default(0.5),
  post_fx: z.array(z.enum(POST_FX)).max(3).default([]),
});

// ---------- System prompt ----------

const SYSTEM_PROMPT = [
  "You are a visual-direction extractor for TouchDesigner.",
  "Given 1..6 moodboard images and an optional style hint, return ONE JSON object",
  "matching this schema EXACTLY. No prose, no markdown fences.",
  "",
  "{",
  '  "palette": ["#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB"],',
  '  "mood": "string (<=12 words)",',
  '  "motion": "still"|"drift"|"pulse"|"chaos"|"flow",',
  '  "texture": "smooth"|"grain"|"glitch"|"organic"|"geometric",',
  '  "generator": "audio_reactive"|"generative_art"|"particle_flock"|"feedback_tunnel"|"gpu_particle_field",',
  '  "technique": "fractal"|"flow_field"|"lissajous"|"voronoi"|"reaction_diffusion"|"wave",',
  '  "evolution_speed": 0.0..1.0,',
  '  "post_fx": ["bloom","chromatic_aberration","film_grain","color_grade","vignette","feedback_trail"]',
  "}",
].join("\n");

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function normalizeHex(c: string): string {
  return c.startsWith("#") ? c.toLowerCase() : `#${c.toLowerCase()}`;
}

// ---------- Image loading ----------

function mimeFromExt(p: string): string | undefined {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

function resolveImagePath(ctx: ToolContext, ref: string): string {
  if (path.isAbsolute(ref)) return ref;
  if (ctx.vault) {
    // Treat unknown refs starting with 'Moodboards/' or a non-relative name as vault paths.
    const looksVault =
      ref.startsWith("Moodboards/") || (!ref.startsWith("./") && !ref.startsWith("../"));
    if (looksVault) {
      try {
        const abs = ctx.vault.resolve(ref);
        if (abs) return abs;
      } catch {
        // fall through to cwd
      }
    }
  }
  return path.resolve(process.cwd(), ref);
}

async function loadImages(
  ctx: ToolContext,
  refs: string[],
): Promise<{ parts: ImagePart[] } | { error: string }> {
  const parts: ImagePart[] = [];
  for (const ref of refs) {
    const mimeType = mimeFromExt(ref);
    if (!mimeType) {
      return { error: `Unsupported image type: ${ref} (need .png/.jpg/.jpeg/.webp).` };
    }
    const abs = resolveImagePath(ctx, ref);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      return { error: `Could not read image ${ref}: ${(err as Error).message}` };
    }
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return {
        error: `Image ${ref} is ${Math.round(buf.byteLength / 1024 / 1024)}MB; cap is ${
          MAX_IMAGE_BYTES / 1024 / 1024
        }MB. Downscale and retry.`,
      };
    }
    parts.push({ type: "image", data: buf.toString("base64"), mimeType });
  }
  return { parts };
}

// ---------- LLM path ----------

async function tryLlm(
  llm: LlmClientLike,
  args: MoodboardToSystemArgs,
  images: ImagePart[],
): Promise<{ plan: MoodboardPlan } | { error: string }> {
  let res: Awaited<ReturnType<LlmClientLike["complete"]>>;
  try {
    res = await llm.complete(
      [
        { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
        {
          role: "user",
          content: [
            { type: "text", text: `style=${args.style}, intensity=${args.intensity}` },
            ...images,
          ],
        },
      ],
      { temperature: 0.2, maxTokens: 400, timeoutMs: 25_000 },
    );
  } catch (err) {
    return { error: `LLM call failed: ${(err as Error).message}` };
  }
  const text = stripJsonFence(res.text ?? "");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `LLM returned invalid JSON (${(err as Error).message})` };
  }
  const parsed = MoodboardPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "LLM JSON did not match MoodboardPlanSchema" };
  }
  const palette = parsed.data.palette.map(normalizeHex);
  const plan: MoodboardPlan = {
    palette,
    mood: parsed.data.mood,
    motion: parsed.data.motion,
    texture: parsed.data.texture,
    generator: parsed.data.generator,
    technique: parsed.data.technique,
    evolution_speed: parsed.data.evolution_speed,
    post_fx: parsed.data.post_fx,
  };
  return { plan };
}

// ---------- Grammar fallback ----------

interface StyleProfile {
  generator: Generator;
  technique: Technique;
  motion: MoodboardPlan["motion"];
  texture: MoodboardPlan["texture"];
  post_fx: PostFx[];
}

const STYLE_TABLE: Record<(typeof STYLES)[number], StyleProfile> = {
  auto: {
    generator: "generative_art",
    technique: "flow_field",
    motion: "drift",
    texture: "smooth",
    post_fx: ["bloom", "color_grade"],
  },
  cinematic: {
    generator: "generative_art",
    technique: "flow_field",
    motion: "drift",
    texture: "smooth",
    post_fx: ["bloom", "color_grade", "film_grain"],
  },
  minimal: {
    generator: "generative_art",
    technique: "lissajous",
    motion: "drift",
    texture: "smooth",
    post_fx: [],
  },
  glitch: {
    generator: "feedback_tunnel",
    technique: "wave",
    motion: "chaos",
    texture: "glitch",
    post_fx: ["chromatic_aberration", "feedback_trail"],
  },
  organic: {
    generator: "particle_flock",
    technique: "flow_field",
    motion: "flow",
    texture: "organic",
    post_fx: ["bloom"],
  },
  retro: {
    generator: "generative_art",
    technique: "voronoi",
    motion: "pulse",
    texture: "grain",
    post_fx: ["film_grain", "vignette"],
  },
  brutalist: {
    generator: "gpu_particle_field",
    technique: "wave",
    motion: "pulse",
    texture: "geometric",
    post_fx: ["color_grade"],
  },
};

function grammarPlan(args: MoodboardToSystemArgs): MoodboardPlan {
  const prof = STYLE_TABLE[args.style];
  return {
    palette: [...DEFAULT_PALETTE],
    mood: `${args.style} mood`,
    motion: prof.motion,
    texture: prof.texture,
    generator: prof.generator,
    technique: prof.technique,
    evolution_speed: args.intensity,
    post_fx: [...prof.post_fx],
  };
}

// ---------- Generator dispatch ----------

/**
 * Best-effort extraction of the container path from a downstream Layer-1 result.
 * Layer-1 tools emit a text part containing a ```json fence``` whose object has
 * a "container" field (orchestration.finalize). We pull that out so we can chain
 * apply_post_processing's `source_path`.
 */
function extractContainerPath(result: unknown): string | undefined {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const first = r?.content?.find((c) => c.type === "text");
  const text = first?.text;
  if (!text) return undefined;
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  const body = fence?.[1] ?? text;
  try {
    // Try to parse the fenced JSON; if the whole text is JSON object, that works too.
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first < 0 || last <= first) return undefined;
    const parsed = JSON.parse(body.slice(first, last + 1)) as {
      container?: unknown;
      output?: unknown;
    };
    if (typeof parsed.container === "string") return parsed.container;
    if (typeof parsed.output === "string") {
      // Output is "<container>/out1" — strip last segment.
      const idx = parsed.output.lastIndexOf("/");
      if (idx > 0) return parsed.output.slice(0, idx);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface DispatchDeps {
  createAudioReactive: typeof createAudioReactiveImpl;
  createGenerativeArt: typeof createGenerativeArtImpl;
  createParticleFlock: typeof createParticleFlockImpl;
  createFeedbackTunnel: typeof createFeedbackTunnelImpl;
  createGpuParticleField: typeof createGpuParticleFieldImpl;
  applyPostProcessing: typeof applyPostProcessingImpl;
}

/**
 * Build args for the chosen downstream generator. Uses each *Schema*'s `safeParse`
 * to drop unknown keys, so spec drift can't throw — required-but-missing fields
 * surface as a plan warning, not a crash.
 */
function buildGeneratorArgs(
  plan: MoodboardPlan,
  args: MoodboardToSystemArgs,
): { kind: Generator; args: Record<string, unknown> } | { kind: Generator; error: string } {
  const { generator } = plan;
  const palette_hint = plan.palette.join(", ");
  switch (generator) {
    case "audio_reactive": {
      const candidate = {
        parent_path: args.parent_path,
        visual_style: "glsl" as const,
        audio_source: "microphone" as const,
      };
      const parsed = createAudioReactiveSchema.safeParse(candidate);
      return parsed.success
        ? { kind: generator, args: parsed.data }
        : { kind: generator, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
    }
    case "generative_art": {
      const candidate = {
        technique: plan.technique === "fractal" ? "fractal" : plan.technique,
        color_palette: palette_hint,
        evolution_speed: Math.max(0.1, plan.evolution_speed * 2),
        parent_path: args.parent_path,
      };
      const parsed = createGenerativeArtSchema.safeParse(candidate);
      if (parsed.success) return { kind: generator, args: parsed.data };
      // Fallback to a definitely-valid technique if plan's technique isn't in the
      // generator's enum (e.g. "wave"/"lissajous").
      const retry = createGenerativeArtSchema.safeParse({
        technique: "fractal",
        color_palette: palette_hint,
        evolution_speed: Math.max(0.1, plan.evolution_speed * 2),
        parent_path: args.parent_path,
      });
      return retry.success
        ? { kind: generator, args: retry.data }
        : { kind: generator, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
    }
    case "particle_flock": {
      // count is the edge length (8..256). Map intensity → 24..200.
      const edge = Math.round(24 + 176 * args.intensity);
      const candidate = {
        parent_path: args.parent_path,
        count: edge,
      };
      const parsed = createParticleFlockSchema.safeParse(candidate);
      return parsed.success
        ? { kind: generator, args: parsed.data }
        : { kind: generator, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
    }
    case "feedback_tunnel": {
      const candidate = {
        parent_path: args.parent_path,
        zoom: 1 + 0.06 * args.intensity,
        rotate: 1 + 6 * args.intensity,
        decay: 0.85 + 0.13 * args.intensity,
      };
      const parsed = createFeedbackTunnelSchema.safeParse(candidate);
      return parsed.success
        ? { kind: generator, args: parsed.data }
        : { kind: generator, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
    }
    case "gpu_particle_field": {
      const candidate = {
        parent_path: args.parent_path,
        side: Math.max(16, Math.round(64 + 192 * args.intensity)),
      };
      const parsed = createGpuParticleFieldSchema.safeParse(candidate);
      return parsed.success
        ? { kind: generator, args: parsed.data }
        : { kind: generator, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
    }
  }
}

async function dispatchGenerator(
  ctx: ToolContext,
  deps: DispatchDeps,
  kind: Generator,
  genArgs: Record<string, unknown>,
) {
  switch (kind) {
    case "audio_reactive":
      return deps.createAudioReactive(
        ctx,
        genArgs as Parameters<typeof createAudioReactiveImpl>[1],
      );
    case "generative_art":
      return deps.createGenerativeArt(
        ctx,
        genArgs as Parameters<typeof createGenerativeArtImpl>[1],
      );
    case "particle_flock":
      return deps.createParticleFlock(
        ctx,
        genArgs as Parameters<typeof createParticleFlockImpl>[1],
      );
    case "feedback_tunnel":
      return deps.createFeedbackTunnel(
        ctx,
        genArgs as Parameters<typeof createFeedbackTunnelImpl>[1],
      );
    case "gpu_particle_field":
      return deps.createGpuParticleField(
        ctx,
        genArgs as Parameters<typeof createGpuParticleFieldImpl>[1],
      );
  }
}

// ---------- Post-FX filter ----------

/** Map the prompt's post_fx enum to applyPostProcessing's accepted enum (drop unknowns). */
function reconcilePostFx(picked: PostFx[]): {
  effects: Array<z.infer<typeof applyPostProcessingSchema.shape.effects>[number]>;
  dropped: PostFx[];
} {
  const accepted = applyPostProcessingSchema.shape.effects.element.options as readonly string[];
  const effects: string[] = [];
  const dropped: PostFx[] = [];
  for (const fx of picked) {
    // feedback_trail isn't a known post-processing effect — drop it (the generator
    // may already provide trails).
    if (accepted.includes(fx)) effects.push(fx);
    else dropped.push(fx);
  }
  return {
    effects: effects as Array<z.infer<typeof applyPostProcessingSchema.shape.effects>[number]>,
    dropped,
  };
}

// ---------- Impl ----------

/** DI seam so tests can stub downstream impls without hitting the bridge mock paths. */
export interface MoodboardToSystemDeps extends Partial<DispatchDeps> {}

export async function moodboardToSystemImpl(
  ctx: ToolContext,
  rawArgs: MoodboardToSystemArgs,
  depsOverride?: MoodboardToSystemDeps,
) {
  const args = moodboardToSystemSchema.parse(rawArgs);
  const warnings: string[] = [];
  const deps: DispatchDeps = {
    createAudioReactive: depsOverride?.createAudioReactive ?? createAudioReactiveImpl,
    createGenerativeArt: depsOverride?.createGenerativeArt ?? createGenerativeArtImpl,
    createParticleFlock: depsOverride?.createParticleFlock ?? createParticleFlockImpl,
    createFeedbackTunnel: depsOverride?.createFeedbackTunnel ?? createFeedbackTunnelImpl,
    createGpuParticleField: depsOverride?.createGpuParticleField ?? createGpuParticleFieldImpl,
    applyPostProcessing: depsOverride?.applyPostProcessing ?? applyPostProcessingImpl,
  };

  const useLlm = args.preferLlm && ctx.llm !== undefined;
  let images: ImagePart[] = [];
  if (useLlm) {
    const loaded = await loadImages(ctx, args.images);
    if ("error" in loaded) {
      return errorResult(loaded.error);
    }
    images = loaded.parts;
  }

  let source: Source = "grammar";
  let plan: MoodboardPlan;

  if (useLlm && ctx.llm) {
    const out = await tryLlm(ctx.llm, args, images);
    if ("plan" in out) {
      plan = out.plan;
      source = "llm";
    } else {
      warnings.push(`${out.error}; used grammar fallback`);
      plan = grammarPlan(args);
      source = "llm-fallback-to-grammar";
    }
  } else {
    plan = grammarPlan(args);
  }

  // Manual generator override (does not change palette/post_fx).
  if (args.generator !== "auto") {
    plan.generator = args.generator as Generator;
  }

  const built = buildGeneratorArgs(plan, args);
  if ("error" in built) {
    return errorResult(`Could not assemble args for generator '${built.kind}': ${built.error}`, {
      plan,
      source,
    } as Record<string, unknown>);
  }

  const genResult = await dispatchGenerator(ctx, deps, built.kind, built.args);
  if ((genResult as { isError?: boolean }).isError) {
    const payload: ResultPayload = {
      source,
      plan,
      generator: built.kind,
      palette: plan.palette,
      post_fx_applied: [],
      warnings: [...warnings, `Generator '${built.kind}' returned an error.`],
    };
    return errorResult(
      `moodboard_to_system: generator '${built.kind}' failed (post-FX skipped).`,
      payload as unknown as Record<string, unknown>,
    );
  }

  const systemPath = extractContainerPath(genResult);

  let postFxApplied: PostFx[] = [];
  if (args.includePostFx && plan.post_fx.length > 0) {
    if (!systemPath) {
      warnings.push("Could not determine generator container path; post-FX skipped.");
    } else {
      const { effects, dropped } = reconcilePostFx(plan.post_fx);
      if (dropped.length > 0) {
        warnings.push(`Dropped unsupported post-FX: ${dropped.join(", ")}.`);
      }
      if (effects.length > 0) {
        const postArgs = applyPostProcessingSchema.safeParse({
          source_path: `${systemPath}/out1`,
          effects,
          parent_path: args.parent_path,
        });
        if (!postArgs.success) {
          warnings.push(
            `Post-FX arg validation failed: ${postArgs.error.issues[0]?.message ?? "unknown"}.`,
          );
        } else {
          const postResult = await deps.applyPostProcessing(ctx, postArgs.data);
          if ((postResult as { isError?: boolean }).isError) {
            warnings.push("apply_post_processing returned an error; effects not applied.");
          } else {
            postFxApplied = effects as PostFx[];
          }
        }
      }
    }
  }

  const payload: ResultPayload = {
    source,
    plan,
    generator: built.kind,
    palette: plan.palette,
    post_fx_applied: postFxApplied,
    warnings,
    ...(systemPath ? { systemPath } : {}),
  };

  const summary = `moodboard_to_system: ${built.kind} via ${source}${
    postFxApplied.length ? ` + ${postFxApplied.length} post-FX` : ""
  }${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`;
  return jsonResult(summary, payload);
}

export const registerMoodboardToSystem: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "moodboard_to_system",
    {
      title: "Moodboard → generative system",
      description:
        "Ingest 1..6 moodboard images and build a matching generative system in TouchDesigner. Uses the vision-capable local LLM when configured to extract palette + motion + generator pick (palette hint, generator from {audio_reactive, generative_art, particle_flock, feedback_tunnel, gpu_particle_field}, optional post-FX). Falls back to a deterministic style→generator grammar otherwise. Note: preview may read 0 on a paused timeline — press Play.",
      inputSchema: moodboardToSystemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => moodboardToSystemImpl(ctx, args as MoodboardToSystemArgs),
  );
};
