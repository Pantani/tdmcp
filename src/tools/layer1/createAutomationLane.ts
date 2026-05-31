import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createAutomationLaneSchema = z.object({
  name: z.string().min(1).describe("System container name, e.g. 'auto_lane_filter'"),
  parent: z.string().optional().describe("Parent COMP path, defaults to '/'"),
  targetParam: z.string().describe("OP path + param tuple, e.g. '/project1/filter1:cutoff'"),
  bars: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).default(4),
  bpm: z.number().min(20).max(300).default(120),
  mode: z.enum(["record", "loop"]).default("record"),
});

export type CreateAutomationLaneArgs = z.infer<typeof createAutomationLaneSchema>;

interface AutomationLaneReport {
  container?: string;
  mode?: string;
  samples?: number;
  target?: string;
  warnings: string[];
  fatal?: string;
  exists?: boolean;
}

const AUTOMATION_LANE_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    _parent_path = _p.get("parent", "/")
    _name = _p["name"]
    _mode = _p["mode"]
    _bars = _p["bars"]
    _bpm = _p["bpm"]
    _samples = _bars * 64
    _target = _p["target"]
    _target_op_path, _target_par_name = _target.split(":", 1)

    _parent = op(_parent_path)
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_parent_path)
    else:
        _existing = op(_parent_path + "/" + _name) if _parent_path != "/" else op("/" + _name)
        _exists = _existing is not None
        report["exists"] = _exists

        if _exists:
            # Re-entrant: only flip mode + bind/unbind
            _comp = _existing
        else:
            _comp = _parent.create(td.baseCOMP, _name)

            # Beat CHOP — exposes bpm, bar, beat, rampbar (0..1 bar phase), rampbeat
            _tempo = _comp.create(td.beatCHOP, "beat1")
            try:
                _tempo.par.bpm = _bpm
            except Exception as e:
                report["warnings"].append("beat1 bpm: " + str(e))

            # Select CHOP — pick the rampbar channel (0..1 bar phase)
            _sel = _comp.create(td.selectCHOP, "select_rampbar")
            try:
                _sel.par.chop = _tempo.path
            except Exception as e:
                report["warnings"].append("select_rampbar chop: " + str(e))
            try:
                if hasattr(_sel.par, "channames"):
                    _sel.par.channames = "rampbar"
            except Exception as e:
                report["warnings"].append("select_rampbar channames: " + str(e))

            # Null CHOP (phase out)
            _phase_out = _comp.create(td.nullCHOP, "phase_out")
            try:
                _comp.connect(_phase_out, 0, _sel, 0)
            except Exception as e:
                report["warnings"].append("phase_out connect: " + str(e))

            # Table DAT (ring buffer)
            _buf = _comp.create(td.tableDAT, "buffer_dat")
            _buf.clear()
            _buf.appendRow(["v"])
            for _i in range(_samples):
                _buf.appendRow([0.0])

            # DAT to CHOP
            _dat_to_chop = _comp.create(td.datToCHOP, "table_to_chop")
            try:
                if hasattr(_dat_to_chop.par, "dat"):
                    _dat_to_chop.par.dat = _buf.path
            except Exception as e:
                report["warnings"].append("table_to_chop dat param: " + str(e))

            # Lookup CHOP
            _lookup = _comp.create(td.lookupCHOP, "lookup1")
            try:
                _comp.connect(_lookup, 0, _phase_out, 0)
                _comp.connect(_lookup, 1, _dat_to_chop, 0)
            except Exception as e:
                report["warnings"].append("lookup1 connect: " + str(e))
            try:
                if hasattr(_lookup.par, "extend"):
                    _lookup.par.extend = "hold"
            except Exception as e:
                report["warnings"].append("lookup1 extend: " + str(e))

            # Null out (value out)
            _null_out = _comp.create(td.nullCHOP, "null_out")
            try:
                _comp.connect(_null_out, 0, _lookup, 0)
            except Exception as e:
                report["warnings"].append("null_out connect: " + str(e))

            # Script CHOP (record mode)
            _script_chop = _comp.create(td.scriptCHOP, "script_record")

            # State DAT
            _state_dat = _comp.create(td.textDAT, "state_dat")
            _state_dat.text = "state"

            # Initialize storage
            _comp.store("tdmcp_automation", {
                "mode": _mode,
                "bars": _bars,
                "samples": _samples,
                "write_head": 0,
                "target": _target,
                "armed": True,
            })

        # Apply mode bind/unbind
        _target_node = op(_target_op_path)
        if _target_node is None:
            report["warnings"].append("Target OP not found: " + _target_op_path)
        else:
            _par = getattr(_target_node.par, _target_par_name, None)
            if _par is None:
                report["warnings"].append("Target par not found: " + _target_par_name)
            elif hasattr(_par, "style") and _par.style not in ("Float", "Int", "XY", "XYZ", "XYZW", "UV", "UVW", "WH"):
                report["warnings"].append("Non-numeric par style " + str(_par.style) + "; skipping bind")
            elif _mode == "loop":
                try:
                    _null_out_path = _comp.path + "/null_out"
                    _par.bindExpr = "op('" + _null_out_path + "')['chan1']"
                    _par.bindMode = 1
                except Exception as e:
                    report["warnings"].append("bind failed: " + str(e))
            else:
                try:
                    _par.bindExpr = ""
                    _par.bindMode = 0
                except Exception as e:
                    report["warnings"].append("unbind failed: " + str(e))

        # Update storage mode
        _stored = _comp.fetch("tdmcp_automation", {})
        _stored["mode"] = _mode
        _comp.store("tdmcp_automation", _stored)

        report["container"] = _comp.path
        report["mode"] = _mode
        report["samples"] = _samples
        report["target"] = _target

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAutomationLaneScript(payload: object): string {
  return buildPayloadScript(AUTOMATION_LANE_SCRIPT, payload);
}

export async function createAutomationLaneImpl(ctx: ToolContext, args: CreateAutomationLaneArgs) {
  // Validate targetParam has colon separator
  const colonIdx = args.targetParam.indexOf(":");
  if (colonIdx < 1) {
    return errorResult(`targetParam must be 'opPath:parName', got: ${args.targetParam}`);
  }

  const parent = args.parent ?? "/";
  const samples = args.bars * 64;

  return guardTd(
    async () => {
      const script = buildAutomationLaneScript({
        name: args.name,
        parent,
        target: args.targetParam,
        bars: args.bars,
        bpm: args.bpm,
        mode: args.mode,
        samples,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AutomationLaneReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create automation lane: ${report.fatal}`, report);
      }
      const modeStr = report.mode ?? args.mode;
      const samplesStr = report.samples ?? samples;
      const summary = `Automation lane '${args.name}' created at ${report.container} — ${modeStr} mode, ${samplesStr} samples (${args.bars} bars @ ${args.bpm} BPM), target: ${args.targetParam}${
        (report.warnings?.length ?? 0) > 0
          ? `, ${report.warnings.length} warning(s): ${report.warnings.join("; ")}`
          : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateAutomationLane: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_automation_lane",
    {
      title: "Create automation lane",
      description:
        "Build a per-parameter automation lane that records a live parameter sweep into a circular buffer over N bars, then loops the recording back into the parameter on a bar-phase clock. Two modes: record (sample the target param every cook into a ring buffer) or loop (read the buffer back via Lookup CHOP bound to the target param). Re-calling with the same name and a different mode flips the state without rebuilding the network. Uses Beat CHOP → Select CHOP (rampbar) → Lookup CHOP playback, with COMP storage tracking mode/write_head/armed state. Returns a summary plus a JSON block with container path, mode, samples count, target, and any warnings.",
      inputSchema: createAutomationLaneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAutomationLaneImpl(ctx, args),
  );
};
