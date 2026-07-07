import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// export_externalized_tree — save a COMP as a git-diffable externalized .tox tree.
//
// Uses TouchDesigner's "save external" (COMP.saveExternalTox) so the component
// (and, with recurse=True, every descendant COMP) is written to its own .tox
// file on disk and its `externaltox` par points at that file. Instead of one
// opaque binary blob, you get a tree of per-node files that diff cleanly in git.
//
// saveExternalTox(recurse=False, password=None) returns an int and writes the
// file immediately; the exact write is a TD side effect so this tool is
// destructive (it writes files under out_dir).
// ---------------------------------------------------------------------------

export const exportExternalizedTreeSchema = z.object({
  comp_path: z
    .string()
    .describe("Full path of the COMP to externalize (its .tox is written to out_dir/<name>.tox)."),
  out_dir: z
    .string()
    .describe(
      "Local folder to write the externalized .tox tree into. Passed to TouchDesigner as the save target, so it must be reachable from the TD process's filesystem.",
    ),
  name: z
    .string()
    .optional()
    .describe("Root .tox stem. Defaults to the last path segment of comp_path."),
  recurse: z
    .boolean()
    .default(true)
    .describe(
      "When true, externalize every descendant COMP too (each becomes its own .tox file), so the whole subtree is git-diffable. When false, only the root COMP is externalized.",
    ),
});
type ExportExternalizedTreeArgs = z.infer<typeof exportExternalizedTreeSchema>;

export const exportExternalizedTreeOutputSchema = z.object({
  comp: z.string().describe("Echoed COMP path that was externalized."),
  root_tox: z.string().describe("Absolute path of the root externalized .tox."),
  recurse: z.boolean().describe("Whether descendant COMPs were externalized too."),
  externalized: z
    .array(z.object({ node: z.string(), tox: z.string() }))
    .describe("Each COMP that now points at an external .tox file (node path → externaltox path)."),
  count: z.number().describe("Number of COMPs externalized."),
  warnings: z.array(z.string()),
});

interface ExternalizedEntry {
  node: string;
  tox: string;
}
interface ExportReport {
  root_tox?: string;
  externalized: ExternalizedEntry[];
  warnings: string[];
  fatal?: string;
}

// Externalizes op(comp_path) as a git-diffable .tox tree.
//
// PROBE-LIVE NOTE (TD 099 build 2025.32820): saveExternalTox(path, ...) with a
// path argument is a silent no-op on this build — it writes nothing and leaves
// externaltox unset. The behavior that actually externalizes a COMP is to SET
// its `externaltox` par to the target file first, THEN call
// saveExternalTox(recurse=...), which returns 1 and writes the file. So we set
// the par on the root (and, when recurse, on every descendant COMP to a
// per-node path under out_dir) before saving, then verify each file on disk.
const EXPORT_EXTERNALIZED_SCRIPT = `
import json, base64, os, re, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"externalized": [], "warnings": []}

def _slug(_s):
    _s = re.sub(r"[^A-Za-z0-9._-]+", "_", str(_s)).strip("._")
    return _s or "comp"

try:
    _c = op(_p["comp_path"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp_path"]
    elif not _c.isCOMP:
        report["fatal"] = _p["comp_path"] + " is not a COMP"
    else:
        _recurse = bool(_p.get("recurse", True))
        _root_tox = _p["root_tox"]
        _out_dir = os.path.dirname(_root_tox)

        # 1. Point the root (and each descendant COMP when recursing) at its own
        #    external .tox file, so save writes a per-node tree that diffs in git.
        _targets = [(_c, _root_tox)]
        if _recurse:
            try:
                _kids = _c.findChildren(type=COMP) if hasattr(_c, "findChildren") else []
            except Exception as _e:
                _kids = []
                report["warnings"].append("findChildren failed: " + str(_e))
            for _k in _kids:
                _kt = os.path.join(_out_dir, _slug(_k.name) + "_" + str(_k.id) + ".tox")
                _targets.append((_k, _kt))

        for _n, _t in _targets:
            try:
                if hasattr(_n.par, "externaltox"):
                    _n.par.externaltox = _t
            except Exception as _e:
                report["warnings"].append(str(getattr(_n, "path", "?")) + ": set externaltox failed: " + str(_e))

        # 2. Save external — writes each COMP that now has an externaltox path.
        try:
            _c.saveExternalTox(recurse=_recurse)
        except TypeError:
            _c.saveExternalTox(_recurse)  # positional-only older signature
        report["root_tox"] = _root_tox

        # 3. Verify what actually landed on disk.
        for _n, _t in _targets:
            _ext = _t
            try:
                if hasattr(_n.par, "externaltox"):
                    _v = _n.par.externaltox.eval()
                    if _v:
                        _ext = str(_v)
            except Exception:
                pass
            _exists = False
            try:
                _exists = os.path.isfile(_ext)
            except Exception:
                _exists = False
            if _exists:
                report["externalized"].append({"node": _n.path, "tox": _ext})
            else:
                report["warnings"].append(_n.path + ": external file not written (" + _ext + ")")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildExportExternalizedTreeScript(payload: object): string {
  return buildPayloadScript(EXPORT_EXTERNALIZED_SCRIPT, payload);
}

function safeStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.tox$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned || "component";
}

export async function exportExternalizedTreeImpl(
  ctx: ToolContext,
  args: ExportExternalizedTreeArgs,
) {
  const parsed = exportExternalizedTreeSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
  const { comp_path, recurse } = parsed.data;
  const name = safeStem(parsed.data.name ?? basename(comp_path));
  // out_dir is passed straight to the TD process, which owns its own cwd/filesystem;
  // keep an absolute join so the target is unambiguous, but do not resolve() against
  // this Node process's cwd when out_dir is already absolute.
  const outDir = parsed.data.out_dir;
  const rootTox = isAbsolute(outDir) ? join(outDir, `${name}.tox`) : `${outDir}/${name}.tox`;

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(
        buildExportExternalizedTreeScript({ comp_path, root_tox: rootTox, recurse }),
        true,
      );
      return parsePythonReport<ExportReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`export_externalized_tree failed: ${report.fatal}`, report);
      }
      const externalized = report.externalized ?? [];
      const summary =
        `Externalized ${externalized.length} COMP(s) from ${comp_path} to ${rootTox}` +
        `${recurse ? " (recursive — each descendant COMP is its own .tox)" : ""}.`;
      return structuredResult(summary, {
        comp: comp_path,
        root_tox: report.root_tox ?? rootTox,
        recurse,
        externalized,
        count: externalized.length,
        warnings: report.warnings ?? [],
      });
    },
  );
}

export const registerExportExternalizedTree: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "export_externalized_tree",
    {
      title: "Export externalized .tox tree (git-diffable)",
      description:
        "Save a COMP as a git-diffable externalized .tox tree using TouchDesigner's 'save external' (COMP.saveExternalTox). Instead of one opaque binary, the component — and, with recurse=true, every descendant COMP — is written to its own .tox file on disk with its externaltox parameter pointed at that file, so a version-controlled project shows per-node diffs. Writes files under out_dir (destructive) and mutates the live COMP's externaltox pars. out_dir is passed to the TouchDesigner process, so it must be a path that process can write to.",
      inputSchema: exportExternalizedTreeSchema.shape,
      outputSchema: exportExternalizedTreeOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => exportExternalizedTreeImpl(ctx, args),
  );
};
