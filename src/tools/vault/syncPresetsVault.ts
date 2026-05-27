import { z } from "zod";
import { extractFencedBlock } from "../../vault/frontmatter.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const syncPresetsVaultSchema = z.object({
  action: z
    .enum(["export", "import"])
    .describe("export TD presets to a vault note, or import a note's presets back into TD."),
  comp_path: z
    .string()
    .default("/project1")
    .describe("COMP whose presets live in storage (the manage_presets target)."),
  note: z.string().optional().describe("Vault note path (defaults to Presets/<comp>.md)."),
});
type SyncPresetsVaultArgs = z.infer<typeof syncPresetsVaultSchema>;

type PresetMap = Record<string, Record<string, unknown>>;
interface ExportReport {
  comp: string;
  presets: PresetMap;
  fatal?: string;
}
interface ImportReport {
  comp: string;
  imported: string[];
  presets: string[];
  fatal?: string;
}

// Presets are stored under the same COMP storage key manage_presets uses
// ("tdmcp_presets"), as { presetName: { parName: value } }.
const EXPORT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "presets": {}}
try:
    _c = op(_p["comp"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    else:
        report["presets"] = dict(_c.fetch("tdmcp_presets", {}))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

const IMPORT_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "imported": [], "presets": []}
try:
    _c = op(_p["comp"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    else:
        _store = dict(_c.fetch("tdmcp_presets", {}))
        for _name, _vals in _p["presets"].items():
            _store[_name] = _vals
            report["imported"].append(_name)
        _c.store("tdmcp_presets", _store)
        report["presets"] = sorted(_store.keys())
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function notePathFor(comp: string, note?: string): string {
  if (note) return note.endsWith(".md") ? note : `${note}.md`;
  const base = comp.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "project";
  return `Presets/${base}.md`;
}

export async function syncPresetsVaultImpl(ctx: ToolContext, args: SyncPresetsVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;
  const rel = notePathFor(args.comp_path, args.note);

  if (args.action === "export") {
    return guardTd(
      async () => {
        const script = buildPayloadScript(EXPORT_SCRIPT, { comp: args.comp_path });
        const exec = await ctx.client.executePythonScript(script, true);
        return parsePythonReport<ExportReport>(exec.stdout);
      },
      (report) => {
        if (report.fatal) return errorResult(`Export failed: ${report.fatal}`);
        const names = Object.keys(report.presets);
        if (names.length === 0) {
          return errorResult(
            `No presets stored on ${args.comp_path}. Capture some with manage_presets first.`,
          );
        }
        const body = `Presets exported from \`${args.comp_path}\`.\n\n\`\`\`json tdmcp-presets\n${JSON.stringify(report.presets, null, 2)}\n\`\`\`\n`;
        vault.writeNote(
          rel,
          { comp: args.comp_path, type: "tdmcp-presets", count: names.length },
          body,
        );
        return jsonResult(`Exported ${names.length} preset(s) from ${args.comp_path} to ${rel}.`, {
          path: rel,
          presets: names,
        });
      },
    );
  }

  if (!vault.exists(rel)) {
    return errorResult(`Preset note not found: ${rel}.`);
  }
  const { body } = vault.readNote(rel);
  const json = extractFencedBlock(body, "json");
  if (!json) {
    return errorResult(`No \`\`\`json presets block found in ${rel}.`);
  }
  let presets: PresetMap;
  try {
    presets = JSON.parse(json) as PresetMap;
  } catch (err) {
    return errorResult(`Invalid JSON in ${rel}: ${String(err)}`);
  }

  return guardTd(
    async () => {
      const script = buildPayloadScript(IMPORT_SCRIPT, { comp: args.comp_path, presets });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ImportReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Import failed: ${report.fatal}`);
      return jsonResult(
        `Imported ${report.imported.length} preset(s) into ${args.comp_path} from ${rel}.`,
        { path: rel, imported: report.imported, presets: report.presets },
      );
    },
  );
}

export const registerSyncPresetsVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "sync_presets_vault",
    {
      title: "Sync presets with the vault",
      description:
        "Export a COMP's manage_presets snapshots to a markdown note (diffable, shareable), or import a note's presets back into TD storage. Requires TDMCP_VAULT_PATH.",
      inputSchema: syncPresetsVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => syncPresetsVaultImpl(ctx, args),
  );
};
