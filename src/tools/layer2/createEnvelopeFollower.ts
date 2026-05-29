import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createEnvelopeFollowerSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to build the follower chain (a COMP path, e.g. '/project1')."),
  name: z
    .string()
    .default("envelope_follower")
    .describe("Base name for the container COMP that holds the chain."),
  source_chop: z
    .string()
    .describe(
      "Path of the CHOP carrying the trigger channel (e.g. '/project1/audio/features' or an onset Null).",
    ),
  channel: z
    .string()
    .describe(
      "Channel name to follow from source_chop (e.g. 'bass', 'kick', 'level'). The Select CHOP isolates it by name.",
    ),
  attack: z.coerce
    .number()
    .min(0)
    .default(0.01)
    .describe(
      "Envelope rise time in seconds — how quickly the output climbs after a hit (fast = punchy, e.g. 0.001–0.05).",
    ),
  release: z.coerce
    .number()
    .min(0)
    .default(0.3)
    .describe(
      "Envelope fall time in seconds — how slowly the output decays after the signal drops (slow = smooth tail, e.g. 0.1–0.8).",
    ),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe(
      "Gate threshold [0–1]. Below this level the output is silenced (gate) or held at 1 (duck). Start low (0.05–0.2) and raise if false triggers occur. NOTE: gate thresholding uses a Logic CHOP whose par names may vary by TD build — EXPERIMENTAL.",
    ),
  mode: z
    .enum(["gate", "duck"])
    .default("gate")
    .describe(
      "gate: pass the shaped envelope only while it is above threshold — silences the output when the signal is quiet. duck: sidechain/ducking — the output dips toward 0 on every hit and returns to 1 on silence (inverted gate, classic pumping compressor feel).",
    ),
  targets: z
    .array(z.string())
    .default([])
    .describe(
      "Optional list of 'nodePath.parName' targets to bind to the shaped envelope output by expression. Omit to just build the chain (the Null CHOP output can be bound later with bind_to_channel).",
    ),
});
type CreateEnvelopeFollowerArgs = z.infer<typeof createEnvelopeFollowerSchema>;

interface EnvelopeFollowerReport {
  container: string;
  output_chop: string;
  select_chop: string;
  lag_chop: string;
  threshold_chop: string;
  mode: string;
  attack: number;
  release: number;
  threshold: number;
  channel: string;
  bound: string[];
  warnings: string[];
  fatal?: string;
}

// Build a CHOP chain inside a container:
//   source_chop (external, read by path) →
//   Select CHOP (isolate one channel by absolute path, no cross-container wire needed) →
//   Lag CHOP (lag1=attack rise, lag2=release fall, in seconds) — shaped envelope →
//   Math/Logic CHOP applying threshold/gate:
//     gate: multiply the envelope by (envelope > threshold), i.e. zero below threshold.
//       We use a Logic CHOP convert="bound" boundmin=threshold boundmax=1e6 to produce
//       a 0/1 mask, then a Math CHOP (multiply) to gate the envelope. Par names for
//       Logic: convert, boundmin, boundmax (KB-confirmed from detect_onsets). Failures
//       are collected as warnings (fail-forward: the plain lag is still a valid output).
//     duck: 1 − clamp(envelope, 0, 1) — invert for sidechain/ducking. Uses a Math CHOP
//       multiply=-1, add=1, clamp to [0,1] (or equivalent range chop). We use a simple
//       Math CHOP range remap: from [0,1]→[1,0], which is gain=-1 + add=1. Failures → warnings.
//   Null CHOP as the stable shaped output handle.
//   If targets given, bind each to the Null's channel by expression (mirror bindToChannel).
//   Per-target and per-op failures → report["warnings"]. fatal only for source not found.
const ENVELOPE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_chop": "",
    "select_chop": "",
    "lag_chop": "",
    "threshold_chop": "",
    "mode": _p["mode"],
    "attack": _p["attack"],
    "release": _p["release"],
    "threshold": _p["threshold"],
    "channel": _p["channel"],
    "bound": [],
    "warnings": [],
}
try:
    _src = _p["source_chop"]
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: " + str(_src)
    else:
        # Verify the channel exists; warn but continue if not (it may cook later).
        try:
            _ch_names = [c.name for c in _srcop.chans()]
            if _p["channel"] not in _ch_names:
                report["warnings"].append(
                    "Channel '%s' not present on %s yet; chain built anyway (will track once it exists). Available: %s"
                    % (_p["channel"], _src, _ch_names)
                )
        except Exception:
            report["warnings"].append("Could not enumerate channels on %s." % _src)

        # Create a container COMP to hold the chain.
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
                try:
                    _sel = _cont.create(selectCHOP, "sel")
                    _sel.par.chop = _src
                    _sel.par.channames = _p["channel"]
                    report["select_chop"] = _sel.path
                except Exception as _e:
                    report["warnings"].append("Select CHOP failed: " + str(_e))
                    _sel = None

                # --- Lag CHOP: attack/release envelope ---
                _lag = None
                try:
                    _lag = _cont.create(lagCHOP, "lag")
                    if _sel is not None:
                        _lag.inputConnectors[0].connect(_sel)
                    _lag.par.lagunit = "seconds"
                    _lag.par.lag1 = _p["attack"]
                    _lag.par.lag2 = _p["release"]
                    report["lag_chop"] = _lag.path
                except Exception as _e:
                    report["warnings"].append("Lag CHOP failed: " + str(_e))

                # --- Threshold / gate / duck ---
                _thr_out = _lag  # fallback: just the lag
                _mode = _p["mode"]
                _thr = _p["threshold"]

                if _mode == "gate":
                    # Logic CHOP: 0/1 mask above threshold (par names from detect_onsets:
                    # convert, boundmin, boundmax). Then Math CHOP multiplies envelope * mask.
                    try:
                        _logic = _cont.create(logicCHOP, "gate_mask")
                        if _lag is not None:
                            _logic.inputConnectors[0].connect(_lag)
                        try:
                            _logic.par.convert = "bound"
                        except Exception:
                            report["warnings"].append(
                                "logicCHOP par 'convert' not found; gate mask may not work (UNVERIFIED TD build)."
                            )
                        try:
                            _logic.par.boundmin = _thr
                        except Exception:
                            report["warnings"].append(
                                "logicCHOP par 'boundmin' not found; threshold not applied."
                            )
                        try:
                            _logic.par.boundmax = 1000000
                        except Exception:
                            pass
                        # Multiply: Math CHOP with two inputs (lag envelope + logic mask)
                        _mul = _cont.create(mathCHOP, "gate_apply")
                        if _lag is not None:
                            _mul.inputConnectors[0].connect(_lag)
                        _mul.inputConnectors[1].connect(_logic)
                        try:
                            _mul.par.chopop = "multiply"
                        except Exception:
                            report["warnings"].append(
                                "mathCHOP par 'chopop' could not be set to 'multiply'; gate multiplication may not apply."
                            )
                        _thr_out = _mul
                        report["threshold_chop"] = _mul.path
                    except Exception as _e:
                        report["warnings"].append(
                            "Gate threshold chain failed (%s); output is the raw envelope." % str(_e)
                        )

                elif _mode == "duck":
                    # Sidechain/ducking: invert envelope so output dips to 0 on a hit.
                    # Math CHOP: gain=-1 + add=1 maps [0→1] to [1→0]. Clamp to [0,1] via range.
                    try:
                        _inv = _cont.create(mathCHOP, "duck_invert")
                        if _lag is not None:
                            _inv.inputConnectors[0].connect(_lag)
                        try:
                            _inv.par.gain = -1
                        except Exception:
                            report["warnings"].append("mathCHOP par 'gain' not found for duck invert.")
                        try:
                            _inv.par.add = 1
                        except Exception:
                            report["warnings"].append("mathCHOP par 'add' not found for duck invert.")
                        # Clamp: Math CHOP with clip
                        _clamp = _cont.create(mathCHOP, "duck_clamp")
                        _clamp.inputConnectors[0].connect(_inv)
                        try:
                            _clamp.par.clamp = True
                        except Exception:
                            try:
                                _clamp.par.clamp = 1
                            except Exception:
                                report["warnings"].append(
                                    "mathCHOP par 'clamp' not found; duck output may exceed [0,1]."
                                )
                        try:
                            _clamp.par.clampmin = 0
                            _clamp.par.clampmax = 1
                        except Exception:
                            report["warnings"].append(
                                "mathCHOP clamp range pars not found; duck output may exceed [0,1]."
                            )
                        _thr_out = _clamp
                        report["threshold_chop"] = _clamp.path
                    except Exception as _e:
                        report["warnings"].append(
                            "Duck/invert chain failed (%s); output is the raw envelope." % str(_e)
                        )

                # --- Null CHOP: stable output handle ---
                try:
                    _null = _cont.create(nullCHOP, "out")
                    if _thr_out is not None:
                        _null.inputConnectors[0].connect(_thr_out)
                    report["output_chop"] = _null.path
                except Exception as _e:
                    # Fall back to the threshold/lag node as output
                    report["output_chop"] = _thr_out.path if _thr_out else report.get("lag_chop", "")
                    report["warnings"].append("Null CHOP failed: " + str(_e))
                    _null = None

                # --- Bind targets by expression (mirror bindToChannel) ---
                _read_path = report["output_chop"] if report["output_chop"] else (
                    report["lag_chop"] if report["lag_chop"] else _src
                )
                _ch = _p["channel"]
                _expr = "op(%s)[%s]" % (repr(_read_path), repr(_ch))
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

export function buildEnvelopeFollowerScript(payload: object): string {
  return buildPayloadScript(ENVELOPE_SCRIPT, payload);
}

export async function createEnvelopeFollowerImpl(
  ctx: ToolContext,
  args: CreateEnvelopeFollowerArgs,
) {
  return guardTd(
    async () => {
      const script = buildEnvelopeFollowerScript({
        parent_path: args.parent_path,
        name: args.name,
        source_chop: args.source_chop,
        channel: args.channel,
        attack: args.attack,
        release: args.release,
        threshold: args.threshold,
        mode: args.mode,
        targets: args.targets,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<EnvelopeFollowerReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Envelope follower build failed: ${report.fatal}`, report);
      }
      const boundNote = report.bound.length > 0 ? `, bound ${report.bound.length} target(s)` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built a ${report.mode} envelope follower on ${args.source_chop}['${args.channel}'] (attack ${report.attack}s / release ${report.release}s, threshold ${report.threshold}) → ${report.output_chop}${boundNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateEnvelopeFollower: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_envelope_follower",
    {
      title: "Create envelope follower",
      description:
        "EXPERIMENTAL — Build a reactive signal-shaping chain (attack/release envelope + threshold gate or sidechain ducking) from a CHOP channel, for 'pump the whole layer on every kick' or similar sidechain effects. Creates a container with: a Select CHOP isolating the source channel by absolute path (no cross-container wire), a Lag CHOP shaping the attack/release envelope, a Logic+Math CHOP threshold gate (gate mode: silence the output below threshold) or an inverted Math CHOP (duck mode: output dips to 0 on a hit, rises on silence — classic sidechain pumping), and a Null CHOP as the stable output handle. Optionally binds the shaped output to target parameters by expression. The gate threshold uses a Logic CHOP whose par names (convert/boundmin/boundmax) match detect_onsets — but these are UNVERIFIED across TD builds; gate reads near 0 at the 0.2 default with most sources — tune threshold live. Use bind_to_channel with attack/release for a simpler Lag-only envelope without a gate.",
      inputSchema: createEnvelopeFollowerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createEnvelopeFollowerImpl(ctx, args),
  );
};
