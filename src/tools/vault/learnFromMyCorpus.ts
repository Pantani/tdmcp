import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { parseNote } from "../../vault/frontmatter.js";
import { Vault } from "../../vault/index.js";
import {
  memoryNoteRel,
  mergeMemoryFrontmatter,
  mergeStyleMemory,
  type Palette,
} from "../../vault/memoryNote.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

/**
 * `learn_from_my_corpus` — offline companion to `learn_conventions`. Walks the
 * Obsidian vault corpus (Recipes/, Components/, Looks/, Setlists/, Moodboards/)
 * and distils palette/naming/recipe-shape/param preferences into the shared
 * `Memory/corpus_style.md` note (and optionally `Memory/style.md`). No TD
 * required; pure filesystem read + frontmatter writes.
 */
export const learnFromMyCorpusSchema = z.object({
  vault_path: z
    .string()
    .optional()
    .describe("Optional vault root override; defaults to TDMCP_VAULT_PATH."),
  observe: z
    .array(z.enum(["palette", "naming", "recipe-style", "param-defaults"]))
    .default(["palette", "naming", "recipe-style", "param-defaults"])
    .describe("Which families to extract; subsets keep the run cheap."),
  min_support: z
    .number()
    .int()
    .min(2)
    .default(3)
    .describe("Minimum frequency for a pattern to be recorded."),
  top_k_palette: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(5)
    .describe("How many most-frequent palettes to keep."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, return findings but do NOT write vault notes."),
  also_patch_style_memory: z
    .boolean()
    .default(true)
    .describe("If confident, merge palettes/naming/favorite_generators into Memory/style.md."),
});

export type LearnFromMyCorpusArgs = z.infer<typeof learnFromMyCorpusSchema>;

export const CORPUS_STYLE_TOPIC = "corpus_style";
const FILE_CAP = 5000;

const SUBDIR_RECIPES = "Recipes";
const SUBDIR_COMPONENTS = "Components";
const SUBDIR_LOOKS = "Looks";
const SUBDIR_SETLISTS = "Setlists";
const SUBDIR_MOODBOARDS = "Moodboards";

// ---------------------------------------------------------------------------
// Pure helpers (locally replicated from learnConventions.ts to keep this file
// self-contained — spec asks the integrator to promote them later).
// ---------------------------------------------------------------------------

export function stripTrailingDigits(name: string): string {
  return name.replace(/[_-]?\d+$/, "");
}

export type Case = "camelCase" | "snake_case" | "kebab-case" | "lowercase" | "MIXED";

export function detectCase(name: string): Case {
  if (name.includes("_")) return "snake_case";
  if (name.includes("-")) return "kebab-case";
  if (/[a-z][A-Z]/.test(name)) return "camelCase";
  if (/^[a-z0-9]+$/.test(name)) return "lowercase";
  return "MIXED";
}

export function tokenizeFirstPrefix(name: string): string {
  if (name.includes("_")) return name.split("_")[0] ?? "";
  if (name.includes("-")) return name.split("-")[0] ?? "";
  const m = /^([a-z]+)[A-Z]/.exec(name);
  if (m?.[1]) return m[1];
  return name;
}

export type Archetype = "generator" | "effect" | "control" | "output" | "other";

export function archetypeFromChildren(types: string[]): Archetype {
  const lower = types.map((t) => t.toLowerCase());
  if (lower.length > 0 && lower.every((t) => t === "outtop")) return "output";
  if (lower.some((t) => t.includes("panel") || t === "buttoncomp" || t === "slidercomp"))
    return "control";
  if (lower.some((t) => t.startsWith("feedback") || t === "noisetop" || t === "ramptop"))
    return "generator";
  if (lower.some((t) => t === "blurtop" || t === "leveltop" || t === "compositetop"))
    return "effect";
  return "other";
}

function familyFromType(type: string): string {
  const t = type.toLowerCase();
  if (t.endsWith("top")) return "TOP";
  if (t.endsWith("chop")) return "CHOP";
  if (t.endsWith("sop")) return "SOP";
  if (t.endsWith("dat")) return "DAT";
  if (t.endsWith("mat")) return "MAT";
  if (t.endsWith("comp")) return "COMP";
  return "OTHER";
}

// ---------------------------------------------------------------------------
// Corpus scan types
// ---------------------------------------------------------------------------

export interface ScannedCounts {
  recipes: number;
  components: number;
  looks: number;
}

export interface PaletteCluster {
  name?: string;
  colors: string[];
  count: number;
  sources: string[];
}

export interface RecipeShape {
  archetype: Archetype;
  typical_children: string[];
  edge_bucket: number;
  count: number;
  sample_paths: string[];
}

export interface CorpusParamDefault {
  type: string;
  param: string;
  value: unknown;
  support: number;
}

export interface CorpusStats {
  scanned: ScannedCounts;
  warnings: string[];
  /** flat hex → count + sources. */
  hexFreq: Map<string, { count: number; sources: string[] }>;
  /** palette groupings: colours that co-occur in a single source. */
  paletteGroups: Array<{ name?: string; colors: string[]; source: string }>;
  /** node-name samples for naming detection. */
  names: Array<{ name: string; type: string }>;
  /** raw recipe shape rows, pre-cluster. */
  recipeShapeRows: Array<{
    signature: string;
    types: string[];
    edgeBucket: number;
    archetype: Archetype;
    path: string;
  }>;
  /** param-default tallies pre-filter. */
  paramTally: Map<string, { type: string; param: string; value: unknown; support: number }>;
  /** total files visited (cap check). */
  totalFiles: number;
}

export interface CorpusStyleExtract {
  scanned: ScannedCounts;
  sample_size: number;
  warnings: string[];
  palettes?: PaletteCluster[];
  top_hexes?: string[];
  naming?: { case?: Case; prefixes_by_family: Record<string, Record<string, number>> };
  naming_label?: Case;
  recipe_shapes?: RecipeShape[];
  param_defaults?: CorpusParamDefault[];
  favorite_generators?: string[];
}

// ---------------------------------------------------------------------------
// Hex extraction
// ---------------------------------------------------------------------------

const HEX_RE = /#[0-9a-f]{6}\b/gi;
const COLOR_PARAM_RE = /color|colour|tint|palette|hex/i;

function extractHexes(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(HEX_RE);
  if (!matches) return out;
  for (const m of matches) out.push(m.toLowerCase());
  return out;
}

function collectHexesFromValue(value: unknown): string[] {
  if (typeof value === "string") return extractHexes(value);
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) out.push(...collectHexesFromValue(v));
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Recipe signature
// ---------------------------------------------------------------------------

export function signatureForRecipe(
  nodes: Array<{ type?: unknown }>,
  edgeCount: number,
): { signature: string; types: string[]; edgeBucket: number } {
  const types = nodes
    .map((n) => (typeof n.type === "string" ? n.type : ""))
    .filter((t) => t !== "")
    .sort();
  const edgeBucket = Math.max(0, Math.round(edgeCount / 3) * 3);
  return { signature: `${edgeBucket}|${types.join(",")}`, types, edgeBucket };
}

// ---------------------------------------------------------------------------
// Palette clustering
// ---------------------------------------------------------------------------

export function clusterPalettes(
  groups: Array<{ name?: string; colors: string[]; source: string }>,
  topK: number,
  minSupport: number,
): PaletteCluster[] {
  const byKey = new Map<string, PaletteCluster>();
  for (const g of groups) {
    if (g.colors.length < 3) continue;
    const normalized = [...new Set(g.colors.map((c) => c.toLowerCase()))].sort();
    const key = g.name ? `n:${g.name.toLowerCase()}` : `c:${normalized.join(",")}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { colors: normalized, count: 0, sources: [] };
      if (g.name) entry.name = g.name;
      byKey.set(key, entry);
    }
    entry.count += 1;
    if (!entry.sources.includes(g.source)) entry.sources.push(g.source);
  }
  const out = [...byKey.values()]
    .filter((p) => p.count >= minSupport || p.name !== undefined)
    .sort((a, b) => b.count - a.count)
    .slice(0, topK);
  return out;
}

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

function walkFiles(vault: Vault, subdir: string, ext: string, cap: number): string[] {
  const out: string[] = [];
  const root = vault.resolve(subdir);
  function recurse(dir: string): void {
    if (out.length >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const full = join(dir, e);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) recurse(full);
      else if (s.isFile() && e.endsWith(ext)) out.push(full);
    }
  }
  try {
    const s = statSync(root);
    if (!s.isDirectory()) return out;
  } catch {
    return out;
  }
  recurse(root);
  return out;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function readSafe(vault: Vault, abs: string): string | undefined {
  try {
    const rel = relative(vault.root, abs);
    return vault.read(rel);
  } catch {
    return undefined;
  }
}

function pushHex(stats: CorpusStats, hex: string, source: string): void {
  const k = hex.toLowerCase();
  let e = stats.hexFreq.get(k);
  if (!e) {
    e = { count: 0, sources: [] };
    stats.hexFreq.set(k, e);
  }
  e.count += 1;
  if (!e.sources.includes(source)) e.sources.push(source);
}

function scanRecipeFile(stats: CorpusStats, vault: Vault, abs: string): void {
  const rel = relative(vault.root, abs);
  const raw = readSafe(vault, abs);
  if (raw === undefined) {
    stats.warnings.push(`unreadable: ${rel}`);
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    stats.warnings.push(`malformed recipe JSON: ${rel}`);
    return;
  }
  if (!json || typeof json !== "object") return;
  stats.scanned.recipes += 1;
  const obj = json as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as Array<Record<string, unknown>>) : [];
  const connections = Array.isArray(obj.connections) ? obj.connections.length : 0;

  // Collect node names + types + scan param values for colour-named keys.
  for (const n of nodes) {
    const type = typeof n.type === "string" ? (n.type as string) : "";
    const name = typeof n.name === "string" ? (n.name as string) : "";
    if (name && type) stats.names.push({ name, type });
    const params = n.parameters;
    if (params && typeof params === "object") {
      for (const [pname, pval] of Object.entries(params as Record<string, unknown>)) {
        // Param default tally
        if (
          type &&
          (typeof pval === "number" || typeof pval === "string" || typeof pval === "boolean")
        ) {
          const key = `${type}|${pname}|${JSON.stringify(pval)}`;
          const existing = stats.paramTally.get(key);
          if (existing) existing.support += 1;
          else stats.paramTally.set(key, { type, param: pname, value: pval, support: 1 });
        }
        if (COLOR_PARAM_RE.test(pname)) {
          for (const h of collectHexesFromValue(pval)) pushHex(stats, h, rel);
        }
      }
    }
  }

  // Recipe shape signature
  if (nodes.length > 0) {
    const sig = signatureForRecipe(nodes as Array<{ type?: unknown }>, connections);
    stats.recipeShapeRows.push({
      signature: sig.signature,
      types: sig.types,
      edgeBucket: sig.edgeBucket,
      archetype: archetypeFromChildren(sig.types),
      path: rel,
    });
  }
}

function scanMarkdownFile(
  stats: CorpusStats,
  vault: Vault,
  abs: string,
  bucket: "components" | "looks",
): void {
  const rel = relative(vault.root, abs);
  const raw = readSafe(vault, abs);
  if (raw === undefined) {
    stats.warnings.push(`unreadable: ${rel}`);
    return;
  }
  let parsed: { data: Record<string, unknown>; body: string };
  try {
    parsed = parseNote(raw);
  } catch {
    stats.warnings.push(`malformed frontmatter: ${rel}`);
    return;
  }
  if (bucket === "components") stats.scanned.components += 1;
  else stats.scanned.looks += 1;

  const data = parsed.data;
  const name = data.name;
  if (typeof name === "string" && name) {
    stats.names.push({ name, type: bucket === "components" ? "component" : "look" });
  }

  // palette / colors single-list
  const flatHexes: string[] = [];
  for (const key of ["palette", "colors"]) {
    const v = data[key];
    if (Array.isArray(v)) {
      const hexes: string[] = [];
      for (const c of v) {
        if (typeof c === "string") {
          for (const h of extractHexes(c)) hexes.push(h);
        }
      }
      if (hexes.length > 0) {
        flatHexes.push(...hexes);
        stats.paletteGroups.push({ colors: hexes, source: rel });
      }
    } else if (typeof v === "string") {
      const hexes = extractHexes(v);
      flatHexes.push(...hexes);
      if (hexes.length >= 3) stats.paletteGroups.push({ colors: hexes, source: rel });
    }
  }
  // palettes: [{name, colors}]
  const palettes = data.palettes;
  if (Array.isArray(palettes)) {
    for (const p of palettes) {
      if (p && typeof p === "object") {
        const pp = p as Record<string, unknown>;
        const pname = typeof pp.name === "string" ? pp.name : undefined;
        const colorsField = pp.colors;
        const hexes: string[] = [];
        if (Array.isArray(colorsField)) {
          for (const c of colorsField) {
            if (typeof c === "string") for (const h of extractHexes(c)) hexes.push(h);
          }
        }
        if (hexes.length > 0) {
          flatHexes.push(...hexes);
          const group: { name?: string; colors: string[]; source: string } = {
            colors: hexes,
            source: rel,
          };
          if (pname !== undefined) group.name = pname;
          stats.paletteGroups.push(group);
        }
      }
    }
  }
  for (const h of flatHexes) pushHex(stats, h, rel);
}

export function scanCorpus(vault: Vault, _args: LearnFromMyCorpusArgs): CorpusStats {
  const stats: CorpusStats = {
    scanned: { recipes: 0, components: 0, looks: 0 },
    warnings: [],
    hexFreq: new Map(),
    paletteGroups: [],
    names: [],
    recipeShapeRows: [],
    paramTally: new Map(),
    totalFiles: 0,
  };

  // recipes
  const recipeRoot = vault.resolve(SUBDIR_RECIPES);
  let hasRecipes = false;
  try {
    hasRecipes = statSync(recipeRoot).isDirectory();
  } catch {
    hasRecipes = false;
  }
  if (!hasRecipes) stats.warnings.push(`no ${SUBDIR_RECIPES} dir`);
  else {
    const files = walkFiles(vault, SUBDIR_RECIPES, ".json", FILE_CAP - stats.totalFiles);
    stats.totalFiles += files.length;
    for (const f of files) scanRecipeFile(stats, vault, f);
  }

  // components
  const compsRoot = vault.resolve(SUBDIR_COMPONENTS);
  let hasComps = false;
  try {
    hasComps = statSync(compsRoot).isDirectory();
  } catch {
    hasComps = false;
  }
  if (!hasComps) stats.warnings.push(`no ${SUBDIR_COMPONENTS} dir`);
  else {
    const files = walkFiles(vault, SUBDIR_COMPONENTS, ".md", FILE_CAP - stats.totalFiles);
    stats.totalFiles += files.length;
    for (const f of files) scanMarkdownFile(stats, vault, f, "components");
  }

  // looks + setlists + moodboards all bucket as "looks"
  for (const sub of [SUBDIR_LOOKS, SUBDIR_SETLISTS, SUBDIR_MOODBOARDS]) {
    const root = vault.resolve(sub);
    let has = false;
    try {
      has = statSync(root).isDirectory();
    } catch {
      has = false;
    }
    if (!has) {
      if (sub === SUBDIR_LOOKS) stats.warnings.push(`no ${SUBDIR_LOOKS} dir`);
      continue;
    }
    const files = walkFiles(vault, sub, ".md", FILE_CAP - stats.totalFiles);
    stats.totalFiles += files.length;
    for (const f of files) scanMarkdownFile(stats, vault, f, "looks");
  }

  if (stats.totalFiles >= FILE_CAP) stats.warnings.push(`file cap ${FILE_CAP} reached`);
  return stats;
}

// ---------------------------------------------------------------------------
// Style extraction
// ---------------------------------------------------------------------------

const GENERATOR_BY_TYPE: Record<string, string> = {
  feedbacktop: "create_feedback_network",
  noisetop: "create_generative_art",
  ramptop: "create_generative_art",
};

export function extractStyle(stats: CorpusStats, args: LearnFromMyCorpusArgs): CorpusStyleExtract {
  const obs = new Set(args.observe);
  const extract: CorpusStyleExtract = {
    scanned: stats.scanned,
    sample_size: stats.scanned.recipes + stats.scanned.components + stats.scanned.looks,
    warnings: [...stats.warnings],
  };

  if (obs.has("palette")) {
    const palettes = clusterPalettes(stats.paletteGroups, args.top_k_palette, args.min_support);
    extract.palettes = palettes;
    const topHexes = [...stats.hexFreq.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 16)
      .map(([h]) => h);
    extract.top_hexes = topHexes;
  }

  if (obs.has("naming")) {
    const caseCounts: Record<string, number> = {};
    const prefixesByFamily: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const r of stats.names) {
      if (!r.name) continue;
      total += 1;
      const c = detectCase(r.name);
      caseCounts[c] = (caseCounts[c] ?? 0) + 1;
      const stripped = stripTrailingDigits(r.name);
      const prefix = tokenizeFirstPrefix(stripped);
      if (!prefix) continue;
      const fam = familyFromType(r.type);
      if (!prefixesByFamily[fam]) prefixesByFamily[fam] = {};
      const bucket = prefixesByFamily[fam];
      bucket[prefix] = (bucket[prefix] ?? 0) + 1;
    }
    const filtered: Record<string, Record<string, number>> = {};
    for (const [fam, counts] of Object.entries(prefixesByFamily)) {
      const kept: Record<string, number> = {};
      for (const [pfx, n] of Object.entries(counts)) {
        if (n >= args.min_support) kept[pfx] = n;
      }
      if (Object.keys(kept).length > 0) filtered[fam] = kept;
    }
    let bestCase: Case | undefined;
    if (total > 0) {
      let bestKey = "";
      let bestN = 0;
      for (const [k, v] of Object.entries(caseCounts)) {
        if (v > bestN) {
          bestN = v;
          bestKey = k;
        }
      }
      if (bestN / total >= 0.6) bestCase = bestKey as Case;
    }
    const naming: { case?: Case; prefixes_by_family: Record<string, Record<string, number>> } = {
      prefixes_by_family: filtered,
    };
    if (bestCase) naming.case = bestCase;
    extract.naming = naming;
    if (bestCase) extract.naming_label = bestCase;
  }

  if (obs.has("recipe-style")) {
    const clusters = new Map<string, RecipeShape>();
    for (const r of stats.recipeShapeRows) {
      let cl = clusters.get(r.signature);
      if (!cl) {
        cl = {
          archetype: r.archetype,
          typical_children: r.types.slice(0, 5),
          edge_bucket: r.edgeBucket,
          count: 0,
          sample_paths: [],
        };
        clusters.set(r.signature, cl);
      }
      cl.count += 1;
      if (cl.sample_paths.length < 3) cl.sample_paths.push(r.path);
    }
    const shapes = [...clusters.values()]
      .filter((s) => s.count >= args.min_support)
      .sort((a, b) => b.count - a.count);
    extract.recipe_shapes = shapes;

    // favorite generators from dominant archetypes
    const favs = new Set<string>();
    for (const s of shapes) {
      for (const t of s.typical_children) {
        const fav = GENERATOR_BY_TYPE[t.toLowerCase()];
        if (fav) favs.add(fav);
      }
    }
    if (favs.size > 0) extract.favorite_generators = [...favs];
  }

  if (obs.has("param-defaults")) {
    const out = [...stats.paramTally.values()]
      .filter((x) => x.support >= args.min_support)
      .sort((a, b) => b.support - a.support)
      .slice(0, 20);
    extract.param_defaults = out;
  }

  return extract;
}

function buildSummaryBody(extract: CorpusStyleExtract): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`## Corpus style learned ${today}`];
  lines.push(
    `- Scanned: ${extract.scanned.recipes} recipes, ${extract.scanned.components} components, ${extract.scanned.looks} looks`,
  );
  lines.push(`- Palettes: ${extract.palettes?.length ?? 0}`);
  lines.push(`- Naming: ${extract.naming_label ?? "—"}`);
  lines.push(`- Recipe shapes: ${extract.recipe_shapes?.length ?? 0}`);
  lines.push(`- Param defaults: ${extract.param_defaults?.length ?? 0}`);
  return `${lines.join("\n")}\n`;
}

function buildPatch(extract: CorpusStyleExtract): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    scanned: extract.scanned,
    sample_size: extract.sample_size,
    tags: ["corpus", "learned"],
  };
  if (extract.palettes !== undefined) patch.palettes = extract.palettes;
  if (extract.top_hexes !== undefined) patch.top_hexes = extract.top_hexes;
  if (extract.naming !== undefined) patch.naming = extract.naming;
  if (extract.recipe_shapes !== undefined) patch.recipe_shapes = extract.recipe_shapes;
  if (extract.param_defaults !== undefined) patch.param_defaults = extract.param_defaults;
  return patch;
}

function buildStylePatch(extract: CorpusStyleExtract): {
  palettes?: Palette[];
  naming?: string;
  favorite_generators?: string[];
} {
  const patch: { palettes?: Palette[]; naming?: string; favorite_generators?: string[] } = {};
  if (extract.palettes && extract.palettes.length > 0) {
    patch.palettes = extract.palettes.map((p) => {
      const out: Palette = { colors: p.colors };
      if (p.name) out.name = p.name;
      return out;
    });
  }
  if (extract.naming_label) patch.naming = extract.naming_label;
  if (extract.favorite_generators && extract.favorite_generators.length > 0)
    patch.favorite_generators = extract.favorite_generators;
  return patch;
}

function hasStyleContent(patch: {
  palettes?: Palette[];
  naming?: string;
  favorite_generators?: string[];
}): boolean {
  return Boolean(
    (patch.palettes && patch.palettes.length > 0) ||
      patch.naming ||
      (patch.favorite_generators && patch.favorite_generators.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function learnFromMyCorpusImpl(ctx: ToolContext, args: LearnFromMyCorpusArgs) {
  let vault: Vault;
  if (args.vault_path) {
    try {
      vault = new Vault(args.vault_path, ctx.logger);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Could not open vault at ${args.vault_path}: ${reason}`);
    }
  } else {
    const v = requireVault(ctx);
    if ("error" in v) return v.error;
    vault = v.vault;
  }

  const stats = scanCorpus(vault, args);
  const extract = extractStyle(stats, args);

  let wroteStyleMemory = false;
  if (!args.dry_run) {
    mergeMemoryFrontmatter(
      vault,
      CORPUS_STYLE_TOPIC,
      buildPatch(extract),
      buildSummaryBody(extract),
    );
    if (args.also_patch_style_memory) {
      const stylePatch = buildStylePatch(extract);
      if (hasStyleContent(stylePatch)) {
        mergeStyleMemory(vault, stylePatch);
        wroteStyleMemory = true;
      }
    }
  }

  const noteRel = memoryNoteRel(CORPUS_STYLE_TOPIC);
  const summary = args.dry_run
    ? `Scanned ${extract.sample_size} corpus item(s) (dry run — no vault writes).`
    : `Learned corpus style from ${extract.sample_size} item(s) → ${noteRel}.`;
  return jsonResult(summary, {
    note: noteRel,
    wrote_note: !args.dry_run,
    wrote_style_memory: wroteStyleMemory,
    corpus_style: extract,
  });
}

export const registerLearnFromMyCorpus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "learn_from_my_corpus",
    {
      title: "Learn the artist's house style from the saved vault corpus",
      description:
        "Offline companion to `learn_conventions`: walks the Obsidian vault corpus " +
        "(Recipes/, Components/, Looks/, Setlists/, Moodboards/) and distils palette, " +
        "naming, recipe-shape, and param-default preferences into Memory/corpus_style.md " +
        "(and optionally merges palettes/naming/favorite_generators into Memory/style.md). " +
        "No TouchDesigner required — pure filesystem read. Requires TDMCP_VAULT_PATH " +
        "(or pass `vault_path`).",
      inputSchema: learnFromMyCorpusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => learnFromMyCorpusImpl(ctx, args),
  );
};
