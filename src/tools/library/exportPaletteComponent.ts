import { basename } from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const paletteSegmentMessage = "Must be a single filename segment without path separators.";

function isSafePaletteSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/.test(value)
  );
}

export const exportPaletteComponentSchema = z.object({
  comp_path: z.string().describe("Path to the COMP to export, e.g. /project1/base1"),
  name: z
    .string()
    .refine((value) => value === "" || isSafePaletteSegment(value), paletteSegmentMessage)
    .optional()
    .describe("File stem for the .tox (default: the basename of comp_path)"),
  category: z
    .string()
    .refine(isSafePaletteSegment, paletteSegmentMessage)
    .default("tdmcp")
    .describe("Palette subfolder to group the component under"),
  palette_dir: z
    .string()
    .default("")
    .describe(
      "Explicit palette folder to use. Empty resolves TouchDesigner's user palette folder live.",
    ),
});
type ExportPaletteComponentArgs = z.infer<typeof exportPaletteComponentSchema>;

interface ExportPaletteReport {
  saved?: string | null;
  palette_root?: string | null;
  resolver_used?: string | null;
  category?: string;
  name?: string;
  size?: number | null;
  warnings?: string[];
  fatal?: string;
}

// Resolve TouchDesigner's local Palette folder at runtime, then save the COMP as
// a .tox under <palette_root>/<category>/<name>.tox so it appears in the Palette
// browser for drag-and-drop reuse. All TD globals (op/app/project) stay inside
// this string — they only exist in the bridge's exec scope. The palette-folder
// resolution is probed defensively because the available attributes vary by build.
const SAVE_PALETTE_SCRIPT = `
import json, base64, os, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "saved": None,
    "palette_root": None,
    "resolver_used": None,
    "category": _p["category"],
    "name": None,
    "size": None,
    "warnings": [],
}
try:
    _name = _p["name"] or _p["comp_path"].rstrip("/").split("/")[-1]
    report["name"] = _name
    _root = None
    _resolver = None
    if _p["palette_dir"]:
        _root = _p["palette_dir"]
        _resolver = "palette_dir"
    else:
        try:
            _cand = getattr(app, "userPaletteFolder", None)
            if _cand:
                _root = str(_cand)
                _resolver = "app.userPaletteFolder"
        except Exception as _exc:
            report["warnings"].append("app.userPaletteFolder failed: " + str(_exc))
        if _root is None:
            try:
                _prefs = getattr(app, "preferencesFolder", None)
                if _prefs:
                    _root = os.path.join(str(_prefs), "palette")
                    _resolver = "app.preferencesFolder/palette"
            except Exception as _exc:
                report["warnings"].append("app.preferencesFolder failed: " + str(_exc))
        if _root is None:
            try:
                _proj = getattr(project, "folder", None)
                if _proj:
                    _root = os.path.join(str(_proj), "palette")
                    _resolver = "project.folder/palette"
            except Exception as _exc:
                report["warnings"].append("project.folder failed: " + str(_exc))
    report["palette_root"] = _root
    report["resolver_used"] = _resolver

    _c = op(_p["comp_path"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp_path"]
    elif not getattr(_c, "isCOMP", False):
        report["fatal"] = _p["comp_path"] + " is not a COMP"
    elif _root is None:
        report["fatal"] = "Could not resolve a palette folder; pass palette_dir explicitly"
    else:
        _dest_dir = os.path.join(_root, _p["category"])
        os.makedirs(_dest_dir, exist_ok=True)
        _tox = os.path.join(_dest_dir, _name + ".tox")
        _c.save(_tox, createFolders=True)
        report["saved"] = _tox
        report["size"] = os.path.getsize(_tox) if os.path.isfile(_tox) else None
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function exportPaletteComponentImpl(
  ctx: ToolContext,
  args: ExportPaletteComponentArgs,
) {
  const parsed = exportPaletteComponentSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const safeArgs = parsed.data;
  const name = safeArgs.name || basename(safeArgs.comp_path);
  if (!isSafePaletteSegment(name)) {
    return errorResult(
      `Invalid palette component name derived from comp_path: ${name || "(empty)"}`,
    );
  }
  const payload = {
    comp_path: safeArgs.comp_path,
    name,
    category: safeArgs.category,
    palette_dir: safeArgs.palette_dir,
  };
  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(
        buildPayloadScript(SAVE_PALETTE_SCRIPT, payload),
        true,
      );
      return parsePythonReport<ExportPaletteReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`export_palette_component failed: ${report.fatal}`, report);
      }
      const warnings = report.warnings ?? [];
      const summary =
        `Saved ${report.saved} to the TouchDesigner Palette (via ${report.resolver_used})` +
        (warnings.length ? ` (${warnings.length} warning(s))` : "");
      return jsonResult(summary, report);
    },
  );
}

export const registerExportPaletteComponent: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_palette_component",
    {
      title: "Export palette component",
      description:
        "Save a COMP as a .tox into TouchDesigner's native Palette folder so it appears in the Palette browser for drag-and-drop reuse.",
      inputSchema: exportPaletteComponentSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => exportPaletteComponentImpl(ctx, args),
  );
};
