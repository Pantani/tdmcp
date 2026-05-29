import { basename, extname } from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const generateLibraryIndexSchema = z.object({
  kinds: z
    .array(z.enum(["recipes", "shaders", "presets", "components", "setlists", "all"]))
    .default(["all"])
    .describe("Which library categories to include. 'all' = every category."),
  output: z
    .string()
    .default("Library Index.md")
    .describe("Vault-relative path of the contact-sheet note to write."),
  include_thumbnails: z
    .boolean()
    .default(true)
    .describe("Embed each asset's <stem>.png sibling when present; false = text-only."),
  columns: z.coerce
    .number()
    .int()
    .min(1)
    .max(6)
    .default(3)
    .describe("Cards per row in the contact-sheet grid."),
  query: z.string().optional().describe("Case-insensitive substring filter on title/tags."),
  overwrite: z
    .boolean()
    .default(true)
    .describe("When false, refuse to overwrite an existing index note."),
});
type GenerateLibraryIndexArgs = z.infer<typeof generateLibraryIndexSchema>;

/** All recognised vault categories and their folder names (matching scaffoldVault). */
const CATEGORY_FOLDERS: Record<string, string> = {
  recipes: "Recipes",
  shaders: "Shaders",
  presets: "Presets",
  components: "Components",
  setlists: "Setlists",
};

const ALL_KINDS = Object.keys(CATEGORY_FOLDERS) as Array<keyof typeof CATEGORY_FOLDERS>;

// ── frontmatter helpers (copied from browseVaultLibrary.ts; do not import across tool
//    files — keeping the two walkers decoupled is a wave constraint). ─────────────────

/** Pull a string value from frontmatter data; returns undefined when absent or wrong type. */
function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

/** Pull a tag array from frontmatter. Handles string[], string (comma-split), or missing. */
function fmTags(data: Record<string, unknown>): string[] {
  const v = data.tags;
  if (Array.isArray(v)) return v.map((t) => String(t)).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

/** Returns true when the item matches the query (case-insensitive substring on title + tags). */
function matchesQuery(title: string, tags: string[], query: string): boolean {
  const q = query.toLowerCase();
  if (title.toLowerCase().includes(q)) return true;
  return tags.some((t) => t.toLowerCase().includes(q));
}

// ── contact-sheet rendering ───────────────────────────────────────────────────────

interface IndexCard {
  title: string;
  tags: string[];
  /** Sibling PNG vault path when present + thumbnails enabled, else null. */
  png: string | null;
  /** Inline-code load snippet, or an Obsidian [[wikilink]] fallback. */
  snippet: string;
}

const CATEGORY_TITLES: Record<string, string> = {
  recipes: "Recipes",
  shaders: "Shaders",
  presets: "Presets",
  components: "Components",
  setlists: "Setlists",
};

/**
 * The copy-paste tool call a VJ pastes back to the agent to load an asset.
 *
 * Only emits a tool-call snippet for tools whose parameter shape is confirmed in
 * the registry (apply_recipe `id`, manage_component `action`/`file_path`,
 * apply_shader_from_vault `note`, import_setlist `note`). Presets are stored in a
 * COMP's storage and have no note-path load shape, so they fall back to a wikilink.
 */
function loadSnippet(
  kind: string,
  stem: string,
  relPath: string,
  data: Record<string, unknown>,
): string {
  switch (kind) {
    case "recipes": {
      const id = fmString(data, "id") ?? stem;
      return `\`apply_recipe id=${id}\``;
    }
    case "components": {
      const tox = fmString(data, "tox") ?? `Components/${stem}.tox`;
      return `\`manage_component action=load file_path=<vault>/${tox}\``;
    }
    case "shaders":
      return `\`apply_shader_from_vault note=${relPath}\``;
    case "setlists":
      return `\`import_setlist note=${relPath}\``;
    default:
      // presets (no note-path load shape) and any unknown kind → wikilink fallback.
      return `[[${stem}]]`;
  }
}

/** Escape a value for a Markdown table cell: a raw `|` splits columns, a newline splits rows. */
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** One contact-sheet cell: thumbnail, bold title, dim tags, load snippet. */
function renderCell(card: IndexCard): string {
  const thumb = card.png ? `![[${basename(card.png)}]]` : "_(no preview)_";
  const tags = mdCell(card.tags.join(", "));
  return `${thumb}<br>**${mdCell(card.title)}**<br><small>${tags}</small><br>${mdCell(card.snippet)}`;
}

/** Render one category's cards into a Markdown grid table `columns` wide. */
function renderSection(title: string, cards: IndexCard[], columns: number): string {
  const lines: string[] = [`## ${title} (${cards.length})`, ""];
  // Header row + separator (empty headers; cells carry their own labels).
  lines.push(`|${" |".repeat(columns)}`);
  lines.push(`|${"---|".repeat(columns)}`);
  for (let i = 0; i < cards.length; i += columns) {
    const row = cards.slice(i, i + columns).map(renderCell);
    while (row.length < columns) row.push("");
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function generateLibraryIndexImpl(ctx: ToolContext, args: GenerateLibraryIndexArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  // Refuse to clobber an existing index when overwrite is off.
  let outResolveError: string | undefined;
  try {
    vault.resolve(args.output);
  } catch (err) {
    outResolveError = err instanceof Error ? err.message : String(err);
  }
  if (outResolveError) {
    return errorResult(`Cannot write the index note: ${outResolveError}`);
  }
  if (!args.overwrite && vault.exists(args.output)) {
    return errorResult(
      `An index note already exists at "${args.output}". Re-run with overwrite:true to replace it.`,
    );
  }

  const requested = args.kinds.includes("all") ? ALL_KINDS : [...new Set(args.kinds)];

  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  const sections: Array<{ kind: string; cards: IndexCard[] }> = [];
  let withThumbnails = 0;
  let withoutThumbnails = 0;

  for (const kind of requested) {
    const folder = CATEGORY_FOLDERS[kind];
    if (!folder) continue;

    const files = vault.list(folder, ".md");
    const cards: IndexCard[] = [];

    for (const filename of files) {
      const relPath = `${folder}/${filename}`;
      const note = readNoteSafe(vault, relPath);
      if ("error" in note) {
        warnings.push(`Could not read ${relPath}: skipped.`);
        continue;
      }
      const { data } = note;

      const stem = basename(filename, extname(filename));
      const title = fmString(data, "title") ?? fmString(data, "name") ?? stem;
      const tags = fmTags(data);
      // The card renders title + tags + snippet (no description), so the query matches on
      // title + tags exactly as browse_vault_library does.
      if (args.query && !matchesQuery(title, tags, args.query)) continue;

      // Sibling-PNG thumbnail resolution — pure FS check, no bridge call.
      const pngRel = `${folder}/${stem}.png`;
      const png = args.include_thumbnails && vault.exists(pngRel) ? pngRel : null;
      if (png) withThumbnails += 1;
      else withoutThumbnails += 1;

      cards.push({
        title,
        tags,
        png,
        snippet: loadSnippet(kind, stem, relPath, data),
      });
    }

    counts[kind] = cards.length;
    if (cards.length > 0) sections.push({ kind, cards });
  }

  const total = sections.reduce((n, s) => n + s.cards.length, 0);
  const categoryCount = sections.length;

  // Build the note body.
  const generated = new Date().toISOString();
  const bodyParts: string[] = ["# Library Index", ""];
  if (total === 0) {
    bodyParts.push(
      `_No library assets found${args.query ? ` matching "${args.query}"` : ""}. ` +
        "Save recipes/components to the vault, then regenerate with `generate_library_index`._",
    );
  } else {
    bodyParts.push(
      `_${total} asset(s) across ${categoryCount} categor${
        categoryCount === 1 ? "y" : "ies"
      }. Regenerate with \`generate_library_index\`._`,
      "",
    );
    for (const { kind, cards } of sections) {
      bodyParts.push(renderSection(CATEGORY_TITLES[kind] ?? kind, cards, args.columns));
    }
  }
  const body = bodyParts.join("\n").trimEnd();

  vault.writeNote(args.output, { type: "library-index", generated, kinds: requested }, body);

  const summary =
    total === 0
      ? `Wrote ${args.output} — no library assets found.`
      : `Wrote ${args.output} — ${total} asset(s) across ${categoryCount} categor${
          categoryCount === 1 ? "y" : "ies"
        } (${withThumbnails} with thumbnails).`;

  return structuredResult(summary, {
    index_path: args.output,
    total,
    counts,
    with_thumbnails: withThumbnails,
    without_thumbnails: withoutThumbnails,
    warnings,
  });
}

export const registerGenerateLibraryIndex: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "generate_library_index",
    {
      title: "Generate library index",
      description:
        "Write one Markdown contact-sheet note of the whole vault library — recipes, shaders, presets, components, and setlists — as a grid of cards, each with its thumbnail (the <stem>.png sibling written by save_recipe_to_vault / save_component_to_vault), title, tags, and a copy-paste load snippet (e.g. `apply_recipe id=…`). No TouchDesigner connection required: it reads the local vault on disk and writes the index note. Filter by category (kinds) and/or a substring query. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: generateLibraryIndexSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => generateLibraryIndexImpl(ctx, args),
  );
};
