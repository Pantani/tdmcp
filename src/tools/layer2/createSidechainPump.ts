import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createSidechainPumpSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the sidechain pump container is created (e.g. '/project1')."),
  name: z
    .string()
    .default("sidechain_pump")
    .describe("Base name for the container COMP that holds the pump chain."),
  source_chop: z
    .string()
    .describe(
      "Path of the trigger CHOP (e.g. an onset Null, kick-level CHOP, or audio feature output). " +
        "This is the signal that drives the pump — high = dip.",
    ),
  channel: z
    .string()
    .default("level")
    .describe(
      "Channel name to follow from source_chop (e.g. 'level', 'kick', 'bass'). " +
        "The Select CHOP isolates it by name.",
    ),
  targets: z
    .array(z.string())
    .default([])
    .describe(
      "List of 'nodePath.parName' pairs to bind to the pump output by expression. " +
        "Each target dips toward rest*(1-depth) on a hit and returns to rest_value on silence. " +
        "Omit to build the chain only (bind manually with bind_to_channel later).",
    ),
  depth: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe(
      "How hard the pump dips on a trigger hit [0–1]. " +
        "0 = no dip (targets stay at rest_value), 1 = full dip to zero. " +
        "0.7–0.9 is typical for a strong pumping compressor feel.",
    ),
  attack: z.coerce
    .number()
    .min(0)
    .default(0.005)
    .describe(
      "Envelope rise time in seconds — how quickly the pump signal climbs after a hit " +
        "(controls how snappy the initial dip is). Typical: 0.001–0.02.",
    ),
  release: z.coerce
    .number()
    .min(0)
    .default(0.25)
    .describe(
      "Envelope fall time in seconds — how slowly the pump returns to silence after the trigger drops. " +
        "Controls the 'pumping tail'. Typical: 0.1–0.6.",
    ),
  rest_value: z.coerce
    .number()
    .default(1.0)
    .describe(
      "The target parameter value at silence (no trigger). On a hit, the expression drives the " +
        "target toward rest_value*(1-depth). Default 1.0 works for opacity/gain/level parameters.",
    ),
});

type CreateSidechainPumpArgs = z.infer<typeof createSidechainPumpSchema>;

interface SidechainPumpReport {
  container: string;
  pump_chop: string;
  bound: string[];
  depth: number;
  warnings: string[];
  fatal?: string;
}

// Build a CHOP chain inside a container:
//   source_chop (external, read by Select CHOP using absolute path) →
//   Select CHOP (par chop=source_chop, channames=channel — isolate by name, no cross-container wire) →
//   Lag CHOP (lagunit="seconds", lag1=attack, lag2=release) — shaped envelope →
//   Limit CHOP — clamp the envelope to [0,1] (type="clamp", min=0, max=1) →
//   Null CHOP "pump" — stable output handle; channel 0 drives target expressions.
//
// Target binding (mirror of createEnvelopeFollower target block exactly):
//   expr = "<rest_value> * (1 - <depth> * op('<null_path>')[<chan0_name>])"
//   getattr(node.par, parName) → par.expr = expr, par.mode = ParMode.EXPRESSION
//   Per-target failures → warnings; fatal only if source_chop or parent COMP missing.
//
// Limit CHOP clamp pars (live-validated on TD 099 build 2025.32820):
//   type="clamp", min=0, max=1; each guarded → warning if absent on another build.
const SIDECHAIN_PUMP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "pump_chop": "",
    "bound": [],
    "depth": _p["depth"],
    "warnings": [],
}
try:
    _src = _p["source_chop"]
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: " + str(_src)
    else:
        # Warn if channel is not yet present (chain still valid — tracks once source cooks).
        try:
            _ch_names = [c.name for c in _srcop.chans()]
            if _p["channel"] not in _ch_names:
                report["warnings"].append(
                    "Channel '%s' not present on %s yet; pump built anyway (will track once it exists). Available: %s"
                    % (_p["channel"], _src, _ch_names)
                )
        except Exception:
            report["warnings"].append("Could not enumerate channels on %s." % _src)

        # Create the container COMP.
        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
        else:
            try:
                _cont = _parent.create(baseCOMP, _p["name"])
            except Exception as _e:
                report["fatal"] = "Could not create container: " + str(_e)
                _cont = None
            if _cont is not None:
                report["container"] = _cont.path

                # --- Select CHOP: isolate source channel by absolute path ---
                _sel = None
                try:
                    _sel = _cont.create(selectCHOP, "sel")
                    _sel.par.chop = _src
                    _sel.par.channames = _p["channel"]
                except Exception as _e:
                    report["warnings"].append("Select CHOP failed: " + str(_e))
                    _sel = None

                # --- Lag CHOP: attack/release shaping ---
                _lag = None
                try:
                    _lag = _cont.create(lagCHOP, "lag")
                    if _sel is not None:
                        _lag.inputConnectors[0].connect(_sel)
                    _lag.par.lagunit = "seconds"
                    _lag.par.lag1 = _p["attack"]
                    _lag.par.lag2 = _p["release"]
                except Exception as _e:
                    report["warnings"].append("Lag CHOP failed: " + str(_e))
                    _lag = None

                # --- Limit CHOP: clamp envelope to [0,1] ---
                # The Math CHOP has NO clamp pars (only fromrange/torange remap); the
                # correct TD primitive is a Limit CHOP with type="clamp" + min/max.
                # Par names live-validated on TD 099 build 2025.32820; each set guarded.
                _clamp = None
                try:
                    _clamp = _cont.create(limitCHOP, "clamp")
                    if _lag is not None:
                        _clamp.inputConnectors[0].connect(_lag)
                    try:
                        _clamp.par.type = "clamp"
                    except Exception:
                        report["warnings"].append(
                            "limitCHOP par 'type' not found; clamp mode not set (UNVERIFIED TD build)."
                        )
                    try:
                        _clamp.par.min = 0
                    except Exception:
                        report["warnings"].append("limitCHOP par 'min' not found; lower bound not clamped.")
                    try:
                        _clamp.par.max = 1
                    except Exception:
                        report["warnings"].append("limitCHOP par 'max' not found; upper bound not clamped.")
                except Exception as _e:
                    report["warnings"].append("Limit/clamp CHOP failed (%s); output is the raw lag." % str(_e))
                    _clamp = None

                # --- Null CHOP: stable output handle for the pump signal ---
                _null = None
                _prev = _clamp if _clamp is not None else (_lag if _lag is not None else _sel)
                try:
                    _null = _cont.create(nullCHOP, "pump")
                    if _prev is not None:
                        _null.inputConnectors[0].connect(_prev)
                    report["pump_chop"] = _null.path
                except Exception as _e:
                    report["pump_chop"] = _prev.path if _prev is not None else ""
                    report["warnings"].append("Null CHOP failed: " + str(_e))
                    _null = None

                # --- Bind targets by expression ---
                # Pump curve: rest_value * (1 - depth * pump_signal)
                # pump_signal is channel 0 of the Null CHOP (or fallback path).
                _pump_path = report["pump_chop"]
                _depth = _p["depth"]
                _rest = _p["rest_value"]

                # Determine the channel name to read from the Null CHOP (use chan0 name).
                _chan0 = _p["channel"]  # default to the user-supplied channel name
                if _null is not None:
                    try:
                        _null_chans = [c.name for c in _null.chans()]
                        if _null_chans:
                            _chan0 = _null_chans[0]
                    except Exception:
                        pass  # stick with _p["channel"]

                # Build the expression string.
                # e.g.: 1.0 * (1 - 0.8 * op('/project1/sidechain_pump/pump')['level'])
                # If the whole pump chain failed, _pump_path is "" and op('') would bind to
                # an unintended operator (or error at cook). Fall back to a constant
                # rest_value so targets stay at a sane value instead.
                if _pump_path:
                    _expr = "%r * (1 - %r * op(%r)[%r])" % (_rest, _depth, _pump_path, _chan0)
                else:
                    _expr = "%r" % _rest
                    report["warnings"].append(
                        "No pump output (chain failed); binding targets to constant rest_value %r." % _rest
                    )

                for _t in _p.get("targets", []):
                    try:
                        _dot = _t.rfind(".")
                        if _dot <= 0:
                            report["warnings"].append(
                                "Invalid target '%s' (expected 'nodePath.parName')." % _t
                            )
                            continue
                        _np = _t[:_dot]; _pn = _t[_dot + 1:]
                        _n = op(_np)
                        if _n is None:
                            report["warnings"].append("Target node not found: " + _np)
                            continue
                        _par = getattr(_n.par, _pn, None)
                        if _par is None:
                            report["warnings"].append("Target parameter not found: " + _t)
                            continue
                        _PM = type(_par.mode)
                        _par.expr = _expr
                        _par.mode = _PM.EXPRESSION
                        report["bound"].append(_t)
                    except Exception:
                        report["warnings"].append(
                            "Failed to bind '%s': %s" % (_t, traceback.format_exc().splitlines()[-1])
                        )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSidechainPumpScript(payload: object): string {
  return buildPayloadScript(SIDECHAIN_PUMP_SCRIPT, payload);
}

export async function createSidechainPumpImpl(
  ctx: ToolContext,
  args: CreateSidechainPumpArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return guardTd(
    async () => {
      const script = buildSidechainPumpScript({
        parent_path: args.parent_path,
        name: args.name,
        source_chop: args.source_chop,
        channel: args.channel,
        targets: args.targets,
        depth: args.depth,
        attack: args.attack,
        release: args.release,
        rest_value: args.rest_value,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SidechainPumpReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Sidechain pump build failed: ${report.fatal}`, report);
      }
      const boundNote = report.bound.length > 0 ? `, bound ${report.bound.length} target(s)` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary =
        `Built sidechain pump on ${args.source_chop}['${args.channel}'] ` +
        `(depth ${report.depth}, attack ${args.attack}s / release ${args.release}s, ` +
        `rest ${args.rest_value}) → ${report.pump_chop}${boundNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateSidechainPump: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_sidechain_pump",
    {
      title: "Create sidechain pump",
      description:
        "EXPERIMENTAL — One-call 'pump the whole rig on the kick': build a sidechain ducking " +
        "envelope from a trigger CHOP channel and bind multiple target parameters to dip on every hit. " +
        "Distinct from create_envelope_follower (which builds the chain + optional gate/duck mode with a " +
        "threshold); this tool is the ergonomic multi-target pump with a single depth knob and a rest_value " +
        "anchor — ideal for classic pumping compressor feel across many targets at once. " +
        "Builds a container with: a Select CHOP isolating the source channel by absolute path (no " +
        "cross-container wires), a Lag CHOP shaping attack/release, a Limit CHOP clamping to [0,1] " +
        "(type=clamp/min/max, live-validated on TD 099 — guarded with warnings), and a Null CHOP " +
        "'pump' as the stable output handle. Each target gets the expression: " +
        "rest_value * (1 - depth * op('<pump>')[chan0]). Per-target failures become warnings; " +
        "fatal only if source_chop or parent COMP is missing.",
      inputSchema: createSidechainPumpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSidechainPumpImpl(ctx, args),
  );
};
