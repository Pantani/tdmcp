import { z } from "zod";
import type { KnowledgeBase } from "../../knowledge/index.js";
import { recipeFromMarkdown } from "../../recipes/markdown.js";
import { friendlyTdError } from "../../td-client/types.js";
import { normalizeTags } from "../../vault/memoryNote.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

/**
 * `auto_tag_library_asset` — inspect a captured library asset (a vault recipe/
 * component note, or a live TD COMP) and suggest a tag set + difficulty +
 * one-line description, then optionally write the merge back into the note's
 * frontmatter.
 *
 * The heuristic in {@link suggestTags} is pure/deterministic so the same fn can
 * be reused inline by `save_recipe_to_vault` / `save_component_to_vault` when
 * their `auto_tag` opt-in lands.
 */

export const autoTagLibraryAssetSchema = z.object({
  target: z
    .enum(["vault_note", "td_comp"])
    .default("vault_note")
    .describe(
      "What to scan. 'vault_note' reads an existing note via the vault adapter; 'td_comp' captures a live COMP through the bridge.",
    ),
  note_path: z
    .string()
    .optional()
    .describe(
      "Vault-relative path of the note to tag (e.g. 'Recipes/audio_pulse.md'). Required when target='vault_note'; optional for 'td_comp'.",
    ),
  comp_path: z.string().default("/project1").describe("COMP path captured when target='td_comp'."),
  category_hint: z
    .enum(["recipe", "component", "auto"])
    .default("auto")
    .describe(
      "Helps frontmatter shape; 'auto' infers from the note location (Recipes/* vs Components/*).",
    ),
  write: z
    .boolean()
    .default(false)
    .describe(
      "When false, returns the suggestion as a dry-run. When true, merges the suggestion into the note's frontmatter and rewrites it.",
    ),
  overwrite_existing_tags: z
    .boolean()
    .default(false)
    .describe(
      "When false, union with existing frontmatter.tags. When true, replace them (user-pinned tags prefixed '*' are always kept).",
    ),
  max_tags: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe("Hard cap on suggested tag count after ranking."),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe("Drop suggestions whose score falls below this threshold."),
  include_difficulty: z
    .boolean()
    .default(true)
    .describe("Emit a 'beginner'|'intermediate'|'advanced' estimate from node count + complexity."),
  include_description: z
    .boolean()
    .default(true)
    .describe(
      "Generate a one-line description; only fills frontmatter.description when it is currently empty (never overwritten).",
    ),
});
export type AutoTagLibraryAssetArgs = z.infer<typeof autoTagLibraryAssetSchema>;

interface CapturedNode {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}
interface CapturedConnection {
  from: string;
  to: string;
}
export interface TagSuggestionInput {
  nodes: CapturedNode[];
  connections: CapturedConnection[];
  python_code?: Record<string, string>;
}
export interface TagSuggestion {
  suggested_tags: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  description: string;
  confidence: Record<string, number>;
  family_counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Heuristic — pure, sync, no I/O. Safe to reuse from saveRecipeToVault /
// saveComponentToVault once their `auto_tag` opt-in lands.
// ---------------------------------------------------------------------------

const AUDIO_FAMILIES = new Set([
  "audioSpectrum",
  "audioFilter",
  "audioDevicein",
  "audioDeviceIn",
  "audioFileIn",
  "audioOscillator",
  "audioAnalysis",
  "audioBandEq",
  "audioMovie",
  "audioStream",
  "audioPlay",
]);
const GLSL_FAMILIES = new Set(["glslTOP", "glslmultiTOP", "glslMulti", "glslMaterial"]);
const RAYMARCH_HINTS = ["raymarch", "raymarcher"];
const GPU_PARTICLE_FAMILIES = new Set([
  "particlesgpuTOP",
  "particlesGPU",
  "popnetworkCOMP",
  "popNetwork",
]);
const POST_FX_FAMILIES = new Set([
  "blurTOP",
  "bloomTOP",
  "lookupTOP",
  "levelTOP",
  "compositeTOP",
  "edgeTOP",
  "transformTOP",
]);
const LIVE_INPUT_FAMILIES = new Set([
  "kinectTOP",
  "kinect2TOP",
  "videodeviceinTOP",
  "videoDeviceIn",
  "ndiinTOP",
  "syphonspoutinTOP",
]);
const EXTERNAL_CONTROL_HINTS = ["midiin", "oscin", "tdabletonlink", "midiout", "oscout"];
const THREED_SUFFIXES = ["SOP", "COMP", "MAT"];
const THREED_HINTS = ["render", "camera", "geometry", "light"];

function lower(s: string): string {
  return s.toLowerCase();
}

function matchAny(typeLower: string, hints: string[]): boolean {
  for (const h of hints) {
    if (typeLower.includes(h)) return true;
  }
  return false;
}

function classifyNode(type: string) {
  const t = type;
  const tl = lower(t);
  return {
    audio: AUDIO_FAMILIES.has(t) || tl.startsWith("audio"),
    glsl: GLSL_FAMILIES.has(t) || tl.startsWith("glsl"),
    raymarch: matchAny(tl, RAYMARCH_HINTS),
    gpuParticles: GPU_PARTICLE_FAMILIES.has(t) || tl.startsWith("pop") || tl.includes("particles"),
    feedback: t === "feedbackTOP" || tl === "feedbacktop",
    postFx: POST_FX_FAMILIES.has(t),
    liveInput: LIVE_INPUT_FAMILIES.has(t) || tl.includes("kinect") || tl.includes("videodevice"),
    externalControl: matchAny(tl, EXTERNAL_CONTROL_HINTS),
    threeD:
      THREED_SUFFIXES.some((suf) => t.endsWith(suf) && t !== "baseCOMP" && t !== "containerCOMP") ||
      matchAny(tl, THREED_HINTS),
  };
}

function hasSelfLoop(connections: CapturedConnection[]): boolean {
  for (const c of connections) {
    if (c.from === c.to) return true;
  }
  return false;
}

/** Pure, deterministic tag suggester. KB is consulted but never required. */
export function suggestTags(
  input: TagSuggestionInput,
  knowledge?: KnowledgeBase,
  opts?: { maxTags?: number; minConfidence?: number },
): TagSuggestion {
  const maxTags = opts?.maxTags ?? 8;
  const minConfidence = opts?.minConfidence ?? 0.35;
  const nodes = input.nodes ?? [];
  const connections = input.connections ?? [];
  const total = Math.max(nodes.length, 1);

  // 1. Family tags by occurrence.
  const familyCounts: Record<string, number> = {};
  for (const n of nodes) {
    if (!n?.type) continue;
    // Soft KB lookup — degrade silently if op is unknown (KB lags ~14 recent ops).
    if (knowledge && !knowledge.operatorExists(n.type)) {
      // unknown op — skip its family tag, but still let it contribute to category rules.
      continue;
    }
    familyCounts[n.type] = (familyCounts[n.type] ?? 0) + 1;
  }

  // 2. Category rules.
  const ruleScores: Record<string, number> = {};
  let audio = 0;
  let glsl = 0;
  let raymarch = 0;
  let gpuParticles = 0;
  let feedbackCount = 0;
  let postFx = 0;
  let liveInput = 0;
  let externalControl = 0;
  let threeD = 0;
  for (const n of nodes) {
    if (!n?.type) continue;
    const c = classifyNode(n.type);
    if (c.audio) audio++;
    if (c.glsl) glsl++;
    if (c.raymarch) raymarch++;
    if (c.gpuParticles) gpuParticles++;
    if (c.feedback) feedbackCount++;
    if (c.postFx) postFx++;
    if (c.liveInput) liveInput++;
    if (c.externalControl) externalControl++;
    if (c.threeD) threeD++;
  }
  const selfLoop = hasSelfLoop(connections);
  if (audio > 0) ruleScores["audio-reactive"] = Math.min(1, 0.5 + audio / total);
  if (feedbackCount > 0 || selfLoop) ruleScores.feedback = selfLoop ? 0.95 : 0.85;
  if (glsl > 0) ruleScores.glsl = Math.min(1, 0.6 + glsl / total);
  if (raymarch > 0) ruleScores.raymarch = Math.min(1, 0.6 + raymarch / total);
  if (gpuParticles > 0) ruleScores["gpu-particles"] = Math.min(1, 0.6 + gpuParticles / total);
  if (threeD > 0) ruleScores["3D"] = Math.min(1, 0.5 + threeD / total);
  if (postFx > 0) ruleScores["post-fx"] = Math.min(1, 0.4 + postFx / total);
  if (liveInput > 0) ruleScores["live-input"] = Math.min(1, 0.7 + liveInput / total);
  if (externalControl > 0)
    ruleScores["external-control"] = Math.min(1, 0.7 + externalControl / total);

  // 3. Rank: union of category + family, score blended.
  const allCandidates = new Map<string, number>();
  for (const [tag, weight] of Object.entries(ruleScores)) {
    const score = 0.5 * weight + 0.5 * Math.min(1, weight); // category rules already incorporate occurrence share
    allCandidates.set(tag, score);
  }
  for (const [family, count] of Object.entries(familyCounts)) {
    const occShare = count / total;
    const score = 0.5 * occShare + 0.5 * Math.min(1, 0.4 + occShare);
    allCandidates.set(family, score);
  }

  const ranked = [...allCandidates.entries()]
    .filter(([, s]) => s >= minConfidence)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags);

  const suggested = ranked.map(([t]) => t);
  const confidence: Record<string, number> = {};
  for (const [t, s] of ranked) confidence[t] = Math.round(s * 100) / 100;

  // 4. Difficulty.
  const complex = glsl > 0 || feedbackCount > 0 || selfLoop;
  let difficulty: "beginner" | "intermediate" | "advanced";
  if (nodes.length <= 6 && !complex) difficulty = "beginner";
  else if (nodes.length >= 20 || (glsl > 0 && (feedbackCount > 0 || selfLoop) && threeD > 0))
    difficulty = "advanced";
  else difficulty = "intermediate";

  // 5. Description: "<dominant-category> <primary-family-tag> patch (<n> ops)".
  const dominantCategory =
    Object.entries(ruleScores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "visual";
  const primaryFamily =
    Object.entries(familyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "network";
  const description = `${dominantCategory} ${primaryFamily} patch (${nodes.length} ops)`;

  return {
    suggested_tags: suggested,
    difficulty,
    description,
    confidence,
    family_counts: familyCounts,
  };
}

// ---------------------------------------------------------------------------
// Note parsing — supports recipe notes (json tdmcp-recipe fence) and component
// notes (a `nodes:` bulleted list emitted by saveComponentToVault).
// ---------------------------------------------------------------------------

function parseRecipeNoteNodes(
  raw: string,
): { nodes: CapturedNode[]; connections: CapturedConnection[] } | null {
  try {
    const recipe = recipeFromMarkdown(raw);
    return {
      nodes: recipe.nodes.map((n) => ({ name: n.name, type: n.type })),
      connections: recipe.connections.map((c) => ({ from: c.from, to: c.to })),
    };
  } catch {
    return null;
  }
}

// Lightly parses a `nodes:` YAML-ish list out of a component note body. The
// component note writer emits one line per node like `- name: foo, type: noiseTOP`.
function parseComponentNoteNodes(body: string): {
  nodes: CapturedNode[];
  connections: CapturedConnection[];
} {
  const nodes: CapturedNode[] = [];
  // Match `name: foo` and `type: someTOP` pairs on the same line in any order.
  const lineRe = /^\s*[-*]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  m = lineRe.exec(body);
  while (m !== null) {
    const line = m[1] ?? "";
    const nameMatch = /name\s*[:=]\s*([A-Za-z0-9_.-]+)/.exec(line);
    const typeMatch = /type\s*[:=]\s*([A-Za-z0-9_.-]+)/.exec(line);
    if (typeMatch?.[1]) {
      nodes.push({ name: nameMatch?.[1] ?? `n${nodes.length}`, type: typeMatch[1] });
    }
    m = lineRe.exec(body);
  }
  return { nodes, connections: [] };
}

// ---------------------------------------------------------------------------
// Bridge capture — identical shape to saveRecipeToVault's CAPTURE_SCRIPT (this
// is a read-only inspection; the integrator will later extract a shared
// `buildCaptureScript()` so both tools share one source of truth).
// ---------------------------------------------------------------------------

const CAPTURE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "nodes": [], "connections": [], "python_code": {}, "warnings": []}
try:
    _root = op(_p["comp"])
    if _root is None:
        report["fatal"] = "Operator not found: " + _p["comp"]
    elif not hasattr(_root, "children"):
        report["fatal"] = _p["comp"] + " is not a COMP (no children to capture)."
    else:
        _kids = list(_root.children)
        _names = set(c.name for c in _kids)
        for _c in _kids:
            report["nodes"].append({"name": _c.name, "type": _c.OPType, "parameters": {}})
            try:
                for _ic in _c.inputConnectors:
                    for _oc in _ic.connections:
                        _src = _oc.owner
                        if _src is not None and _src.name in _names:
                            report["connections"].append({"from": _src.name, "to": _c.name, "from_output": _oc.index, "to_input": _ic.index})
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface CaptureReport {
  comp: string;
  nodes: CapturedNode[];
  connections: CapturedConnection[];
  python_code?: Record<string, string>;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Tool impl.
// ---------------------------------------------------------------------------

interface MergeResult {
  finalTags: string[];
  added: string[];
  removed: string[];
  keptUserTags: string[];
}

function mergeTags(existing: string[], suggested: string[], overwrite: boolean): MergeResult {
  const pinned = existing.filter((t) => t.startsWith("*"));
  const nonPinned = existing.filter((t) => !t.startsWith("*"));
  const base = overwrite ? [] : nonPinned;
  const norm = normalizeTags([...base, ...suggested]);
  // Preserve pinned tags verbatim (keep their leading '*').
  const final = [...norm, ...pinned.filter((p) => !norm.includes(p.toLowerCase()))];
  const added = norm.filter((t) => !nonPinned.map((x) => x.toLowerCase()).includes(t));
  const removed = overwrite ? nonPinned.filter((t) => !norm.includes(t.toLowerCase())) : [];
  return { finalTags: final, added, removed, keptUserTags: pinned };
}

export async function autoTagLibraryAssetImpl(ctx: ToolContext, args: AutoTagLibraryAssetArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  // -------- gather the network --------
  let nodes: CapturedNode[] = [];
  let connections: CapturedConnection[] = [];
  let pythonCode: Record<string, string> | undefined;
  let notePath: string | undefined = args.note_path;
  let noteData: Record<string, unknown> = {};
  let noteBody = "";

  if (args.target === "vault_note") {
    if (!args.note_path) {
      return errorResult("note_path is required when target='vault_note'.");
    }
    if (!vault.exists(args.note_path)) {
      return errorResult(`Vault note not found: ${args.note_path}`);
    }
    const note = readNoteSafe(vault, args.note_path);
    if ("error" in note) return note.error;
    noteData = { ...note.data };
    noteBody = note.body;
    const rawRecipe = parseRecipeNoteNodes(vault.read(args.note_path));
    if (rawRecipe && rawRecipe.nodes.length > 0) {
      nodes = rawRecipe.nodes;
      connections = rawRecipe.connections;
    } else {
      const parsed = parseComponentNoteNodes(noteBody);
      nodes = parsed.nodes;
      connections = parsed.connections;
    }
    if (nodes.length === 0) {
      return errorResult(
        `Could not extract a node list from ${args.note_path}. Expected a recipe (json tdmcp-recipe block) or a component note with a 'name: <n>, type: <t>' listing.`,
      );
    }
  } else {
    // target === "td_comp" — capture via the bridge.
    try {
      const script = buildPayloadScript(CAPTURE_SCRIPT, { comp: args.comp_path });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<CaptureReport>(exec.stdout);
      if (report.fatal) return errorResult(`Capture failed: ${report.fatal}`);
      if (!report.nodes || report.nodes.length === 0) {
        return errorResult(`No operators found under ${args.comp_path} to tag.`);
      }
      nodes = report.nodes;
      connections = report.connections ?? [];
      pythonCode = report.python_code;
    } catch (err) {
      return errorResult(friendlyTdError(err));
    }
    if (args.note_path) {
      notePath = args.note_path;
      if (vault.exists(args.note_path)) {
        const note = readNoteSafe(vault, args.note_path);
        if ("error" in note) return note.error;
        noteData = { ...note.data };
        noteBody = note.body;
      }
    }
  }

  // -------- run the heuristic --------
  const suggestion = suggestTags({ nodes, connections, python_code: pythonCode }, ctx.knowledge, {
    maxTags: args.max_tags,
    minConfidence: args.min_confidence,
  });

  // -------- compute the frontmatter merge --------
  const existingTagsRaw = noteData.tags;
  let existingTags: string[] = [];
  if (Array.isArray(existingTagsRaw)) {
    existingTags = existingTagsRaw.map((t) => String(t));
  } else if (typeof existingTagsRaw === "string") {
    existingTags = existingTagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  const merge = mergeTags(existingTags, suggestion.suggested_tags, args.overwrite_existing_tags);

  const patch: Record<string, unknown> = { tags: merge.finalTags };
  if (args.include_difficulty) patch.difficulty = suggestion.difficulty;
  if (args.include_description) {
    const cur = typeof noteData.description === "string" ? noteData.description : "";
    if (!cur.trim()) patch.description = suggestion.description;
  }
  patch.auto_tags = {
    source: "auto_tag_library_asset",
    generated_at: new Date().toISOString(),
    version: 1,
    replaced: args.overwrite_existing_tags,
  };

  const responseData = {
    note_path: notePath ?? null,
    target: args.target,
    suggested_tags: suggestion.suggested_tags,
    kept_user_tags: merge.keptUserTags,
    difficulty: args.include_difficulty ? suggestion.difficulty : undefined,
    description: patch.description ?? undefined,
    diff: {
      tags_added: merge.added,
      tags_removed: merge.removed,
      frontmatter_patch: patch,
    },
    confidence: suggestion.confidence,
    family_counts: suggestion.family_counts,
    node_count: nodes.length,
    written: false as boolean,
  };

  if (!args.write) {
    return jsonResult(
      `Suggested ${suggestion.suggested_tags.length} tag(s) for ${notePath ?? args.comp_path} (dry-run).`,
      responseData,
    );
  }

  // -------- write back --------
  if (!notePath) {
    return errorResult("write:true requires note_path so the suggestion has a note to merge into.");
  }
  const mergedData: Record<string, unknown> = { ...noteData, ...patch };
  try {
    vault.writeNote(notePath, mergedData, noteBody);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Could not write vault note "${notePath}": ${reason}`);
  }

  responseData.written = true;
  return jsonResult(
    `Auto-tagged ${notePath} with ${suggestion.suggested_tags.length} tag(s); merged into frontmatter.`,
    responseData,
  );
}

export const registerAutoTagLibraryAsset: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "auto_tag_library_asset",
    {
      title: "Auto-tag a vault library asset",
      description:
        "Inspect a captured library asset (a vault recipe/component note, or a live TD COMP) and emit a suggested tag set, difficulty, and one-line description from a deterministic operator-family heuristic; with write:true, merge the suggestion into the note's frontmatter (preserving '*'-pinned user tags). Use this to backfill consistent tags across a library so browse_vault_library can find by category. Requires a configured TDMCP_VAULT_PATH; target='td_comp' additionally requires the bridge.",
      inputSchema: autoTagLibraryAssetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => autoTagLibraryAssetImpl(ctx, args),
  );
};
