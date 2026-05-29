import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getNodeStateRuntimeSchema = z.object({
  path: z.string().describe("Full path of the operator to inspect (e.g. '/project1/noise1')."),
});
type GetNodeStateRuntimeArgs = z.infer<typeof getNodeStateRuntimeSchema>;

export const getNodeStateRuntimeOutputSchema = z.object({
  path: z.string().describe("Echoed operator path."),
  type: z.string().describe("Operator type string (e.g. 'noiseTOP')."),
  family: z.string().optional().describe("Operator family: TOP, CHOP, SOP, DAT, COMP, MAT, etc."),
  cook_time_ms: z
    .number()
    .optional()
    .describe("Last cook duration in milliseconds (op.cookTime * 1000). UNVERIFIED attr name."),
  cook_count: z
    .number()
    .optional()
    .describe(
      "Total number of times the op has cooked (op.totalCooks / op.cookCount). UNVERIFIED.",
    ),
  last_cook_frame: z
    .number()
    .optional()
    .describe("Absolute frame number of the last cook (op.cookAbsFrame). UNVERIFIED attr name."),
  resolution: z
    .array(z.number())
    .optional()
    .describe("[width, height] for TOPs (op.width, op.height). UNVERIFIED."),
  num_chans: z
    .number()
    .optional()
    .describe("Number of channels for CHOPs (op.numChans). UNVERIFIED."),
  num_samples: z
    .number()
    .optional()
    .describe("Number of samples per channel for CHOPs (op.numSamples). UNVERIFIED."),
  gpu_memory: z
    .number()
    .optional()
    .describe("GPU memory used in bytes for TOPs (op.gpuMemory). UNVERIFIED attr name."),
  errors: z.array(z.string()).describe("Cook errors from op.errors(recurse=False)."),
  warnings: z.array(z.string()).describe("Bridge-level warnings about unreadable attributes."),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Additional Info attributes found via getattr probing — allows live-validation to confirm real attr names.",
    ),
});

interface NodeStateRuntimeReport {
  path: string;
  type: string;
  family?: string;
  cook_time_ms?: number;
  cook_count?: number;
  last_cook_frame?: number;
  resolution?: number[];
  num_chans?: number;
  num_samples?: number;
  gpu_memory?: number;
  errors: string[];
  warnings: string[];
  extra?: Record<string, unknown>;
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python bridge script
//
// All attribute reads are wrapped in try/except — different op families expose
// different attrs and some exist only in certain TD builds. We read via getattr
// to avoid KeyErrors. Everything found is also captured in `extra` so the lead
// can confirm true attr names during live-validation (all names UNVERIFIED).
//
// Alternative path not taken here: spin a temporary infochopCHOP pointing at
// the op, read its channels, then destroy it in a finally block. That yields
// richer data (GPU texture breakdown, etc.) but requires a create+destroy cycle
// with potential side effects. The generic op-attribute read below is the
// stable no-side-effect path and is the recommended approach.
// ---------------------------------------------------------------------------
const NODE_STATE_RUNTIME_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "errors": [], "warnings": [], "extra": {}}
try:
    _o = op(_p["path"])
    if _o is None:
        report["fatal"] = "Operator not found: " + str(_p["path"])
    else:
        # Basic identity
        try:
            report["type"] = _o.type
        except Exception as _e:
            report["warnings"].append("type: " + str(_e))
        try:
            report["family"] = _o.family
        except Exception as _e:
            report["warnings"].append("family: " + str(_e))

        # Cook time — TD exposes this as cookTime (seconds) in most builds.
        # UNVERIFIED attr name; aliased tries for older/newer builds.
        for _attr in ("cookTime", "cook_time", "lastCookTime"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["cook_time_ms"] = float(_v) * 1000.0
                    report["extra"][_attr] = float(_v)
                    break
            except Exception:
                pass

        # Cook count — UNVERIFIED; may be totalCooks or cookCount.
        for _attr in ("totalCooks", "cookCount", "numCooks"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["cook_count"] = int(_v)
                    report["extra"][_attr] = int(_v)
                    break
            except Exception:
                pass

        # Last cook frame — UNVERIFIED attr name.
        for _attr in ("cookAbsFrame", "lastCookFrame", "cookFrame"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["last_cook_frame"] = int(_v)
                    report["extra"][_attr] = int(_v)
                    break
            except Exception:
                pass

        # TOP-specific: resolution and GPU memory. UNVERIFIED.
        try:
            _w = getattr(_o, "width", None)
            _h = getattr(_o, "height", None)
            if _w is not None and _h is not None:
                report["resolution"] = [int(_w), int(_h)]
                report["extra"]["width"] = int(_w)
                report["extra"]["height"] = int(_h)
        except Exception:
            pass
        for _attr in ("gpuMemory", "gpu_memory", "gpuMem"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["gpu_memory"] = int(_v)
                    report["extra"][_attr] = int(_v)
                    break
            except Exception:
                pass

        # CHOP-specific: numChans / numSamples. UNVERIFIED.
        for _attr in ("numChans", "num_chans", "numChannels"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is None:
                    try:
                        _chans = _o.chans()
                        _v = len(_chans)
                    except Exception:
                        pass
                if _v is not None:
                    report["num_chans"] = int(_v)
                    report["extra"][_attr] = int(_v)
                    break
            except Exception:
                pass
        for _attr in ("numSamples", "num_samples"):
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["num_samples"] = int(_v)
                    report["extra"][_attr] = int(_v)
                    break
            except Exception:
                pass

        # Errors: op.errors(recurse=False) preferred; fall back to no-args form.
        try:
            _errs = _o.errors(recurse=False)
            if _errs:
                for _e in _errs:
                    report["errors"].extend(str(_e).splitlines())
        except TypeError:
            try:
                _errs = _o.errors()
                if _errs:
                    for _e in _errs:
                        report["errors"].extend(str(_e).splitlines())
            except Exception as _e2:
                report["warnings"].append("errors(): " + str(_e2))
        except Exception as _e:
            report["warnings"].append("errors(recurse=False): " + str(_e))

        if not report["extra"]:
            del report["extra"]

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildNodeStateRuntimeScript(payload: object): string {
  return buildPayloadScript(NODE_STATE_RUNTIME_SCRIPT, payload);
}

export async function getNodeStateRuntimeImpl(ctx: ToolContext, args: GetNodeStateRuntimeArgs) {
  return guardTd(
    async () => {
      const script = buildNodeStateRuntimeScript({ path: args.path });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<NodeStateRuntimeReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`get_node_state_runtime failed: ${report.fatal}`, report);
      }
      const parts: string[] = [];
      if (report.cook_time_ms !== undefined) parts.push(`cook ${report.cook_time_ms.toFixed(2)}ms`);
      if (report.cook_count !== undefined) parts.push(`cooked ${report.cook_count}×`);
      if (report.resolution !== undefined) {
        const [w, h] = report.resolution;
        parts.push(`res ${String(w ?? "?")}×${String(h ?? "?")}`);
      }
      if (report.num_chans !== undefined) parts.push(`${report.num_chans} ch`);
      if (report.gpu_memory !== undefined)
        parts.push(`GPU ${(report.gpu_memory / 1024 / 1024).toFixed(1)}MB`);
      if (report.errors.length > 0) parts.push(`${report.errors.length} error(s)`);

      const detail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
      const summary = `${report.path} (${report.type ?? "unknown"})${detail}.`;

      return structuredResult(summary, {
        path: report.path,
        type: report.type ?? "",
        family: report.family,
        cook_time_ms: report.cook_time_ms,
        cook_count: report.cook_count,
        last_cook_frame: report.last_cook_frame,
        resolution: report.resolution,
        num_chans: report.num_chans,
        num_samples: report.num_samples,
        gpu_memory: report.gpu_memory,
        errors: report.errors,
        warnings: report.warnings,
        extra: report.extra,
      });
    },
  );
}

export const registerGetNodeStateRuntime: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_node_state_runtime",
    {
      title: "Get operator runtime state",
      description:
        "Read-only: inspect a single operator's runtime telemetry — cook time, cook count, last-cook frame, resolution (TOPs), channel/sample counts (CHOPs), GPU memory usage, and cook errors. Complements get_td_performance (which aggregates cook times across a network) by providing deep per-op detail for the 'why is it black / why is it slow' diagnostic loop. Returns {path, type, family, cook_time_ms, cook_count, last_cook_frame, resolution, num_chans, num_samples, gpu_memory, errors[], warnings[], extra}. Attribute names are flagged UNVERIFIED and vary by TD build; the `extra` map records which attrs were actually present for live confirmation.",
      inputSchema: getNodeStateRuntimeSchema.shape,
      outputSchema: getNodeStateRuntimeOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getNodeStateRuntimeImpl(ctx, args),
  );
};
