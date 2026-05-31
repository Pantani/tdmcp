import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "../vault/shared.js";

// ── Input schema ──────────────────────────────────────────────────────────────

export const componentChangelogTrailSchema = z.object({
  componentPath: z
    .string()
    .describe(
      "Vault-relative path to the .tox file (e.g. 'Components/MyFx.tox'). " +
        "The trail is stored as a sibling file '<componentPath>.trail.jsonl'.",
    ),
  action: z
    .enum(["append", "read", "export"])
    .default("read")
    .describe(
      "append: add a new revision entry. read: return all entries as JSON. " +
        "export: render the trail as a markdown changelog note next to the .tox.",
    ),
  entry: z
    .object({
      ts: z.string().datetime().optional().describe("ISO-8601 timestamp. Defaults to now()."),
      author: z
        .string()
        .optional()
        .describe(
          "Author label. Defaults to TDMCP_AUTHOR env var, then os.userInfo().username, then 'unknown'.",
        ),
      note: z.string().min(1).describe("Short human-readable description of this revision."),
      changedParams: z
        .array(z.string())
        .default([])
        .describe(
          "Optional list of parameter paths whose values changed in this revision " +
            "(e.g. ['transform1/tx','transform1/ty']).",
        ),
    })
    .optional()
    .describe("Required when action='append'. Ignored for read/export."),
  includeSha: z
    .boolean()
    .default(true)
    .describe(
      "On append, hash the .tox bytes with sha256 and store it on the entry — " +
        "lets you cross-reference with provenance_stamp's sidecar.",
    ),
  exportNoteName: z
    .string()
    .optional()
    .describe(
      "On export, the markdown filename (defaults to '<component>.CHANGELOG.md' next to the .tox).",
    ),
});

export type ComponentChangelogTrailArgs = z.infer<typeof componentChangelogTrailSchema>;

// ── Trail entry type ──────────────────────────────────────────────────────────

interface TrailEntry {
  schema_version: 1;
  ts: string;
  author: string;
  note: string;
  changedParams: string[];
  sha256?: string;
  size?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAuthor(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.TDMCP_AUTHOR;
  if (env) return env;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => res(hash.digest("hex")));
    stream.on("error", rej);
  });
}

function readTrail(trailPath: string): { entries: TrailEntry[]; warnings: string[] } {
  if (!existsSync(trailPath)) return { entries: [], warnings: [] };
  const raw = readFileSync(trailPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: TrailEntry[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      entries.push(JSON.parse(line ?? "") as TrailEntry);
    } catch {
      warnings.push(`Line ${i} could not be parsed: ${line}`);
    }
  }
  return { entries, warnings };
}

function trailRelPath(componentPath: string): string {
  return `${componentPath}.trail.jsonl`;
}

function exportNoteRelPath(componentPath: string, exportNoteName?: string): string {
  if (exportNoteName) {
    return join(dirname(componentPath), exportNoteName);
  }
  return `${componentPath}.CHANGELOG.md`;
}

function renderMarkdown(componentPath: string, entries: TrailEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.ts.localeCompare(a.ts));
  const lines: string[] = [];
  for (const e of sorted) {
    lines.push(`- **${e.ts}** — @${e.author} — ${e.note}`);
    if (e.changedParams.length > 0) {
      lines.push(`  - changed: ${e.changedParams.map((p) => `\`${p}\``).join(", ")}`);
    }
    if (e.sha256) {
      lines.push(`  - sha256: \`${e.sha256}\``);
    }
  }
  const body = `## Revisions\n\n${lines.join("\n")}\n`;
  const frontmatter = { type: "component-changelog", tox: basename(componentPath) };
  return `---\ntype: ${frontmatter.type}\ntox: ${frontmatter.tox}\n---\n\n${body}`;
}

// ── Impl ──────────────────────────────────────────────────────────────────────

export async function componentChangelogTrailImpl(
  ctx: ToolContext,
  args: ComponentChangelogTrailArgs,
): Promise<ReturnType<typeof jsonResult | typeof errorResult>> {
  const vaultResult = requireVault(ctx);
  if ("error" in vaultResult) return vaultResult.error;
  const { vault } = vaultResult;

  // Validate componentPath resolves within vault (throws on escape)
  let toxAbs: string;
  try {
    toxAbs = vault.resolve(args.componentPath);
  } catch (err) {
    return errorResult(`Invalid componentPath: ${String(err)}`);
  }

  const trailRel = trailRelPath(args.componentPath);
  let trailAbs: string;
  try {
    trailAbs = vault.resolve(trailRel);
  } catch (err) {
    return errorResult(`Trail path escapes vault: ${String(err)}`);
  }

  // ── append ──────────────────────────────────────────────────────────────────
  if (args.action === "append") {
    if (!args.entry) {
      return errorResult("entry is required when action='append'.");
    }
    const entryInput = args.entry;

    let sha256: string | undefined;
    let size: number | undefined;

    if (args.includeSha) {
      if (existsSync(toxAbs)) {
        try {
          sha256 = await sha256File(toxAbs);
          size = statSync(toxAbs).size;
        } catch (err) {
          return errorResult(`Failed to hash .tox file: ${String(err)}`);
        }
      }
      // .tox not found: skip hash (allow renamed/future paths)
    }

    const newEntry: TrailEntry = {
      schema_version: 1,
      ts: entryInput.ts ?? new Date().toISOString(),
      author: resolveAuthor(entryInput.author),
      note: entryInput.note,
      changedParams: entryInput.changedParams,
      ...(sha256 !== undefined ? { sha256 } : {}),
      ...(size !== undefined ? { size } : {}),
    };

    try {
      appendFileSync(trailAbs, `${JSON.stringify(newEntry)}\n`, "utf8");
    } catch (err) {
      return errorResult(`Failed to write trail: ${String(err)}`);
    }

    const { entries: allEntries } = readTrail(trailAbs);
    return jsonResult(`Appended revision ${allEntries.length} to ${trailRel}`, {
      trail_path: trailRel,
      entry: newEntry,
      entry_count: allEntries.length,
    });
  }

  // ── read ────────────────────────────────────────────────────────────────────
  if (args.action === "read") {
    const { entries, warnings } = readTrail(trailAbs);
    return jsonResult(`Read ${entries.length} revisions from ${trailRel}`, {
      trail_path: trailRel,
      entries,
      warnings,
    });
  }

  // ── export ──────────────────────────────────────────────────────────────────
  const { entries } = readTrail(trailAbs);
  const noteRel = exportNoteRelPath(args.componentPath, args.exportNoteName);

  let noteAbs: string;
  try {
    noteAbs = vault.resolve(noteRel);
  } catch (err) {
    return errorResult(`exportNoteName escapes vault: ${String(err)}`);
  }
  void noteAbs; // path validated; vault.write handles dir creation

  const markdown = renderMarkdown(args.componentPath, entries);
  try {
    vault.write(noteRel, markdown);
  } catch (err) {
    return errorResult(`Failed to write changelog note: ${String(err)}`);
  }

  return jsonResult(`Exported changelog to ${noteRel}`, {
    trail_path: trailRel,
    note_path: noteRel,
    entry_count: entries.length,
  });
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerComponentChangelogTrail: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "component_changelog_trail",
    {
      title: "Component Changelog Trail",
      description:
        "Maintains an append-only per-component revision history as a JSONL trail " +
        "(`<component>.trail.jsonl`) inside the Obsidian vault, next to the .tox and its " +
        "provenance sidecar. Three actions: append a new revision entry (with optional " +
        "sha256 of the .tox, changed-param list, author, and timestamp); read all entries " +
        "back as JSON; export the trail as a human-readable markdown changelog note rendered " +
        "into the vault. Offline — no TD bridge required. Pairs with save_component_to_vault " +
        "and provenance_stamp.",
      inputSchema: componentChangelogTrailSchema.shape,
    },
    (callArgs) => componentChangelogTrailImpl(ctx, callArgs),
  );
