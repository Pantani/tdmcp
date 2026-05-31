import { z } from "zod";
import { parseSetlist } from "../../automation/setlistSchema.js";
import { buildNote } from "../../vault/frontmatter.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const exportSetlistToVaultSchema = z.object({
  target: z.string().describe("COMP whose stored cues/scenes to export as a setlist."),
  note: z.string().describe("Setlist note name to write (e.g. 'Friday Set')."),
  folder: z
    .string()
    .default("Setlists")
    .describe("Vault subfolder (match import_setlist's expected location)."),
  include_tempo: z
    .boolean()
    .default(true)
    .describe("Capture the project's global tempo into the note."),
});
type ExportSetlistToVaultArgs = z.infer<typeof exportSetlistToVaultSchema>;

interface CueEntry {
  name: string;
  params: Record<string, unknown>;
}

interface SetlistReport {
  comp: string;
  cues: CueEntry[];
  tempo: number | null;
  warnings: string[];
  fatal?: string;
}

// Read cues from the COMP's storage (key 'tdmcp_cues', set by manage_cue) and
// optionally the project-level tempo. Cue order is sorted alphabetically (same
// as manage_cue's list action) so the exported note is deterministic.
const READ_CUES_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
KEY = "tdmcp_cues"
report = {"comp": _p["comp"], "cues": [], "tempo": None, "warnings": []}
try:
    _c = op(_p["comp"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP (no custom parameters)."
    else:
        _store = dict(_c.fetch(KEY, {}))
        for _name in sorted(_store.keys()):
            _params = _store[_name]
            if not isinstance(_params, dict):
                report["warnings"].append("Cue '" + _name + "' has unexpected storage shape — skipped.")
                continue
            report["cues"].append({"name": _name, "params": _params})
        if _p.get("include_tempo"):
            try:
                report["tempo"] = float(op('/').time.tempo)
            except Exception:
                report["warnings"].append("Could not read project tempo.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function safeName(name: string): string {
  // Produce a filesystem-safe slug that still looks readable.
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9._\- ]+/g, "_")
      .replace(/^_+|_+$/g, "") || "setlist"
  );
}

/**
 * Serializes a cue list to a setlist note whose frontmatter matches exactly what
 * importSetlistImpl expects: a `tracks` key that is an array of objects with
 * optional {title, recipe, preset, bpm, notes} fields.
 *
 * Cues don't carry a recipe id (they are parameter snapshots, not TD recipes), so
 * we emit `title` (the cue name) and, when available, `bpm` from the tempo. The
 * `recipe` and `preset` keys are omitted so import_setlist skips them gracefully
 * (a preset track emits "recall it live" — which is exactly the right behaviour for
 * re-imported cue entries that have no wiring recipe attached).
 *
 * The result is deliberately round-trip-safe: import_setlist can re-parse it, and
 * the cue names appear in the tracks list so a human can hand-add recipe ids later.
 */
function buildSetlistNote(report: SetlistReport, noteName: string): string {
  const tracks = report.cues.map((cue) => {
    const entry: Record<string, unknown> = { title: cue.name };
    if (report.tempo !== null && report.tempo > 0) {
      entry.bpm = Math.round(report.tempo);
    }
    return entry;
  });

  const frontmatter: Record<string, unknown> = {
    title: noteName,
    source_comp: report.comp,
    tracks,
  };
  if (report.tempo !== null && report.tempo > 0) {
    frontmatter.tempo = Math.round(report.tempo);
  }

  const cueSummaryLines = report.cues.map((c) => {
    const keys = Object.keys(c.params);
    return `- **${c.name}** — ${keys.length} param(s): ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}`;
  });
  const body =
    `Setlist exported from \`${report.comp}\` by tdmcp. ` +
    `Re-import with \`import_setlist\`.\n\n` +
    `## Cues\n\n` +
    (cueSummaryLines.length > 0 ? cueSummaryLines.join("\n") : "_No cues stored on this COMP._") +
    `\n\n` +
    `> Add a \`recipe:\` field to any track above to wire it with \`import_setlist\`.\n`;

  return buildNote(frontmatter, body);
}

export async function exportSetlistToVaultImpl(
  ctx: ToolContext,
  args: ExportSetlistToVaultArgs,
): Promise<ReturnType<typeof jsonResult>> {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const noteSlug = safeName(args.note);
  const relPath = `${args.folder}/${noteSlug}.md`;

  return guardTd(
    async () => {
      const script = buildPayloadScript(READ_CUES_SCRIPT, {
        comp: args.target,
        include_tempo: args.include_tempo,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SetlistReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Export failed: ${report.fatal}`, report);
      }

      const content = buildSetlistNote(report, args.note);

      // Validate the produced frontmatter against the shared SetlistSchema —
      // guarantees what we write here can be re-read by import_setlist.
      // Re-parse the buildNote output by extracting its YAML frontmatter is
      // overkill; we have the frontmatter in-memory above, so re-check it.
      const fmCheck = parseSetlist({
        title: args.note,
        source_comp: report.comp,
        tracks: report.cues.map((cue) => {
          const entry: Record<string, unknown> = { title: cue.name };
          if (report.tempo !== null && report.tempo > 0) entry.bpm = Math.round(report.tempo);
          return entry;
        }),
        ...(report.tempo !== null && report.tempo > 0 ? { tempo: Math.round(report.tempo) } : {}),
      });
      if (!fmCheck.success && report.cues.length > 0) {
        return errorResult(
          `Built setlist note would not round-trip through SetlistSchema: ${fmCheck.error.message}`,
        );
      }

      vault.write(relPath, content);

      const summary =
        `Exported ${report.cues.length} cue(s) from ${args.target} → ${relPath} (re-importable by import_setlist).` +
        (report.warnings.length > 0 ? ` ${report.warnings.length} warning(s).` : "");

      return jsonResult(summary, {
        path: relPath,
        comp: report.comp,
        cues: report.cues.map((c) => c.name),
        tempo: report.tempo,
        warnings: report.warnings,
      });
    },
  );
}

export const registerExportSetlistToVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_setlist_to_vault",
    {
      title: "Export setlist to vault",
      description:
        "Serialize the current cues stored on a COMP (manage_cue snapshots, keyed 'tdmcp_cues') into a setlist note in the Obsidian vault, so a live-built show can be round-tripped into the vault library as a git-diffable setlist. The note frontmatter `tracks` array matches what import_setlist expects — each cue becomes a track with its title and optional bpm, ready for a recipe id to be added by hand. Re-import the note later with import_setlist to rebuild the visuals. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: exportSetlistToVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => exportSetlistToVaultImpl(ctx, args),
  );
};
