import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const bindToChannelSchema = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe(
      "Parameters to drive, each written as 'nodePath.parName' (e.g. '/project1/sys/transform1.scale'). Each is switched to expression mode so it tracks the channel live.",
    ),
  source_chop: z
    .string()
    .describe("Path of the CHOP that carries the driving channel (e.g. an audio_features Null)."),
  channel: z
    .string()
    .describe("Channel name to read from the source CHOP (e.g. 'bass', 'level', 'ramp', 'pulse')."),
  scale: z.coerce.number().default(1).describe("Multiply the channel value (mapping gain)."),
  offset: z.coerce.number().default(0).describe("Add to the scaled value (mapping offset)."),
  attack: z.coerce
    .number()
    .min(0)
    .optional()
    .describe(
      "Smoothing rise time in seconds — how slowly the bound value follows the channel UP. 0 = instant (no smoothing on the way up). A small attack with a larger release gives a snappy hit that decays smoothly (envelope follow).",
    ),
  release: z.coerce
    .number()
    .min(0)
    .optional()
    .describe(
      "Smoothing fall time in seconds — how slowly the bound value follows the channel DOWN. 0 = instant (no smoothing on the way down). Set release > attack to remove flicker while keeping transients punchy.",
    ),
  smooth: z.coerce
    .number()
    .min(0)
    .optional()
    .describe(
      "Convenience: symmetric smoothing time in seconds applied to BOTH rise and fall (sets attack=release=smooth). Use this for simple low-pass-style de-jitter; use attack/release separately for an envelope follower.",
    ),
  smoothing_container: z
    .string()
    .optional()
    .describe(
      "Where to create the Select+Lag smoothing CHOPs when smoothing is active; defaults to the first target's parent network. Ignored when no smoothing is requested.",
    ),
});
type BindToChannelArgs = z.infer<typeof bindToChannelSchema>;

interface BindReport {
  bound: string[];
  expression?: string;
  channel_present?: boolean;
  smoothed?: boolean;
  smoothing_select?: string;
  smoothing_lag?: string;
  attack?: number;
  release?: number;
  warnings: string[];
  fatal?: string;
}

// One Python pass: build the expression op('chop')['chan'] (* scale) (+ offset) and switch
// each target parameter to expression mode tracking it. ParMode isn't in the exec globals,
// so the expression-mode enum is derived from a live parameter (type(par.mode)), mirroring
// animate_parameter.
//
// Optional smoothing (attack/release > 0): instead of reading the raw channel, insert a
// Select CHOP that isolates the single source channel (by absolute path — no cross-container
// wire needed) feeding a Lag CHOP (lag1=attack, lag2=release, lagunit=seconds). The bind
// expression then references the LAGGED channel, so a fast attack + slow release follows the
// audio envelope smoothly instead of flickering on the raw value. This mirrors the lag
// primitive chain in detect_onsets. The smoothing nodes are created in the first target's
// parent network (overridable) — near what they drive — and read the source by absolute path.
const BIND_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"bound": [], "warnings": []}
try:
    _src = _p["source_chop"]; _ch = _p["channel"]
    _scale = _p["scale"]; _offset = _p["offset"]
    _lag1 = _p["lag1"]; _lag2 = _p["lag2"]; _smooth = (_lag1 > 0 or _lag2 > 0)
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: %s" % _src
    else:
        try:
            report["channel_present"] = _ch in [c.name for c in _srcop.chans()]
        except Exception:
            report["channel_present"] = None
        if report.get("channel_present") is False:
            report["warnings"].append("Channel '%s' not present on %s yet; binding anyway (it will track once it exists)." % (_ch, _src))
        # The CHOP+channel the expression reads from: the raw source by default, or the
        # lagged null when smoothing is on. Built before the target loop so every target
        # binds to the same (possibly smoothed) channel.
        _read_op = _src; _read_ch = _ch
        report["smoothed"] = False
        if _smooth:
            # Resolve a container for the smoothing nodes: explicit override, else the
            # first target's parent network (so the lag lives beside what it drives).
            _cont = _p.get("smoothing_container")
            if not _cont:
                _first = _p["targets"][0]; _fdot = _first.rfind(".")
                _fnode = op(_first[:_fdot]) if _fdot > 0 else None
                _cont = _fnode.parent().path if _fnode is not None else "/project1"
            _parent = op(_cont)
            if _parent is None:
                report["warnings"].append("Smoothing container not found: %s; binding to the raw channel instead." % _cont)
            else:
                # Select CHOP isolates the single source channel by absolute path (expressions
                # eval relative to PARENT, so an absolute path is required and no cross-container
                # wire is needed). Lag CHOP then smooths that one channel: lag1=attack rise,
                # lag2=release fall, in seconds. Channel name survives, so the bind reads it back.
                _sel = _parent.create(selectCHOP, _p["select_name"])
                _sel.par.chop = _src
                _sel.par.channames = _ch
                _lag = _parent.create(lagCHOP, _p["lag_name"])
                _lag.inputConnectors[0].connect(_sel)
                _lag.par.lagunit = "seconds"
                _lag.par.lag1 = _lag1
                _lag.par.lag2 = _lag2
                _read_op = _lag.path; _read_ch = _ch
                report["smoothed"] = True
                report["smoothing_select"] = _sel.path
                report["smoothing_lag"] = _lag.path
                report["attack"] = _lag1; report["release"] = _lag2
        _expr = "op(%s)[%s]" % (repr(_read_op), repr(_read_ch))
        if _scale != 1:
            _expr = "(%s) * %s" % (_expr, repr(_scale))
        if _offset != 0:
            _expr = "%s + %s" % (_expr, repr(_offset))
        report["expression"] = _expr
        for _t in _p["targets"]:
            try:
                _dot = _t.rfind(".")
                if _dot <= 0:
                    report["warnings"].append("Invalid target '%s' (expected 'nodePath.parName')." % _t); continue
                _np = _t[:_dot]; _pn = _t[_dot + 1:]; _n = op(_np)
                if _n is None:
                    report["warnings"].append("Target node not found: %s" % _np); continue
                _par = getattr(_n.par, _pn, None)
                if _par is None:
                    report["warnings"].append("Target parameter not found: %s" % _t); continue
                _PM = type(_par.mode)
                _par.expr = _expr; _par.mode = _PM.EXPRESSION
                report["bound"].append(_t)
            except Exception:
                report["warnings"].append("Failed to bind '%s': %s" % (_t, traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildBindScript(payload: object): string {
  return buildPayloadScript(BIND_SCRIPT, payload);
}

export async function bindToChannelImpl(ctx: ToolContext, args: BindToChannelArgs) {
  // `smooth` is a convenience for symmetric attack=release; explicit attack/release win
  // when given. Resolving to lag1/lag2 here keeps the Python pass simple and means the
  // no-smoothing case (both 0) reproduces the original raw-channel bind byte-for-byte.
  // The `?? 0` makes a missing attack/release (e.g. unparsed args) behave as off, matching
  // the schema defaults, so the Python `_lag1 > 0` test never sees a missing key.
  const lag1 = args.smooth ?? args.attack ?? 0;
  const lag2 = args.smooth ?? args.release ?? 0;
  return guardTd(
    async () => {
      const script = buildBindScript({
        targets: args.targets,
        source_chop: args.source_chop,
        channel: args.channel,
        scale: args.scale,
        offset: args.offset,
        lag1,
        lag2,
        select_name: `${args.channel}_sel`,
        lag_name: `${args.channel}_lag`,
        smoothing_container: args.smoothing_container ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BindReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not bind to channel: ${report.fatal}`, report);
      }
      const smoothNote = report.smoothed
        ? ` with smoothing (attack ${report.attack}s / release ${report.release}s via ${report.smoothing_lag})`
        : "";
      const summary = `Bound ${report.bound.length} parameter(s) to ${args.source_chop}['${args.channel}']${smoothNote} (${report.expression})${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerBindToChannel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bind_to_channel",
    {
      title: "Bind parameter to channel",
      description:
        "Drive one or more node parameters from a CHOP channel by expression — the link that makes a visual react. Point it at an audio_features channel (bass/mid/treble/level) or a tempo_sync channel (ramp/pulse/beat) with a scale and offset, and each target parameter tracks that signal live. This is how you wire extract_audio_features / create_tempo_sync into a visual system. Optionally add attack/release smoothing (in seconds) — or a single `smooth` time — to insert a Lag CHOP between the channel and the parameter so reactivity follows a clean envelope instead of flickering on raw audio (e.g. a fast attack + slow release for a punchy hit that decays smoothly).",
      inputSchema: bindToChannelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => bindToChannelImpl(ctx, args),
  );
};
