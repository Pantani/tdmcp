import { z } from "zod";
import {
  normalize,
  type Scene,
  type Setlist,
  SetlistSchema,
} from "../../automation/setlistSchema.js";
import type { LlmClientLike } from "../../llm/client.js";
import { createCueSequencerImpl } from "../layer2/createCueSequencer.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * compose_cue_list — natural-language → validated SetlistSchema (scenes[] form).
 *
 * Three-tier degradation (LLM JSON → LLM-fallback-to-grammar → grammar-only).
 * The compose step is pure JS; `apply: true` chains into createCueSequencerImpl.
 *
 * Note on `CompleteOptions`: this build's `CompleteOptions` does NOT carry a
 * `responseFormat` field (see src/llm/client.ts), so we rely on the system-prompt
 * JSON-only contract instead of a structured-output flag.
 */

export const composeCueListSchema = z.object({
  description: z.string().min(4).describe("Natural-language show plan."),
  bpm: z
    .number()
    .positive()
    .optional()
    .describe("Show tempo. Defaults to 120 if neither bpm nor a parsed cue overrides."),
  bars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Hint at total length in bars; LLM/grammar fits cues within."),
  style: z
    .enum(["techno", "ambient", "dnb", "house", "experimental", "generic"])
    .default("generic")
    .describe("Stylistic prior — biases default cue names + morph times."),
  title: z
    .string()
    .optional()
    .describe("Optional show/setlist title for the output `title` field."),
  apply: z
    .boolean()
    .default(false)
    .describe("If true, also build a cue_sequencer rig from the produced setlist."),
  containerName: z
    .string()
    .optional()
    .describe("When apply=true, passed through to create_cue_sequencer as `name`."),
  preferLlm: z
    .boolean()
    .default(true)
    .describe("If false, skip the LLM and use the grammar parser directly."),
});

export type ComposeCueListArgs = z.infer<typeof composeCueListSchema>;

type Source = "llm" | "grammar" | "llm-fallback-to-grammar";

interface ComposeResult {
  source: Source;
  setlist: Setlist;
  warnings: string[];
  applied?: { containerPath: string; cueCount: number };
}

// ---------- LLM prompt ----------

function buildSystemPrompt(
  style: string,
  bpm: number | undefined,
  bars: number | undefined,
): string {
  return [
    "You are a live-show cue planner for VJs. Output ONE JSON object and nothing else.",
    "The object MUST match this shape (a subset of SetlistSchema, scenes[] variant):",
    "",
    '{ "version": 1, "title"?: string, "bpm"?: number,',
    '  "scenes": [ { "id": string, "title"?: string, "cue"?: string,',
    '    "hold_beats"?: number, "hold_seconds"?: number, "morph_seconds": number } ] }',
    "",
    "Rules:",
    "- 4-24 scenes total.",
    "- Prefer hold_beats over hold_seconds when a bpm is known.",
    `- Style prior: ${style}. BPM hint: ${bpm ?? "unspecified"}. Total bars hint: ${bars ?? "unspecified"}.`,
    '- Cue names: short, lowercase, hyphen-allowed (e.g. "build-a", "drop-1", "breakdown").',
    "- No prose. No code fences. JSON object only.",
  ].join("\n");
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  // Otherwise, try to locate the first `{` and last `}`.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

async function tryLlm(
  llm: LlmClientLike,
  args: ComposeCueListArgs,
): Promise<{ setlist: Setlist } | { error: string }> {
  const system = buildSystemPrompt(args.style, args.bpm, args.bars);
  let res: Awaited<ReturnType<LlmClientLike["complete"]>>;
  try {
    res = await llm.complete(
      [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: args.description }] },
      ],
      { temperature: 0.2, maxTokens: 1200 },
    );
  } catch (err) {
    return { error: `LLM call failed: ${(err as Error).message}` };
  }
  const text = stripJsonFence(res.text ?? "");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      error: `LLM returned invalid JSON; used grammar fallback (${(err as Error).message})`,
    };
  }
  const parsed = SetlistSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `LLM JSON did not match SetlistSchema; used grammar fallback` };
  }
  if (!parsed.data.scenes || parsed.data.scenes.length === 0) {
    return { error: "LLM setlist had no scenes; used grammar fallback" };
  }
  // Override title if user gave one.
  const setlist: Setlist = { ...parsed.data };
  if (args.title) setlist.title = args.title;
  return { setlist };
}

// ---------- Grammar fallback ----------

const STYLE_DEFAULTS: Record<string, string[]> = {
  techno: ["intro", "build", "drop", "breakdown", "drop-2", "outro"],
  ambient: ["intro", "drone-a", "swell", "drone-b", "swell-2", "outro"],
  dnb: ["intro", "build", "drop", "breakdown", "drop-2", "outro"],
  house: ["intro", "build", "drop", "breakdown", "drop-2", "outro"],
  experimental: ["intro", "texture-a", "rupture", "texture-b", "rupture-2", "outro"],
  generic: ["intro", "build", "drop", "breakdown", "drop-2", "outro"],
};

interface MutableScene {
  id: string;
  title?: string;
  cue?: string;
  hold_beats?: number;
  hold_seconds?: number;
  morph_seconds: number;
}

function styleDefault(style: string): MutableScene[] {
  const names = STYLE_DEFAULTS[style] ?? STYLE_DEFAULTS.generic ?? [];
  return names.map((n) => baseScene(n));
}

function baseScene(cue: string): MutableScene {
  if (cue === "drop") return { id: "drop", cue, hold_beats: 16, morph_seconds: 0 };
  if (cue === "build") return { id: "build", cue, hold_beats: 16, morph_seconds: 0 };
  if (cue === "breakdown") return { id: "breakdown", cue, hold_beats: 32, morph_seconds: 4 };
  if (cue === "intro") return { id: "intro", cue, hold_beats: 16, morph_seconds: 8 };
  if (cue === "outro") return { id: "outro", cue, hold_beats: 16, morph_seconds: 8 };
  return { id: cue, cue, hold_beats: 16, morph_seconds: 2 };
}

function dedupeIds(scenes: MutableScene[]): void {
  const counts = new Map<string, number>();
  for (const s of scenes) {
    const base = s.id;
    const n = counts.get(base) ?? 0;
    if (n > 0) s.id = `${base}-${n + 1}`;
    counts.set(base, n + 1);
  }
}

// Phrase patterns — first-match per clause.
interface PhraseRule {
  re: RegExp;
  emit: (m: RegExpExecArray) => MutableScene;
}

const PHRASE_RULES: PhraseRule[] = [
  {
    re: /\bbuild(?:\s+(\d+)\s+bars?)?\b/i,
    emit: (m) => {
      const bars = m[1] ? Number.parseInt(m[1], 10) : undefined;
      return { id: "build", cue: "build", hold_beats: bars ? bars * 4 : 16, morph_seconds: 0 };
    },
  },
  {
    re: /\bdrop(?:\s+at\s+bar\s+(\d+))?\b/i,
    emit: () => ({ id: "drop", cue: "drop", hold_beats: 16, morph_seconds: 0 }),
  },
  {
    re: /\bbreakdown(?:\s+(\d+)\s+bars?)?\b/i,
    emit: (m) => {
      const bars = m[1] ? Number.parseInt(m[1], 10) : undefined;
      return {
        id: "breakdown",
        cue: "breakdown",
        hold_beats: bars ? bars * 4 : 32,
        morph_seconds: 4,
      };
    },
  },
  {
    re: /\bintro(?:\s+(\d+)\s+bars?)?\b/i,
    emit: (m) => {
      const bars = m[1] ? Number.parseInt(m[1], 10) : undefined;
      return { id: "intro", cue: "intro", hold_beats: bars ? bars * 4 : 16, morph_seconds: 8 };
    },
  },
  {
    re: /\boutro(?:\s+(\d+)\s+bars?)?\b/i,
    emit: (m) => {
      const bars = m[1] ? Number.parseInt(m[1], 10) : undefined;
      return { id: "outro", cue: "outro", hold_beats: bars ? bars * 4 : 16, morph_seconds: 8 };
    },
  },
  {
    re: /\b(verse|chorus|bridge|hook|loop)\b/i,
    emit: (m) => {
      const name = (m[1] ?? "loop").toLowerCase();
      return { id: name, cue: name, hold_beats: 16, morph_seconds: 2 };
    },
  },
];

function splitClauses(text: string): string[] {
  return text
    .split(/,|\.|\bthen\b|\binto\b|→|->/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function grammarParse(args: ComposeCueListArgs): { setlist: Setlist; warnings: string[] } {
  const warnings: string[] = [];
  const desc = args.description;

  // Extract tempo.
  let bpm = args.bpm;
  const bpmMatch = /(\d{2,3})\s*bpm/i.exec(desc);
  if (bpmMatch?.[1]) bpm = Number.parseInt(bpmMatch[1], 10);

  const clauses = splitClauses(desc);
  const scenes: MutableScene[] = [];
  const pending: { snap?: boolean; morph?: number; holdBars?: number } = {};

  for (const clause of clauses) {
    let matched: MutableScene | undefined;
    for (const rule of PHRASE_RULES) {
      const m = rule.re.exec(clause);
      if (m) {
        matched = rule.emit(m);
        break;
      }
    }

    const snapMod = /\bsnap\b/i.test(clause);
    const morphMatch = /\b(?:morph|crossfade|fade)(?:\s+(\d+)\s*s)?\b/i.exec(clause);
    const forBarsMatch = /\bfor\s+(\d+)\s+bars?\b/i.exec(clause);

    if (matched) {
      // Apply pending (from prior modifier-only clauses) first, then this clause's modifiers.
      if (pending.snap) matched.morph_seconds = 0;
      if (pending.morph !== undefined) matched.morph_seconds = pending.morph;
      if (pending.holdBars !== undefined) matched.hold_beats = pending.holdBars * 4;
      pending.snap = undefined;
      pending.morph = undefined;
      pending.holdBars = undefined;

      if (snapMod) matched.morph_seconds = 0;
      if (morphMatch?.[1]) matched.morph_seconds = Number.parseInt(morphMatch[1], 10);
      if (forBarsMatch?.[1]) matched.hold_beats = Number.parseInt(forBarsMatch[1], 10) * 4;
      scenes.push(matched);
    } else {
      // Modifier-only clause: attach to previous if present; otherwise queue for next.
      const prev = scenes[scenes.length - 1];
      if (prev) {
        if (snapMod) prev.morph_seconds = 0;
        if (morphMatch?.[1]) prev.morph_seconds = Number.parseInt(morphMatch[1], 10);
        if (forBarsMatch?.[1]) prev.hold_beats = Number.parseInt(forBarsMatch[1], 10) * 4;
      } else {
        if (snapMod) pending.snap = true;
        if (morphMatch?.[1]) pending.morph = Number.parseInt(morphMatch[1], 10);
        if (forBarsMatch?.[1]) pending.holdBars = Number.parseInt(forBarsMatch[1], 10);
      }
    }
  }

  let finalScenes = scenes;
  if (finalScenes.length === 0) {
    finalScenes = styleDefault(args.style);
    warnings.push(`No cues parsed from description; emitted style default for '${args.style}'.`);
  }

  // Enforce 4-24 scenes.
  if (finalScenes.length < 4) {
    const need = 4 - finalScenes.length;
    for (let i = 0; i < need; i++) finalScenes.push(baseScene("loop"));
    warnings.push(`Padded to 4 scenes with 'loop' (minimum).`);
  }
  if (finalScenes.length > 24) {
    finalScenes = finalScenes.slice(0, 24);
    warnings.push(`Truncated to 24 scenes (maximum).`);
  }

  dedupeIds(finalScenes);

  const rawSetlist: Record<string, unknown> = {
    version: 1,
    scenes: finalScenes as unknown as Scene[],
  };
  if (args.title) rawSetlist.title = args.title;
  if (bpm !== undefined) rawSetlist.bpm = bpm;

  const setlist = SetlistSchema.parse(rawSetlist);
  return { setlist, warnings };
}

// ---------- Apply step ----------

function setlistToSequencerSteps(setlist: Setlist): Array<{ cue: string; bars: number }> {
  const canonical = normalize(setlist);
  const steps: Array<{ cue: string; bars: number }> = [];
  for (const sc of canonical.scenes) {
    const cue = sc.cue ?? sc.id;
    let bars = 4;
    if (sc.hold_beats !== undefined && sc.hold_beats > 0) {
      bars = Math.max(1, Math.round(sc.hold_beats / 4));
    } else if (sc.bars !== undefined && sc.bars > 0) {
      bars = Math.max(1, Math.round(sc.bars));
    }
    steps.push({ cue, bars });
  }
  return steps;
}

// ---------- Impl ----------

export async function composeCueListImpl(ctx: ToolContext, rawArgs: ComposeCueListArgs) {
  const args = composeCueListSchema.parse(rawArgs);
  const llm = ctx.llm;
  const warnings: string[] = [];
  let source: Source = "grammar";
  let setlist: Setlist | undefined;

  const useLlm = args.preferLlm && llm !== undefined;

  if (useLlm && llm) {
    const out = await tryLlm(llm, args);
    if ("setlist" in out) {
      setlist = out.setlist;
      source = "llm";
    } else {
      warnings.push(out.error);
      source = "llm-fallback-to-grammar";
    }
  }

  if (!setlist) {
    try {
      const g = grammarParse(args);
      setlist = g.setlist;
      warnings.push(...g.warnings);
    } catch (err) {
      return errorResult(`compose_cue_list grammar fallback failed: ${(err as Error).message}`);
    }
  }

  const result: ComposeResult = { source, setlist, warnings };

  // Optional apply step — never fail compose if the bridge is down.
  if (args.apply) {
    try {
      const steps = setlistToSequencerSteps(setlist);
      if (steps.length === 0) {
        warnings.push("apply skipped: no steps derived from setlist.");
      } else {
        const seqArgs = {
          target: "/project1",
          steps,
          loop: true,
          quantize: "bar" as const,
          morph_seconds: 0,
          name: args.containerName ?? "cue_seq",
          parent_path: "/project1",
        };
        const applied = await createCueSequencerImpl(ctx, seqArgs);
        if (applied.isError) {
          warnings.push("apply skipped: cue_sequencer build returned an error.");
        } else {
          const structured = (applied as { structuredContent?: { comp?: string } })
            .structuredContent;
          const containerPath = structured?.comp ?? `${seqArgs.parent_path}/${seqArgs.name}`;
          result.applied = { containerPath, cueCount: steps.length };
        }
      }
    } catch (err) {
      warnings.push(`apply skipped: ${(err as Error).message}`);
    }
  }

  result.warnings = warnings;
  const summary = `compose_cue_list: ${setlist.scenes?.length ?? 0} scene(s) via ${source}${
    result.applied ? ` — applied to ${result.applied.containerPath}` : ""
  }${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`;
  return jsonResult(summary, result);
}

export const registerComposeCueList: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "compose_cue_list",
    {
      title: "Compose cue list (NL → setlist)",
      description:
        "Turn a natural-language show description into a validated cue list (SetlistSchema, scenes[] variant). Uses the local LLM when configured, falls back to a deterministic grammar parser otherwise. Optionally chains into create_cue_sequencer.",
      inputSchema: composeCueListSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => composeCueListImpl(ctx, args as ComposeCueListArgs),
  );
};
