import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

/**
 * `export_look_tox` — package a COMP ("a look") as a portable `.tox` into the
 * vault, with a sibling Markdown sidecar that captures name + tags + metadata so
 * `browse_vault_library` / `tag_and_search_library` can surface it. The artist-
 * publishing primitive for shareable looks. Gated on TDMCP_VAULT_PATH.
 */

export const exportLookToxSchema = z.object({
  source_path: z.string().describe("COMP path to package (e.g. '/project1/myLook')."),
  name: z.string().optional().describe("Look name (defaults to the COMP's name)."),
  folder: z.string().default("Looks").describe("Vault subfolder under TDMCP_VAULT_PATH."),
  tags: z.array(z.string()).default([]).describe("Tags written to the note frontmatter."),
  description: z.string().optional().describe("Short human description for the note body."),
  assets: z
    .array(z.string())
    .default([])
    .describe("Vault-relative asset paths to record in the metadata sidecar."),
});
export type ExportLookToxArgs = z.infer<typeof exportLookToxSchema>;

interface SaveToxReport {
  saved?: string;
  size?: number | null;
  comp_name?: string;
  fatal?: string;
}

const SAVE_LOOK_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    _c = op(_p["source_path"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["source_path"]
    elif not _c.isCOMP:
        report["fatal"] = _p["source_path"] + " is not a COMP (only COMPs can be saved as .tox)."
    else:
        report["comp_name"] = _c.name
        _saved = _c.save(_p["tox_path"], createFolders=True)
        report["saved"] = str(_saved)
        report["size"] = os.path.getsize(_p["tox_path"]) if os.path.isfile(_p["tox_path"]) else None
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "look";
}

export async function exportLookToxImpl(ctx: ToolContext, args: ExportLookToxArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const fallback = args.source_path.split("/").filter(Boolean).pop() ?? "look";
  const lookName = args.name ?? fallback;
  const stem = slugify(lookName);
  const toxRel = `${args.folder}/${stem}.tox`;
  const noteRel = `${args.folder}/${stem}.md`;
  const toxAbs = vault.resolve(toxRel);

  try {
    const exec = await ctx.client.executePythonScript(
      buildPayloadScript(SAVE_LOOK_SCRIPT, {
        source_path: args.source_path,
        tox_path: toxAbs,
      }),
      true,
    );
    const report = parsePythonReport<SaveToxReport>(exec.stdout);
    if (report.fatal) {
      return errorResult(`Could not save look .tox: ${report.fatal}`, {
        source_path: args.source_path,
        tox_path: toxAbs,
      });
    }
    const frontmatter: Record<string, unknown> = {
      id: stem,
      type: "look",
      name: lookName,
      tox: `${stem}.tox`,
      source_path: args.source_path,
      td_comp_name: report.comp_name ?? lookName,
      size_bytes: report.size ?? null,
      tags: Array.from(new Set(["look", ...(args.tags ?? [])])),
      assets: args.assets ?? [],
      created: new Date().toISOString(),
    };
    if (args.description) frontmatter.description = args.description;
    const body = `# ${lookName}\n\n${args.description ?? "Portable look exported from TouchDesigner."}\n`;
    try {
      vault.writeNote(noteRel, frontmatter, body);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Saved .tox but could not write note "${noteRel}": ${reason}`);
    }
    return jsonResult(`Exported look "${lookName}" → ${toxRel} (${report.size ?? "?"} bytes).`, {
      source_path: args.source_path,
      tox_path: toxRel,
      tox_absolute: report.saved ?? toxAbs,
      note_path: noteRel,
      name: lookName,
      size_bytes: report.size ?? null,
      tags: frontmatter.tags,
      assets: args.assets,
    });
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerExportLookTox: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_look_tox",
    {
      title: "Export a look as a portable .tox into the vault",
      description:
        "Save a COMP as a `.tox` inside `<vault>/<folder>/<slug>.tox` and write a sibling Markdown note (id/type=look + name + tags + assets + created + source_path). Defaults `folder` to `Looks`. The artist-publishing primitive for portable looks; integrates with `browse_vault_library` and `tag_and_search_library` via the note frontmatter. Requires TDMCP_VAULT_PATH and a running TouchDesigner bridge.",
      inputSchema: exportLookToxSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => exportLookToxImpl(ctx, args),
  );
};
