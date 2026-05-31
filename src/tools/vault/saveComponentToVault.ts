import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { suggestTags } from "./autoTagLibraryAsset.js";
import { captureThumbnail } from "./recipeThumbnail.js";
import { requireVault } from "./shared.js";

export const saveComponentToVaultSchema = z.object({
  comp_path: z.string().describe("The COMP to package as a reusable .tox component."),
  name: z
    .string()
    .optional()
    .describe(
      "Component name (defaults to the COMP's name). Used for the .tox filename and the note title.",
    ),
  folder: z.string().default("Components").describe("Vault subfolder for the .tox + note."),
  tags: z
    .array(z.string())
    .default([])
    .describe("Tags for the note frontmatter (for browse_vault_library)."),
  description: z.string().optional().describe("A short description stored in the note."),
  preview_top: z
    .string()
    .optional()
    .describe(
      "Output TOP to thumbnail for the component note (e.g. <comp_path>/out1). " +
        "A COMP itself can't be captured (the preview endpoint renders TOPs), so the " +
        "thumbnail is skipped unless you pass an explicit TOP path here.",
    ),
  thumbnail: z
    .boolean()
    .default(true)
    .describe("Capture a preview PNG next to the component note and embed it. Set false to skip."),
  auto_tag: z
    .boolean()
    .optional()
    .describe(
      "When true, inspect the COMP's child nodes via the bridge and union the auto_tag_library_asset suggestions into the note frontmatter's `tags`.",
    ),
});
type SaveComponentToVaultArgs = z.infer<typeof saveComponentToVaultSchema>;

interface SaveComponentReport {
  comp: string;
  tox_path: string;
  saved?: string;
  size?: number | null;
  comp_name?: string;
  warnings: string[];
  fatal?: string;
}

// Saves a COMP as a .tox file. Probes comp.name for the default component name,
// checks isCOMP, and reports the saved path and byte size via os.path.getsize.
const SAVE_COMP_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "tox_path": _p["tox_path"], "warnings": []}
try:
    _c = op(_p["comp"])
    if _c is None:
        report["fatal"] = "COMP not found: " + str(_p["comp"])
    elif not _c.isCOMP:
        report["fatal"] = str(_p["comp"]) + " is not a COMP, so it cannot be saved as a .tox."
    else:
        report["comp_name"] = _c.name
        _saved = _c.save(_p["tox_path"], createFolders=True)
        report["saved"] = str(_saved)
        report["size"] = os.path.getsize(_p["tox_path"]) if os.path.isfile(_p["tox_path"]) else None
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSaveCompScript(payload: object): string {
  return buildPayloadScript(SAVE_COMP_SCRIPT, payload);
}

// Lightweight child-node capture used for the optional auto_tag pass —
// matches autoTagLibraryAsset's CAPTURE_SCRIPT shape so suggestTags can read it.
const CAPTURE_CHILDREN_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "nodes": [], "connections": [], "warnings": []}
try:
    _root = op(_p["comp"])
    if _root is None:
        report["fatal"] = "Operator not found: " + _p["comp"]
    elif not hasattr(_root, "children"):
        report["fatal"] = _p["comp"] + " is not a COMP."
    else:
        _kids = list(_root.children)
        _names = set(c.name for c in _kids)
        for _c in _kids:
            report["nodes"].append({"name": _c.name, "type": _c.OPType})
            try:
                for _ic in _c.inputConnectors:
                    for _oc in _ic.connections:
                        _src = _oc.owner
                        if _src is not None and _src.name in _names:
                            report["connections"].append({"from": _src.name, "to": _c.name})
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function saveComponentToVaultImpl(ctx: ToolContext, args: SaveComponentToVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  // Derive a safe component name: if not supplied we default to the last segment
  // of comp_path (the actual TD name will be confirmed by the bridge).
  const fallbackName = args.comp_path.split("/").filter(Boolean).pop() ?? "component";
  const compName = args.name ?? fallbackName;

  // Resolve the absolute tox path INSIDE the vault — vault.resolve() throws if
  // the path would escape the vault root, so user-supplied folder/name cannot reach
  // outside the vault directory.
  const toxRelPath = `${args.folder}/${compName}.tox`;
  let toxAbsPath: string;
  try {
    toxAbsPath = vault.resolve(toxRelPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Invalid vault path for component: ${reason}`);
  }

  // Plain try/catch (not guardTd) so the awaited thumbnail capture sits naturally
  // before the note write. captureThumbnail never throws, so a thumbnail failure
  // never fails the .tox save or the note write.
  try {
    const script = buildSaveCompScript({
      comp: args.comp_path,
      tox_path: toxAbsPath,
    });
    const exec = await ctx.client.executePythonScript(script, true);
    const report = parsePythonReport<SaveComponentReport>(exec.stdout);

    if (report.fatal) {
      return errorResult(`Component save failed: ${report.fatal}`, report);
    }

    // Keep the note name aligned with the .tox filename: prefer the caller's
    // explicit name (which named the .tox), then TD's confirmed comp name, then our
    // derived fallback — so Components/<name>.tox and Components/<name>.md pair up.
    const resolvedName = args.name ?? report.comp_name ?? compName;
    const noteRelPath = `${args.folder}/${resolvedName}.md`;
    const noteDate = new Date().toISOString().slice(0, 10);

    // Capture a sibling thumbnail before writing the note. The preview endpoint
    // only renders TOPs, so capture only when an explicit preview_top is given;
    // otherwise skip with a clear, actionable warning (don't default to comp_path
    // — a COMP can't be captured, so that path always failed silently).
    const thumb =
      args.thumbnail && args.preview_top
        ? await captureThumbnail(ctx.client, vault, args.folder, resolvedName, {
            topPath: args.preview_top,
          })
        : {
            imageRel: null as string | null,
            embed: "",
            warning:
              args.thumbnail && !args.preview_top
                ? "Thumbnail skipped: a component has no single output TOP — pass preview_top=<a TOP path inside the component> to capture one."
                : undefined,
          };

    // Optional auto-tag — capture child nodes and union the suggested tags
    // with the caller's. Best-effort: a capture failure simply leaves tags alone.
    let mergedTags = args.tags;
    let autoTagsApplied: string[] | undefined;
    if (args.auto_tag) {
      try {
        const childScript = buildPayloadScript(CAPTURE_CHILDREN_SCRIPT, { comp: args.comp_path });
        const childExec = await ctx.client.executePythonScript(childScript, true);
        const childReport = parsePythonReport<{
          nodes?: Array<{ name: string; type: string }>;
          connections?: Array<{ from: string; to: string }>;
          fatal?: string;
        }>(childExec.stdout);
        if (!childReport.fatal && childReport.nodes && childReport.nodes.length > 0) {
          const suggestion = suggestTags(
            { nodes: childReport.nodes, connections: childReport.connections ?? [] },
            ctx.knowledge,
          );
          const seen = new Set(mergedTags.map((t) => t.toLowerCase()));
          const additions: string[] = [];
          for (const t of suggestion.suggested_tags) {
            const k = t.toLowerCase();
            if (!seen.has(k)) {
              seen.add(k);
              additions.push(t);
            }
          }
          mergedTags = [...mergedTags, ...additions];
          autoTagsApplied = suggestion.suggested_tags;
        }
      } catch {
        // auto_tag is opt-in best-effort; don't fail the save.
      }
    }

    // Write the vault note — failure becomes a warning, not a fatal.
    let noteWarning: string | undefined;
    try {
      vault.writeNote(
        noteRelPath,
        {
          type: "component",
          tox: toxRelPath,
          tags: mergedTags,
          created: noteDate,
        },
        [
          `# ${resolvedName}`,
          "",
          thumb.embed ? `${thumb.embed}\n` : "",
          args.description ? `${args.description}\n` : "",
          `**Source COMP:** \`${args.comp_path}\``,
          "",
          "## How to load",
          "",
          "Use the `manage_component` tool:",
          "",
          "```",
          `manage_component action=load file_path=<vault>/${toxRelPath}`,
          "```",
          "",
          `Or link from any note: [[${resolvedName}]]`,
        ]
          .join("\n")
          .replace(/\n{3,}/g, "\n\n"),
      );
    } catch (err) {
      noteWarning = `Note write failed (tox was saved): ${err instanceof Error ? err.message : String(err)}`;
    }

    const warnings = [...(report.warnings ?? [])];
    if (noteWarning) warnings.push(noteWarning);

    const sizeStr = report.size != null ? ` (${report.size} bytes)` : "";
    const noteStr = noteWarning
      ? " (note write failed — see warnings)"
      : ` → vault note ${noteRelPath}`;
    const summary = `Saved ${args.comp_path} as ${resolvedName}.tox${sizeStr}${noteStr}.`;

    return jsonResult(summary, {
      tox_path: toxRelPath,
      note_path: noteWarning ? null : noteRelPath,
      comp_name: resolvedName,
      size: report.size ?? null,
      warnings,
      thumbnail: thumb.imageRel,
      ...(thumb.warning ? { thumbnail_warning: thumb.warning } : {}),
      ...(autoTagsApplied ? { auto_tags: autoTagsApplied } : {}),
    });
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerSaveComponentToVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "save_component_to_vault",
    {
      title: "Package a COMP as a .tox in the vault",
      description:
        "Save a live TouchDesigner COMP as a reusable .tox component file inside the Obsidian vault (at <folder>/<name>.tox) and write a companion markdown note with frontmatter, a description, and load instructions — completing the build→parameterize→script→package-to-library loop. The saved .tox can later be loaded back with manage_component (load action). Requires a configured TDMCP_VAULT_PATH. The target COMP must exist and be a COMP (not a non-COMP operator).",
      inputSchema: saveComponentToVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => saveComponentToVaultImpl(ctx, args),
  );
};
