import { basename, extname } from "node:path";
import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const browseVaultLibrarySchema = z.object({
  kinds: z
    .array(z.enum(["recipes", "shaders", "presets", "components", "setlists", "all"]))
    .default(["all"])
    .describe("Which library categories to list. 'all' lists every known category."),
  query: z.string().optional().describe("Case-insensitive substring filter on note title/tags."),
});
type BrowseVaultLibraryArgs = z.infer<typeof browseVaultLibrarySchema>;

export const browseVaultLibraryOutputSchema = z.object({
  vault_path: z.string().describe("Absolute path of the configured vault root."),
  items: z.array(
    z.object({
      kind: z.string().describe("Category: recipes|shaders|presets|components|setlists"),
      title: z.string().describe("Frontmatter title, or the filename stem when absent."),
      path: z.string().describe("Vault-relative path of the note (e.g. Recipes/glow.md)."),
      tags: z.array(z.string()).describe("Tags extracted from frontmatter, normalised to strings."),
      description: z.string().optional().describe("Frontmatter description, or first body line."),
    }),
  ),
  counts: z.record(z.string(), z.number()).describe("Number of matched items per category."),
  warnings: z.array(z.string()).describe("Per-folder read problems; browse continues on error."),
});

/** All recognised vault categories and their folder names (matching scaffoldVault). */
const CATEGORY_FOLDERS: Record<string, string> = {
  recipes: "Recipes",
  shaders: "Shaders",
  presets: "Presets",
  components: "Components",
  setlists: "Setlists",
};

const ALL_KINDS = Object.keys(CATEGORY_FOLDERS) as Array<keyof typeof CATEGORY_FOLDERS>;

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

/** Extract the first non-blank line from a markdown body. */
function firstBodyLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return undefined;
}

/** Returns true when the item matches the query (case-insensitive substring on title + tags). */
function matchesQuery(title: string, tags: string[], query: string): boolean {
  const q = query.toLowerCase();
  if (title.toLowerCase().includes(q)) return true;
  return tags.some((t) => t.toLowerCase().includes(q));
}

export async function browseVaultLibraryImpl(ctx: ToolContext, args: BrowseVaultLibraryArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  // Expand 'all' to every known category; de-duplicate.
  const requested = args.kinds.includes("all") ? ALL_KINDS : [...new Set(args.kinds)];

  const items: Array<{
    kind: string;
    title: string;
    path: string;
    tags: string[];
    description?: string;
  }> = [];
  const counts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const kind of requested) {
    const folder = CATEGORY_FOLDERS[kind];
    if (!folder) continue; // should not happen given the enum, but guard anyway

    // vault.list() returns [] for missing dirs — no throw.
    const files = vault.list(folder, ".md");
    let kindCount = 0;

    for (const filename of files) {
      const relPath = `${folder}/${filename}`;
      const noteResult = readNoteSafe(vault, relPath);
      if ("error" in noteResult) {
        warnings.push(`Could not read ${relPath}: skipped.`);
        continue;
      }
      const { data, body } = noteResult;

      const stem = basename(filename, extname(filename));
      const title = fmString(data, "title") ?? fmString(data, "name") ?? stem;
      const tags = fmTags(data);
      const description =
        fmString(data, "description") ?? fmString(data, "desc") ?? firstBodyLine(body);

      if (args.query && !matchesQuery(title, tags, args.query)) continue;

      items.push({ kind, title, path: relPath, tags, ...(description ? { description } : {}) });
      kindCount += 1;
    }

    counts[kind] = kindCount;
  }

  const totalItems = items.length;
  const totalKinds = requested.filter((k) => (counts[k] ?? 0) > 0).length;
  const summary =
    totalItems === 0
      ? `No items found${args.query ? ` matching "${args.query}"` : ""} in the vault library.`
      : `${totalItems} item(s) across ${totalKinds} categor${totalKinds === 1 ? "y" : "ies"} in ${vault.root}.`;

  return structuredResult(summary, {
    vault_path: vault.root,
    items,
    counts,
    warnings,
  });
}

export const registerBrowseVaultLibrary: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "browse_vault_library",
    {
      title: "Browse vault library",
      description:
        "Read-only: list the vault's recipes, shaders, presets, components, and setlists with title, tags, and description so the agent can pick from the library without opening individual notes. Filter by category (kinds) and/or a substring query. Returns a flat items array and per-category counts. No TouchDesigner connection required — reads the local vault on disk. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: browseVaultLibrarySchema.shape,
      outputSchema: browseVaultLibraryOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => browseVaultLibraryImpl(ctx, args),
  );
};
