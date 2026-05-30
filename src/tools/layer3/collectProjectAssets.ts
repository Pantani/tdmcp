import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const collectProjectAssetsSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Root of the COMP subtree to scan recursively for external file dependencies."),
  out_manifest: z
    .string()
    .default("")
    .describe(
      "Optional filesystem path to write the JSON asset manifest to. Empty string means do not write a file — just return the inventory.",
    ),
  include_missing_only: z
    .boolean()
    .default(false)
    .describe("When true, only report assets whose referenced file does not exist on disk."),
});
type CollectProjectAssetsArgs = z.infer<typeof collectProjectAssetsSchema>;

export const collectProjectAssetsOutputSchema = z.object({
  parent: z.string().describe("Echoed root path that was scanned."),
  assets: z
    .array(
      z.object({
        node: z.string().describe("Full path of the operator that references the file."),
        par: z.string().describe("Parameter name holding the file reference."),
        value: z.string().describe("The referenced file path (evaluated)."),
        exists: z.boolean().describe("Whether the file currently exists on disk."),
        kind: z
          .string()
          .optional()
          .describe(
            "How the par was detected: par.style ('File'/'Folder') or the name heuristic that matched.",
          ),
      }),
    )
    .describe("Every external file dependency found in the subtree (after include_missing_only)."),
  count: z.number().describe("Number of assets reported (after filtering)."),
  missing_count: z.number().describe("How many reported assets are missing from disk."),
  manifest_path: z
    .string()
    .optional()
    .describe("Path the JSON manifest was written to, when out_manifest was set."),
  warnings: z
    .array(z.string())
    .describe("Per-op / per-par problems encountered while scanning (fail-forward)."),
  style_supported: z
    .boolean()
    .optional()
    .describe(
      "Whether par.style was readable in this TD build (UNVERIFIED attr). When false, only the name heuristic was used.",
    ),
});

interface AssetEntry {
  node: string;
  par: string;
  value: string;
  exists: boolean;
  kind?: string;
}

interface CollectProjectAssetsReport {
  parent: string;
  assets: AssetEntry[];
  count: number;
  missing_count: number;
  warnings: string[];
  style_supported?: boolean;
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python bridge script
//
// Walks op(parent_path) recursively (children, recursing into COMPs) and reads
// every operator's pars() looking for ones that reference an external file. This
// is a READ-ONLY inventory — a sibling of make_portable_tox / bundle_dependencies
// but across a whole subtree, doing no copying or rewriting.
//
// Detection is two-tier and PROBE-LIVE (the exact attribute names vary by TD
// build, so each access is guarded and we report what worked):
//   1. par.style in ("File", "Folder") — the authoritative way a file par is
//      flagged. The `style` attribute is UNVERIFIED across builds; if reading it
//      raises, we set style_supported=False and lean on the name heuristic.
//   2. Name heuristic fallback — pars whose name looks file-ish (*file*,
//      *fontfile*, *lut*, *externaltox*, *dat*) AND whose string value contains a
//      path separator or a dotted extension. This catches builds/pars where
//      style is absent and avoids flagging plain text fields.
//
// par.eval() is preferred for the value (resolves expressions); falls back to
// par.val on error. os.path.exists is the existence probe (mirrors the
// LINK_HEALTH_SCRIPT idiom in src/tools/library/index.ts).
// ---------------------------------------------------------------------------
const COLLECT_PROJECT_ASSETS_SCRIPT = `
import json, base64, os, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"parent": _p["parent_path"], "assets": [], "count": 0, "missing_count": 0, "warnings": []}
_NAME_HINTS = ("file", "fontfile", "lut", "externaltox", "dat", "moviefile", "imagefile")

def _looks_like_path(_s):
    if not isinstance(_s, str) or not _s.strip():
        return False
    if "/" in _s or "\\\\" in _s:
        return True
    _base = os.path.basename(_s)
    return ("." in _base) and (not _base.startswith("."))

def _par_value(_par):
    try:
        _v = _par.eval()
    except Exception:
        try:
            _v = _par.val
        except Exception:
            _v = None
    if _v is None:
        return ""
    return str(_v)

def _detect(_par):
    # Returns (is_asset, kind) — kind records HOW it was detected for live confirmation.
    _style = None
    try:
        _style = getattr(_par, "style", None)
    except Exception:
        _style = None
    if _style is not None:
        report["style_supported"] = True
        if _style in ("File", "Folder"):
            return True, "style:" + str(_style)
        # When style is readable and is NOT a file/folder par, trust it: skip.
        return False, None
    # style unreadable on this par/build — fall back to the name heuristic.
    if report.get("style_supported") is None:
        report["style_supported"] = False
    _nm = ""
    try:
        _nm = (_par.name or "").lower()
    except Exception:
        return False, None
    for _hint in _NAME_HINTS:
        if _hint in _nm:
            return True, "name:" + _hint
    return False, None

def _scan(_node):
    try:
        _pars = _node.pars()
    except Exception as _e:
        report["warnings"].append(str(getattr(_node, "path", "?")) + ": pars() failed: " + str(_e))
        return
    for _par in _pars:
        try:
            _is_asset, _kind = _detect(_par)
            if not _is_asset:
                continue
            _val = _par_value(_par)
            if not _looks_like_path(_val):
                continue
            _exists = False
            try:
                _exists = os.path.exists(_val)
            except Exception:
                _exists = False
            report["assets"].append({
                "node": str(getattr(_node, "path", "?")),
                "par": str(getattr(_par, "name", "?")),
                "value": _val,
                "exists": bool(_exists),
                "kind": _kind,
            })
        except Exception as _e:
            report["warnings"].append(
                str(getattr(_node, "path", "?")) + " par: " + str(_e)
            )

def _walk(_node):
    _scan(_node)
    try:
        _children = list(_node.children)
    except Exception:
        _children = []
    for _child in _children:
        try:
            if getattr(_child, "isCOMP", False):
                _walk(_child)
            else:
                _scan(_child)
        except Exception as _e:
            report["warnings"].append(str(getattr(_child, "path", "?")) + ": " + str(_e))

try:
    _root = op(_p["parent_path"])
    if _root is None:
        report["fatal"] = "Parent not found: " + str(_p["parent_path"])
    else:
        _walk(_root)
        if _p.get("include_missing_only"):
            report["assets"] = [_a for _a in report["assets"] if not _a["exists"]]
        report["count"] = len(report["assets"])
        report["missing_count"] = len([_a for _a in report["assets"] if not _a["exists"]])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCollectProjectAssetsScript(payload: object): string {
  return buildPayloadScript(COLLECT_PROJECT_ASSETS_SCRIPT, payload);
}

export async function collectProjectAssetsImpl(ctx: ToolContext, args: CollectProjectAssetsArgs) {
  return guardTd(
    async () => {
      const script = buildCollectProjectAssetsScript({
        parent_path: args.parent_path,
        include_missing_only: args.include_missing_only,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<CollectProjectAssetsReport>(exec.stdout);
      let manifestPath: string | undefined;
      if (!report.fatal && args.out_manifest.trim()) {
        manifestPath = args.out_manifest.trim();
        const manifest = {
          kind: "tdmcp-project-assets",
          generated_at: new Date().toISOString(),
          parent: report.parent,
          count: report.count,
          missing_count: report.missing_count,
          assets: report.assets,
          warnings: report.warnings,
        };
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      return { report, manifestPath };
    },
    ({ report, manifestPath }) => {
      if (report.fatal) {
        return errorResult(`collect_project_assets failed: ${report.fatal}`, report);
      }
      const where = manifestPath ? ` (manifest → ${manifestPath})` : "";
      const summary = `Found ${report.count} external file dependenc${
        report.count === 1 ? "y" : "ies"
      } under ${report.parent}, ${report.missing_count} missing${where}.`;
      return structuredResult(summary, {
        parent: report.parent,
        assets: report.assets,
        count: report.count,
        missing_count: report.missing_count,
        manifest_path: manifestPath,
        warnings: report.warnings,
        style_supported: report.style_supported,
      });
    },
  );
}

export const registerCollectProjectAssets: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "collect_project_assets",
    {
      title: "Collect project assets",
      description:
        "Read-only inventory: scan a COMP subtree for every external file dependency (movie/image file pars, fonts, LUTs, externaltox links, DAT/GLSL file references) and report each referenced file, the node+parameter that references it, and whether the file currently exists on disk. The project-wide 'gather everything this touches' inventory — a sibling of make_portable_tox / bundle_dependencies, but read-only across a whole subtree (it copies and rewrites nothing). Optionally writes a JSON manifest to out_manifest. File-par detection uses par.style ('File'/'Folder') when readable, falling back to a name heuristic (*file*, *fontfile*, *lut*, *externaltox*, *dat*) — both UNVERIFIED across TD builds; `style_supported` records whether par.style was available.",
      inputSchema: collectProjectAssetsSchema.shape,
      outputSchema: collectProjectAssetsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => collectProjectAssetsImpl(ctx, args),
  );
};
