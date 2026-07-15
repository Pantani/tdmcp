import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const optimizePerformanceSchema = z.object({
  path: z.string().default("/project1").describe("Network to analyze (recursively)."),
  threshold_ms: z.coerce
    .number()
    .positive()
    .default(2)
    .describe("Flag nodes whose last cook took at least this many milliseconds."),
  apply: z
    .boolean()
    .default(false)
    .describe(
      "If true, actually lower the resolution of the flagged TOPs by `scale`. Default false = just report the bottlenecks and suggestions.",
    ),
  scale: z.coerce
    .number()
    .min(0.1)
    .max(1)
    .default(0.5)
    .describe("(apply) Resolution multiplier for flagged TOPs (0.5 = half on each axis)."),
});
type OptimizePerformanceArgs = z.infer<typeof optimizePerformanceSchema>;

interface OptimizeReport {
  path: string;
  slow: Array<{ path: string; type: string; cook_ms: number }>;
  optimized: Array<{ path: string; from: [number, number]; to: [number, number] }>;
  suggestions: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass: rank descendants by last cook time, list the slow ones with a suggestion,
// and (when apply) halve the resolution of flagged TOPs that expose a custom resolution.
const OPTIMIZE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "slow": [], "optimized": [], "suggestions": [], "warnings": []}
_root = op(_p["path"])
try:
    if _root is None or not hasattr(_root, "findChildren"):
        report["fatal"] = "Network not found: " + _p["path"]
    else:
        _scored = []
        for _c in _root.findChildren():
            try:
                _ct = float(getattr(_c, "cookTime", 0.0) or 0.0)
            except Exception:
                _ct = 0.0
            if _ct >= _p["threshold"]:
                _scored.append((_ct, _c))
        _scored.sort(key=lambda x: x[0], reverse=True)
        for _ct, _c in _scored[:20]:
            _ty = getattr(_c, "OPType", None) or getattr(_c, "type", "") or ""
            report["slow"].append({"path": _c.path, "type": _ty, "cook_ms": round(_ct, 3)})
            if _ty.endswith("TOP"):
                report["suggestions"].append("%s (%s, %.1fms): lower its resolution or pre-shrink." % (_c.path, _ty, _ct))
            else:
                report["suggestions"].append("%s (%s, %.1fms): simplify or cache this branch." % (_c.path, _ty, _ct))
        if _p["apply"]:
            _scale = _p["scale"]
            for _ct, _c in _scored:
                _ty = getattr(_c, "OPType", "") or ""
                if not _ty.endswith("TOP"):
                    continue
                _rw = getattr(_c.par, "resolutionw", None)
                _rh = getattr(_c.par, "resolutionh", None)
                _ores = getattr(_c.par, "outputresolution", None)
                if _rw is None or _rh is None:
                    continue
                try:
                    _fw = int(_c.width); _fh = int(_c.height)
                    if _ores is not None:
                        try:
                            _ores.val = "custom"
                        except Exception:
                            pass
                    _nw = max(64, int(_fw * _scale)); _nh = max(64, int(_fh * _scale))
                    _rw.val = _nw; _rh.val = _nh
                    report["optimized"].append({"path": _c.path, "from": [_fw, _fh], "to": [_nw, _nh]})
                except Exception:
                    report["warnings"].append("Could not resize " + _c.path)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildOptimizeScript(payload: object): string {
  return buildPayloadScript(OPTIMIZE_SCRIPT, payload);
}

export async function optimizePerformanceImpl(ctx: ToolContext, args: OptimizePerformanceArgs) {
  return guardTd(
    async () => {
      const script = buildOptimizeScript({
        path: args.path,
        threshold: args.threshold_ms,
        apply: args.apply,
        scale: args.scale,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<OptimizeReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Performance scan failed: ${report.fatal}`, report);
      }
      const summary = args.apply
        ? `Found ${report.slow.length} slow node(s) over ${args.threshold_ms}ms; resized ${report.optimized.length} TOP(s) to ${Math.round(args.scale * 100)}%.`
        : `Found ${report.slow.length} node(s) over ${args.threshold_ms}ms. Re-run with apply:true to halve the flagged TOPs' resolution.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerOptimizePerformance: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "optimize_performance",
    {
      title: "Optimize performance",
      description:
        "Scan a network for cook-time bottlenecks and report the slowest nodes with concrete suggestions. By default " +
        "this is a read-only measurement; with apply=true it mutates flagged TOP resolutions by scale and returns " +
        "the before/after sizes. Run get_td_performance when you only need metrics; use this tool when you want the " +
        "bounded resolution change, and leave apply=false for a plan-only pass.",
      inputSchema: optimizePerformanceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => optimizePerformanceImpl(ctx, args),
  );
};
