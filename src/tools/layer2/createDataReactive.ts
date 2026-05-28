import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createDataReactiveSchema = z.object({
  target: z.string().describe("COMP whose numeric custom parameters should react to the data."),
  source_chop: z
    .string()
    .describe(
      "CHOP carrying the live data channels (e.g. a create_data_source Null). Channels can be weather values, follower counts, sensor readings, etc.",
    ),
  mappings: z
    .array(
      z.object({
        param: z.string().describe("Target custom-parameter name on the COMP, e.g. 'Speed'."),
        channel: z.string().describe("Source CHOP channel to drive it, e.g. 'temperature'."),
        in_min: z.coerce
          .number()
          .default(0)
          .describe(
            "Input range min (data value). Data is rarely 0–1, set this to the expected minimum.",
          ),
        in_max: z.coerce
          .number()
          .default(1)
          .describe(
            "Input range max (data value). Set this to the expected maximum of the data channel.",
          ),
        out_min: z.coerce.number().default(0).describe("Output range min (param value)."),
        out_max: z.coerce.number().default(1).describe("Output range max (param value)."),
      }),
    )
    .min(1)
    .describe(
      "Explicit data→param mappings with per-mapping range remap. Data is rarely 0–1, so set in_min/in_max to the real data range for correct visual mapping.",
    ),
  smooth: z.coerce
    .number()
    .min(0)
    .default(0.0)
    .describe(
      "Symmetric smoothing in seconds (Lag CHOP) applied to all channels so noisy data does not jitter visuals. 0 = no smoothing.",
    ),
});
type CreateDataReactiveArgs = z.infer<typeof createDataReactiveSchema>;

interface BoundEntry {
  param: string;
  channel: string;
  expr: string;
}

interface DataReactiveReport {
  target: string;
  source_chop: string;
  bound: BoundEntry[];
  smoothed: boolean;
  smoothing_select?: string;
  smoothing_lag?: string;
  warnings: string[];
  fatal?: string;
}

// One Python pass: validate the target COMP, optionally probe the source CHOP for channels,
// then for each mapping build a range-remap expression that maps the raw data range
// [in_min, in_max] → [out_min, out_max] and sets the custom parameter to expression mode.
//
// Range-remap formula (guards divide-by-zero when in_min == in_max):
//   out_min + clamp((chan - in_min) / (in_max - in_min), 0, 1) * (out_max - out_min)
// When in_min == in_max the divisor collapses to 1 (not 0) so the expression still cooks.
//
// Optional smoothing: if smooth > 0, a Select CHOP isolates all named channels by
// absolute path (no cross-container wire needed) and a Lag CHOP (lag1=lag2=smooth, unit=seconds)
// smooths them symmetrically. The remap expressions then reference the lagged null, not the raw
// source — identical to the lag chain in bind_to_channel and detect_onsets.
//
// Probe pattern mirrors bind_audio_reactive: flags custom-par access UNVERIFIED (TD offline).
// Source CHOP absent → warning + bind anyway; target absent or not-COMP → fatal.
const DATA_REACTIVE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
  "target": _p["target"],
  "source_chop": _p["source_chop"],
  "bound": [],
  "smoothed": False,
  "warnings": [],
}
try:
    _t = op(_p["target"])
    if _t is None:
        report["fatal"] = "Target not found: " + str(_p["target"])
    elif not hasattr(_t, "customPars"):
        report["fatal"] = str(_p["target"]) + " is not a COMP, so it has no custom parameters to bind."
    else:
        _src_path = _p["source_chop"]
        _src = op(_src_path)
        if _src is None:
            report["warnings"].append("Source CHOP not found: %s; binding anyway (expressions will track once it exists)." % _src_path)
        else:
            try:
                _avail = [c.name for c in _src.chans()]
                for _m in _p["mappings"]:
                    if _m["channel"] not in _avail:
                        report["warnings"].append("Channel '%s' not present on %s yet; binding anyway." % (_m["channel"], _src_path))
            except Exception:
                report["warnings"].append("Could not enumerate channels on %s." % _src_path)

        # Optional smoothing: Select + Lag chain in the target's parent network.
        # All requested channels are funnelled through a single Select (channames = space-separated),
        # then a single Lag CHOP, so the number of nodes is constant regardless of mapping count.
        _read_op = _src_path
        if _p.get("smooth", 0) > 0:
            try:
                _cont = _t.parent().path if _t.parent() is not None else "/project1"
                _parent_op = op(_cont)
                if _parent_op is None:
                    report["warnings"].append("Could not resolve smoothing container %s; using raw channel." % _cont)
                else:
                    _chan_names = " ".join(set(_m["channel"] for _m in _p["mappings"]))
                    _sel = _parent_op.create(selectCHOP, _p["select_name"])
                    _sel.par.chop = _src_path
                    _sel.par.channames = _chan_names
                    _lag = _parent_op.create(lagCHOP, _p["lag_name"])
                    _lag.inputConnectors[0].connect(_sel)
                    _lag.par.lagunit = "seconds"
                    _lag.par.lag1 = _p["smooth"]
                    _lag.par.lag2 = _p["smooth"]
                    _read_op = _lag.path
                    report["smoothed"] = True
                    report["smoothing_select"] = _sel.path
                    report["smoothing_lag"] = _lag.path
            except Exception:
                report["warnings"].append("Smoothing setup failed: %s; using raw channel." % traceback.format_exc().splitlines()[-1])

        # Apply each mapping as an expression on the target custom parameter.
        for _m in _p["mappings"]:
            try:
                _par = getattr(_t.par, _m["param"], None)
                if _par is None:
                    report["warnings"].append("Custom parameter not found on %s: %s" % (_p["target"], _m["param"]))
                    continue
                _in_min = _m["in_min"]; _in_max = _m["in_max"]
                _out_min = _m["out_min"]; _out_max = _m["out_max"]
                # Guard divide-by-zero: if the input range is degenerate, divisor collapses to 1.
                _span = _in_max - _in_min if _in_max != _in_min else 1.0
                _src_repr = repr(_read_op); _chan_repr = repr(_m["channel"])
                _expr = "(%s) + clamp((op(%s)[%s] - (%s)) / (%s), 0, 1) * (%s)" % (
                    repr(float(_out_min)),
                    _src_repr, _chan_repr,
                    repr(float(_in_min)),
                    repr(float(_span)),
                    repr(float(_out_max - _out_min)),
                )
                # Check existing binding and skip if already in expression mode (don't clobber).
                try:
                    _PM = type(_par.mode)
                    if _par.mode == _PM.EXPRESSION:
                        report["warnings"].append("Parameter %s is already in expression mode — skipped." % _m["param"])
                        continue
                except Exception:
                    _PM = type(_par.mode)
                _par.expr = _expr
                _par.mode = _PM.EXPRESSION
                report["bound"].append({"param": _m["param"], "channel": _m["channel"], "expr": _expr})
            except Exception:
                report["warnings"].append("Failed to bind %s: %s" % (_m["param"], traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDataReactiveScript(payload: object): string {
  return buildPayloadScript(DATA_REACTIVE_SCRIPT, payload);
}

export async function createDataReactiveImpl(
  ctx: ToolContext,
  args: CreateDataReactiveArgs,
): Promise<CallToolResult> {
  return guardTd(
    async () => {
      // Derive unique select/lag names from the first channel name so the smoothing
      // nodes are recognisable in the network (mirrors bind_to_channel's convention).
      const firstChan = args.mappings[0]?.channel ?? "data";
      const script = buildDataReactiveScript({
        target: args.target,
        source_chop: args.source_chop,
        mappings: args.mappings.map((m) => ({
          param: m.param,
          channel: m.channel,
          in_min: m.in_min,
          in_max: m.in_max,
          out_min: m.out_min,
          out_max: m.out_max,
        })),
        smooth: args.smooth,
        select_name: `${firstChan}_sel`,
        lag_name: `${firstChan}_lag`,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DataReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not make ${args.target} react to data: ${report.fatal}`, report);
      }
      const smoothNote = report.smoothed
        ? ` with smoothing (${args.smooth}s Lag via ${report.smoothing_lag})`
        : "";
      const warnNote = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
      const summary = `Mapped ${report.bound.length} data channel(s) onto ${args.target}${smoothNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateDataReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_data_reactive",
    {
      title: "Map live data channels onto visual params",
      description:
        "Wire arbitrary external data (weather, follower count, sensor readings, OSC values) onto a COMP's custom numeric parameters — the data counterpart to bind_audio_reactive. Point `target` at a COMP with numeric custom-parameter knobs, `source_chop` at a live-data CHOP (e.g. a create_data_source Null), and provide explicit `mappings` (data channel → param name) each with an input range [in_min, in_max] and output range [out_min, out_max] so the data is correctly re-mapped to the parameter's visual range. Set `smooth` > 0 to insert a Lag CHOP (symmetric attack+release) so noisy or jittery data does not flicker the visuals. Fail-forward: a missing source CHOP or absent channel are warnings — only a missing/non-COMP target is fatal. Build the data CHOP first with create_data_source; use bind_to_channel for finer single-parameter control.",
      inputSchema: createDataReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDataReactiveImpl(ctx, args),
  );
};
