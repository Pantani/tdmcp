import { z } from "zod";
import { tryEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const analyzeProjectSchema = z.object({
  path: z
    .string()
    .default("/project1")
    .describe("Network root to analyze (the COMP whose descendants are scanned)."),
  recursive: z
    .boolean()
    .default(true)
    .describe(
      "Recurse into child COMPs (true) or only inspect the root's direct children (false).",
    ),
});
type AnalyzeProjectArgs = z.infer<typeof analyzeProjectSchema>;

export const analyzeProjectOutputSchema = z.object({
  path: z.string(),
  recursive: z.boolean(),
  counts: z.object({
    nodes: z.number(),
    by_family: z.record(z.string(), z.number()),
  }),
  unused: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      reason: z.string(),
    }),
  ),
  broken_file_deps: z.array(
    z.object({
      path: z.string(),
      par: z.string(),
      file: z.string(),
    }),
  ),
  orphan_comps: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
  dependency_map: z.record(z.string(), z.array(z.string())),
  warnings: z.array(z.string()),
});

interface AnalyzeReport {
  path: string;
  recursive: boolean;
  counts: { nodes: number; by_family: Record<string, number> };
  unused: Array<{ path: string; type: string; reason: string }>;
  broken_file_deps: Array<{ path: string; par: string; file: string }>;
  orphan_comps: Array<{ path: string; reason: string }>;
  dependency_map: Record<string, string[]>;
  warnings: string[];
  fatal?: string;
}

// All analysis runs inside TouchDesigner in one Python pass because that is the only
// place the live op graph (connections, parameter modes, exports, file paths) exists.
// This is a read-only diagnostic: it never mutates the project. It deliberately
// complements describe-project (which plans a build) and snapshot/document (which dump
// structure) — here we hunt for PROBLEMS: likely-dead operators, broken external-file
// dependencies, orphan COMPs, plus a dependency map of who-references-whom.
//
// Notes on the TD API, all guarded with getattr/hasattr + try/except so a build that
// lacks a given attribute degrades into a warning instead of a fatal:
//   - `ParMode` is NOT in the bridge's exec globals, so the EXPRESSION enum value is
//     derived from a live parameter (`type(par.mode).EXPRESSION`) like createControlPanel.
//   - `par.isFile` flags file-valued parameters when present; we fall back to a name/style
//     heuristic otherwise.
//   - `op.exports` yields a parameter's CHOP-export targets (the exporting op references
//     the target), captured as a dependency edge.
//   - References are collected from (a) expression-mode pars whose text contains op('...'),
//     (b) source-style converter pars (Select TOP/CHOP/SOP/DAT + *to* converters), and
//     (c) CHOP exports. An op is only flagged UNUSED if it has zero wired outputs AND is
//     unreferenced AND is not displayed/rendered/viewered — conservative on purpose.
const ANALYZE_SCRIPT = `
import json, base64, traceback, os, re
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "path": _p["path"],
    "recursive": _p["recursive"],
    "counts": {"nodes": 0, "by_family": {}},
    "unused": [],
    "broken_file_deps": [],
    "orphan_comps": [],
    "dependency_map": {},
    "warnings": [],
}

# op('...') / op("...") inside an expression — capture the referenced name or path.
_OPREF = re.compile(r"op\\(\\s*['\\"]([^'\\"]+)['\\"]\\s*\\)")
# Source-style parameter names that name another operator (Select ops + converters).
_SRC_PARS = ("top", "chop", "sop", "dat", "mat")
_FILE_PAR_HINTS = ("file", "moviefile", "imagefile", "soundfile", "fbxfile", "objfile")


def _opref_names(text):
    try:
        return [m for m in _OPREF.findall(text or "")]
    except Exception:
        return []


def _resolve(owner, ref):
    # Resolve a name/relative path against the op that owns the reference, then fall
    # back to a global lookup. Returns the resolved op or None (never raises).
    try:
        _r = owner.op(ref)
        if _r is not None:
            return _r
    except Exception:
        pass
    try:
        return op(ref)
    except Exception:
        return None


try:
    _root = op(_p["path"])
    if _root is None or not hasattr(_root, "findChildren"):
        report["fatal"] = "Network not found: " + str(_p["path"])
    else:
        # TD findChildren: depth=N matches nodes at EXACTLY depth N, while maxDepth=N
        # matches every descendant up to depth N. Recursive wants all descendants (maxDepth);
        # non-recursive wants only direct children (depth=1).
        try:
            if _p["recursive"]:
                _kids = list(_root.findChildren(maxDepth=9999))
            else:
                _kids = list(_root.findChildren(depth=1))
        except Exception:
            _kids = list(_root.findChildren())
        report["counts"]["nodes"] = len(_kids)

        # Derive the EXPRESSION enum from a live par.mode (ParMode is not a global).
        _EXPR = None
        for _c in _kids:
            try:
                for _pr in _c.pars():
                    _EXPR = type(_pr.mode).EXPRESSION
                    break
            except Exception:
                pass
            if _EXPR is not None:
                break

        # By-family counts, indexed-by-path lookup, and a referenced-paths set.
        _by_path = {}
        _referenced = set()  # paths of ops that something else depends on
        for _c in _kids:
            try:
                _fam = getattr(_c, "family", "") or "other"
                report["counts"]["by_family"][_fam] = report["counts"]["by_family"].get(_fam, 0) + 1
                _by_path[_c.path] = _c
            except Exception:
                report["warnings"].append("Could not index " + getattr(_c, "path", "?"))

        # Pass 1: build dependency edges + the referenced set + broken file deps.
        for _c in _kids:
            try:
                _deps = set()
                _ty = getattr(_c, "OPType", None) or getattr(_c, "type", "") or ""
                for _pr in _c.pars():
                    # (a) expression-mode pars referencing op('...')
                    try:
                        if _EXPR is not None and _pr.mode == _EXPR:
                            for _ref in _opref_names(getattr(_pr, "expr", "") or ""):
                                _tgt = _resolve(_c, _ref)
                                if _tgt is not None and _tgt.path != _c.path:
                                    _deps.add(_tgt.path)
                    except Exception:
                        pass
                    # (b) source-style pars (Select ops + *to* converters) naming an op
                    try:
                        if _pr.name.lower() in _SRC_PARS and _pr.mode != _EXPR:
                            _v = _pr.eval()
                            if isinstance(_v, str) and _v.strip():
                                _tgt = _resolve(_c, _v.strip())
                                if _tgt is not None and _tgt.path != _c.path:
                                    _deps.add(_tgt.path)
                    except Exception:
                        pass
                    # broken external-file dependency
                    try:
                        _is_file = getattr(_pr, "isFile", None)
                        if _is_file is None:
                            _is_file = _pr.name.lower() in _FILE_PAR_HINTS
                        if _is_file:
                            _val = _pr.eval()
                            if isinstance(_val, str) and _val.strip():
                                _expanded = os.path.expandvars(os.path.expanduser(_val.strip()))
                                if not os.path.exists(_expanded):
                                    report["broken_file_deps"].append(
                                        {"path": _c.path, "par": _pr.name, "file": _val.strip()}
                                    )
                    except Exception:
                        pass
                    # (c) CHOP exports: this op drives the export target → it references it
                    try:
                        for _ex in getattr(_pr, "exports", []) or []:
                            _xo = getattr(_ex, "owner", None) or getattr(_ex, "op", None)
                            if _xo is not None and getattr(_xo, "path", None) and _xo.path != _c.path:
                                _deps.add(_xo.path)
                    except Exception:
                        pass
                if _deps:
                    report["dependency_map"][_c.path] = sorted(_deps)
                    for _d in _deps:
                        _referenced.add(_d)
            except Exception:
                report["warnings"].append(
                    "Could not scan parameters of " + getattr(_c, "path", "?")
                )

        # Pass 2: wired-output / display / orphan classification (conservative).
        for _c in _kids:
            try:
                _ty = getattr(_c, "OPType", None) or getattr(_c, "type", "") or ""
                _nm = getattr(_c, "name", "") or ""
                _is_comp = bool(getattr(_c, "isCOMP", False))

                # count wired output connections
                _out_wired = 0
                try:
                    for _oc in getattr(_c, "outputConnectors", []):
                        _out_wired += len(getattr(_oc, "connections", []) or [])
                except Exception:
                    _out_wired = 0
                # count wired input connections (used for orphan COMP test)
                _in_wired = 0
                try:
                    for _ic in getattr(_c, "inputConnectors", []):
                        _in_wired += len(getattr(_ic, "connections", []) or [])
                except Exception:
                    _in_wired = 0

                _ref = _c.path in _referenced

                # displayed/rendered/viewer guards
                _shown = False
                try:
                    _dp = getattr(_c.par, "display", None)
                    if _dp is not None and bool(_dp.eval()):
                        _shown = True
                except Exception:
                    pass
                try:
                    _rp = getattr(_c.par, "render", None)
                    if _rp is not None and bool(_rp.eval()):
                        _shown = True
                except Exception:
                    pass
                try:
                    if bool(getattr(_c, "viewer", False)):
                        _shown = True
                except Exception:
                    pass

                # top-level out/null nodes are likely intentional outputs — don't flag.
                _intentional_out = False
                try:
                    if _c.parent() is _root and (_nm.startswith("out") or _nm.startswith("null")):
                        _intentional_out = True
                except Exception:
                    pass

                # UNUSED: only when ALL conservative conditions hold.
                if _out_wired == 0 and not _ref and not _shown and not _intentional_out:
                    report["unused"].append(
                        {
                            "path": _c.path,
                            "type": _ty,
                            "reason": "no output connections, not referenced by any op(), not displayed/rendered",
                        }
                    )

                # ORPHAN COMP: a COMP with no children, no wiring, unreferenced.
                if _is_comp:
                    try:
                        _nchild = len(list(_c.children))
                    except Exception:
                        _nchild = -1
                    if _nchild == 0 and _out_wired == 0 and _in_wired == 0 and not _ref:
                        report["orphan_comps"].append(
                            {
                                "path": _c.path,
                                "reason": "empty COMP with no connections and not referenced by any op()",
                            }
                        )
            except Exception:
                report["warnings"].append(
                    "Could not classify " + getattr(_c, "path", "?")
                )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAnalyzeProjectScript(payload: object): string {
  return buildPayloadScript(ANALYZE_SCRIPT, payload);
}

function normalizeReport(raw: Partial<AnalyzeReport>, args: AnalyzeProjectArgs): AnalyzeReport {
  // The REST envelope validator marks every section optional for forward-compat;
  // the tool's output schema (and its consumers) require concrete defaults. Fill
  // any missing field with its empty-shape so the structured output stays stable
  // regardless of which path produced it.
  return {
    path: raw.path ?? args.path,
    recursive: raw.recursive ?? args.recursive,
    counts: {
      nodes: raw.counts?.nodes ?? 0,
      by_family: raw.counts?.by_family ?? {},
    },
    unused: raw.unused ?? [],
    broken_file_deps: raw.broken_file_deps ?? [],
    orphan_comps: raw.orphan_comps ?? [],
    dependency_map: raw.dependency_map ?? {},
    warnings: raw.warnings ?? [],
    ...(raw.fatal ? { fatal: raw.fatal } : {}),
  };
}

export async function analyzeProjectImpl(ctx: ToolContext, args: AnalyzeProjectArgs) {
  return guardTd(
    async () => {
      // 1) First-class endpoint GET /api/projects/<path>/analysis — survives
      //    ALLOW_EXEC=0 and returns the same diagnostic dict as the legacy
      //    exec script. 2) Fall back to exec when the endpoint is absent on an
      //    older bridge; validation 400s (e.g. fatal/network not found) come
      //    back in-band on `fatal` and surface unchanged via tryEndpoint.
      const raw = await tryEndpoint<Partial<AnalyzeReport>>(
        async () =>
          (await ctx.client.analyzeProject(args.path, args.recursive)) as Partial<AnalyzeReport>,
        async () => {
          const script = buildAnalyzeProjectScript({
            path: args.path,
            recursive: args.recursive,
          });
          const exec = await ctx.client.executePythonScript(script, true);
          return parsePythonReport<AnalyzeReport>(exec.stdout);
        },
      );
      return normalizeReport(raw, args);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Project analysis failed: ${report.fatal}`, report);
      }
      const summary = `Analyzed ${report.path}: ${report.counts.nodes} node(s), ${report.unused.length} likely-unused, ${report.broken_file_deps.length} broken file dep(s), ${report.orphan_comps.length} orphan COMP(s).`;
      return structuredResult(summary, report);
    },
  );
}

export const registerAnalyzeProject: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "analyze_project",
    {
      title: "Analyze project",
      description:
        "Diagnose a network for cleanup: report likely-dead operators (zero wired outputs, unreferenced, not displayed), broken external-file dependencies (file parameters pointing at missing files), orphan COMPs, and a dependency map of which operators reference which. Read-only and conservative — every flagged item carries a human-readable reason. Complements plan_visual (which plans a build) and snapshot_td_graph (which dumps structure).",
      inputSchema: analyzeProjectSchema.shape,
      outputSchema: analyzeProjectOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => analyzeProjectImpl(ctx, args),
  );
};
