import { basename, extname } from "node:path";
import { z } from "zod";
import type { Vault } from "../../vault/index.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

/**
 * Centralised vault layout/field names. If `foundation_memory_note` lands a
 * different folder name or frontmatter shape, fix it here and the search keeps
 * working.
 */
const MEMORY_FOLDER = "Memory";
const FIELD_TITLE = "title";
const FIELD_INTENT = "intent";
const FIELD_TAGS = "tags";
const FIELD_OPS = "ops";
const FIELD_RECIPE = "recipe";
const FIELD_PROMPT = "prompt";
const FIELD_PREVIEW = "preview";
const FIELD_CREATED = "created";
const MAX_SCAN = 2000;

const STOPWORDS = new Set(["the", "a", "an", "with", "and", "or", "of", "for", "to", "in", "on"]);

export const recallSimilarWorkSchema = z.object({
  query: z.string().min(1).describe("Free-text goal/prompt to compare past memory notes against."),
  tags: z
    .array(z.string())
    .default([])
    .describe(
      "Optional tags that should boost matching notes (additive). Lowercased before match.",
    ),
  ops: z
    .array(z.string())
    .default([])
    .describe(
      "Optional operator types you expect to use (e.g. audioAnalysisCHOP). Boosts notes whose 'ops' overlap.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe("Maximum number of hits to return after sorting."),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe("Drop hits whose normalised score is below this threshold."),
  include_body_snippet: z
    .boolean()
    .default(true)
    .describe("When true, return a ~240-char body excerpt around the best-matching line."),
});
type RecallSimilarWorkArgs = z.infer<typeof recallSimilarWorkSchema>;

export const recallSimilarWorkOutputSchema = z.object({
  vault_path: z.string().describe("Absolute path of the configured vault root."),
  query: z.string().describe("Echo of the input query (post-trim)."),
  hits: z.array(
    z.object({
      path: z.string().describe("Vault-relative path of the memory note."),
      title: z.string().describe("Frontmatter title, or the filename stem when absent."),
      intent: z.string().optional().describe("Frontmatter intent, if present."),
      tags: z.array(z.string()).describe("Note tags, lowercased + deduped."),
      ops: z.array(z.string()).describe("Operator types listed on the note."),
      recipe: z.string().optional().describe("Recipe path referenced by the note."),
      prompt: z.string().optional().describe("Original artist prompt that produced this note."),
      preview: z.string().optional().describe("Preview image path inside the vault."),
      score: z.number().describe("Normalised 0..1 relevance score."),
      matched: z.object({
        query_terms: z.array(z.string()).describe("Query tokens that hit any searched field."),
        tag_overlap: z.array(z.string()).describe("Tags in common with the query's tags."),
        op_overlap: z.array(z.string()).describe("Ops in common with the query's ops."),
      }),
      snippet: z.string().optional().describe("Optional ±120-char body excerpt."),
    }),
  ),
  scanned: z.number().describe("Number of memory notes considered."),
  warnings: z.array(z.string()).describe("Per-note read problems; search continues on error."),
});

interface NoteRecord {
  path: string;
  title: string;
  intent?: string;
  tags: string[];
  ops: string[];
  recipe?: string;
  prompt?: string;
  preview?: string;
  body: string;
  created?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function fmStringArray(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

function dedupLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function buildSnippet(body: string, terms: string[]): string | undefined {
  if (!body) return undefined;
  const lower = body.toLowerCase();
  let hitIdx = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (hitIdx === -1 || idx < hitIdx)) hitIdx = idx;
  }
  if (hitIdx === -1) {
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t) return t.slice(0, 240);
    }
    return undefined;
  }
  const start = Math.max(0, hitIdx - 120);
  const end = Math.min(body.length, hitIdx + 120);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return slice;
}

function loadNotes(vault: Vault, warnings: string[]): { notes: NoteRecord[]; scanned: number } {
  const files = vault.list(MEMORY_FOLDER, ".md").slice(0, MAX_SCAN);
  const notes: NoteRecord[] = [];
  for (const filename of files) {
    const relPath = `${MEMORY_FOLDER}/${filename}`;
    const parsed = readNoteSafe(vault, relPath);
    if ("error" in parsed) {
      warnings.push(`Could not read ${relPath}: skipped (malformed frontmatter or unreadable).`);
      continue;
    }
    const { data, body } = parsed;
    const stem = basename(filename, extname(filename));
    notes.push({
      path: relPath,
      title: fmString(data, FIELD_TITLE) ?? stem,
      intent: fmString(data, FIELD_INTENT),
      tags: dedupLower(fmStringArray(data, FIELD_TAGS)),
      ops: fmStringArray(data, FIELD_OPS),
      recipe: fmString(data, FIELD_RECIPE),
      prompt: fmString(data, FIELD_PROMPT),
      preview: fmString(data, FIELD_PREVIEW),
      body,
      created: fmString(data, FIELD_CREATED),
    });
  }
  return { notes, scanned: notes.length };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function recallSimilarWorkImpl(ctx: ToolContext, args: RecallSimilarWorkArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const query = args.query.trim();
  const queryTokens = new Set(tokenize(query));
  const queryTags = dedupLower(args.tags);
  const queryOps = args.ops.map((o) => o.trim()).filter(Boolean);

  const warnings: string[] = [];
  const { notes, scanned } = loadNotes(vault, warnings);

  // Weight redistribution: if user provided no tags / no ops, those weights go into text.
  let wText = 0.6;
  const wTag = queryTags.length > 0 ? 0.25 : 0;
  const wOp = queryOps.length > 0 ? 0.15 : 0;
  wText = 1 - wTag - wOp;

  type Scored = {
    note: NoteRecord;
    score: number;
    matchedTerms: string[];
    tagOverlap: string[];
    opOverlap: string[];
  };
  const scored: Scored[] = [];

  for (const note of notes) {
    const searchableParts = [
      note.title,
      note.intent ?? "",
      note.prompt ?? "",
      note.tags.join(" "),
      note.body.slice(0, 1024),
    ];
    const noteTokens = new Set(tokenize(searchableParts.join(" ")));
    const text = jaccard(queryTokens, noteTokens);

    const noteTagSet = new Set(note.tags);
    const tagOverlap = queryTags.filter((t) => noteTagSet.has(t));
    const tag = queryTags.length > 0 ? tagOverlap.length / queryTags.length : 0;

    const noteOpsLower = new Set(note.ops.map((o) => o.toLowerCase()));
    const opOverlap = queryOps.filter((o) => noteOpsLower.has(o.toLowerCase()));
    const op = queryOps.length > 0 ? opOverlap.length / queryOps.length : 0;

    const score = wText * text + wTag * tag + wOp * op;

    const matchedTerms: string[] = [];
    for (const t of queryTokens) if (noteTokens.has(t)) matchedTerms.push(t);

    scored.push({ note, score, matchedTerms, tagOverlap, opOverlap });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ac = a.note.created ?? "";
    const bc = b.note.created ?? "";
    return bc.localeCompare(ac);
  });

  const filtered = scored.filter((s) => s.score >= args.min_score).slice(0, args.limit);

  const hits = filtered.map((s) => {
    const hit: {
      path: string;
      title: string;
      intent?: string;
      tags: string[];
      ops: string[];
      recipe?: string;
      prompt?: string;
      preview?: string;
      score: number;
      matched: { query_terms: string[]; tag_overlap: string[]; op_overlap: string[] };
      snippet?: string;
    } = {
      path: s.note.path,
      title: s.note.title,
      tags: s.note.tags,
      ops: s.note.ops,
      score: Number(s.score.toFixed(4)),
      matched: {
        query_terms: s.matchedTerms,
        tag_overlap: s.tagOverlap,
        op_overlap: s.opOverlap,
      },
    };
    if (s.note.intent !== undefined) hit.intent = s.note.intent;
    if (s.note.recipe !== undefined) hit.recipe = s.note.recipe;
    if (s.note.prompt !== undefined) hit.prompt = s.note.prompt;
    if (s.note.preview !== undefined) hit.preview = s.note.preview;
    if (args.include_body_snippet) {
      const snippet = buildSnippet(s.note.body, [...queryTokens]);
      if (snippet !== undefined) hit.snippet = snippet;
    }
    return hit;
  });

  const summary =
    hits.length === 0
      ? `recall_similar_work — no matches for "${query}" (scanned ${scanned}).`
      : `recall_similar_work — ${hits.length} hit(s) for "${query}" (scanned ${scanned}).`;

  return structuredResult(summary, {
    vault_path: vault.root,
    query,
    hits,
    scanned,
    warnings,
  });
}

export const registerRecallSimilarWork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "recall_similar_work",
    {
      title: "Recall similar past work",
      description:
        "Read-only vault search: rank past memory notes by similarity to a new visual goal so the agent can reuse prior recipes, params, and prompts instead of rebuilding from scratch. Scores by query-token overlap with title/intent/prompt/tags/body, with optional tag and op boosts. Returns ranked hits with vault paths, score, matched terms, and an optional body snippet. Offline; requires TDMCP_VAULT_PATH.",
      inputSchema: recallSimilarWorkSchema.shape,
      outputSchema: recallSimilarWorkOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => recallSimilarWorkImpl(ctx, args),
  );
};
