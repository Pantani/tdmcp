import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

/**
 * `tag_and_search_library` — faceted browse + tag editing over a vault library
 * (`<vault>/Recipes/*.md` + `<vault>/Components/*.md`). Pure file I/O via the
 * configured Vault adapter; no TouchDesigner bridge involved.
 *
 * `op: "tag"` — union/replace the `tags` list on one asset's frontmatter,
 *   preserving '*'-pinned user tags (same convention as `auto_tag_library_asset`).
 * `op: "search"` — return assets whose frontmatter `tags` and/or text matches
 *   the query / `tags_any` / `tags_all` filters.
 * `op: "list"` — list every known asset with its tag set (no filtering).
 */

const SCAN_FOLDERS = ["Recipes", "Components"] as const;

export const tagAndSearchLibrarySchema = z.object({
  op: z
    .enum(["tag", "search", "list"])
    .default("search")
    .describe("Operation: 'tag' edits one asset; 'search' / 'list' read across the library."),
  asset_path: z
    .string()
    .optional()
    .describe(
      "Vault-relative path to one asset note (e.g. 'Recipes/feedback_tunnel.md'). Required for op='tag'.",
    ),
  tags: z
    .array(z.string())
    .default([])
    .describe("op='tag': tags to apply. Tags prefixed '*' are preserved as user-pinned."),
  replace: z
    .boolean()
    .default(false)
    .describe("op='tag': when true, replace existing tags (kept '*'-pinned); when false, union."),
  query: z
    .string()
    .optional()
    .describe(
      "op='search': free-text substring matched against id/name/description/tags (case-insensitive).",
    ),
  tags_any: z
    .array(z.string())
    .default([])
    .describe("op='search': match assets that carry at least one of these tags."),
  tags_all: z
    .array(z.string())
    .default([])
    .describe("op='search': match assets that carry every one of these tags."),
  folders: z
    .array(z.string())
    .default([...SCAN_FOLDERS])
    .describe("Vault subfolders to scan. Defaults to ['Recipes', 'Components']."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Maximum number of matches to return."),
});
export type TagAndSearchLibraryArgs = z.infer<typeof tagAndSearchLibrarySchema>;

interface AssetEntry {
  path: string;
  id?: string;
  name?: string;
  description?: string;
  tags: string[];
  difficulty?: string;
}

function normalizeTagList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t)).filter((t) => t.trim().length > 0);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function lower(s: string): string {
  return s.toLowerCase();
}

export const registerTagAndSearchLibrary: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "tag_and_search_library",
    {
      title: "Tag & search the vault library",
      description:
        "Faceted browse + tag editing over a vault library (Recipes/ + Components/ markdown notes). " +
        "op='list' enumerates every asset and its tags; op='search' filters by free-text query and/or " +
        "`tags_any`/`tags_all` set logic; op='tag' edits one asset's frontmatter tags (union or replace, " +
        "always preserving '*'-pinned user tags). Pure vault I/O — no TouchDesigner bridge required. " +
        "Requires TDMCP_VAULT_PATH.",
      inputSchema: tagAndSearchLibrarySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => tagAndSearchLibraryImpl(ctx, args),
  );
};

export async function tagAndSearchLibraryImpl(ctx: ToolContext, args: TagAndSearchLibraryArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  if (args.op === "tag") {
    if (!args.asset_path) {
      return errorResult("asset_path is required for op='tag'.");
    }
    let assetExists: boolean;
    try {
      assetExists = vault.exists(args.asset_path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Invalid vault path: ${reason}`);
    }
    if (!assetExists) {
      return errorResult(`Vault asset not found: ${args.asset_path}`);
    }
    const note = readNoteSafe(vault, args.asset_path);
    if ("error" in note) return note.error;

    const existing = normalizeTagList(note.data.tags);
    const pinned = existing.filter((t) => t.startsWith("*"));
    const nonPinned = existing.filter((t) => !t.startsWith("*"));

    const incoming = args.tags.map((t) => t.trim()).filter(Boolean);
    const incomingPinned = incoming.filter((t) => t.startsWith("*"));
    const incomingPlain = incoming.filter((t) => !t.startsWith("*"));

    const base = args.replace ? [] : nonPinned;
    // Lowercased + dedup, preserving original casing of the first appearance.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const t of [...base, ...incomingPlain]) {
      const key = lower(t);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }
    // Union pinned tags from existing + incoming.
    const allPinned: string[] = [];
    const seenPinned = new Set<string>();
    for (const t of [...pinned, ...incomingPinned]) {
      if (seenPinned.has(t)) continue;
      seenPinned.add(t);
      allPinned.push(t);
    }
    const finalTags = [...merged, ...allPinned];
    const added = merged.filter((t) => !nonPinned.map(lower).includes(lower(t)));
    const removed = args.replace
      ? nonPinned.filter((t) => !merged.map(lower).includes(lower(t)))
      : [];

    const nextData = { ...note.data, tags: finalTags };
    try {
      vault.writeNote(args.asset_path, nextData, note.body);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Could not write vault note "${args.asset_path}": ${reason}`);
    }
    return jsonResult(
      `Updated tags on ${args.asset_path} (${finalTags.length} total, +${added.length}/-${removed.length}).`,
      {
        asset_path: args.asset_path,
        tags: finalTags,
        added,
        removed,
        kept_user_tags: allPinned,
      },
    );
  }

  // ---- list / search ----
  const allAssets: AssetEntry[] = [];
  for (const folder of args.folders) {
    let files: string[];
    try {
      files = vault.list(folder, ".md");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Invalid vault folder "${folder}": ${reason}`);
    }
    for (const file of files) {
      const rel = `${folder}/${file}`;
      const note = readNoteSafe(vault, rel);
      if ("error" in note) continue; // skip unreadable notes silently in search
      const data = note.data;
      allAssets.push({
        path: rel,
        id: typeof data.id === "string" ? data.id : undefined,
        name: typeof data.name === "string" ? data.name : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        tags: normalizeTagList(data.tags),
        difficulty: typeof data.difficulty === "string" ? data.difficulty : undefined,
      });
    }
  }

  if (args.op === "list") {
    const truncated = allAssets.slice(0, args.limit);
    return jsonResult(`Listed ${truncated.length} library asset(s).`, {
      total: allAssets.length,
      assets: truncated,
    });
  }

  // op === "search"
  const q = args.query ? lower(args.query.trim()) : "";
  const any = args.tags_any.map(lower);
  const all = args.tags_all.map(lower);

  const matches = allAssets.filter((a) => {
    const aTagsLower = a.tags.map(lower);
    if (any.length > 0 && !any.some((t) => aTagsLower.includes(t))) return false;
    if (all.length > 0 && !all.every((t) => aTagsLower.includes(t))) return false;
    if (q) {
      const haystack = lower(
        `${a.id ?? ""} ${a.name ?? ""} ${a.description ?? ""} ${a.tags.join(" ")}`,
      );
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const truncated = matches.slice(0, args.limit);
  return jsonResult(`Found ${matches.length} match(es); returning ${truncated.length}.`, {
    total: matches.length,
    returned: truncated.length,
    matches: truncated,
  });
}
