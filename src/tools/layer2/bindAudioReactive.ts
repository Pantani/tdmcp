import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const bindAudioReactiveSchema = z.object({
  target: z
    .string()
    .describe("COMP whose numeric custom parameters (knobs) should react to the music."),
  source_chop: z
    .string()
    .describe(
      "CHOP carrying audio feature channels (e.g. an extract_audio_features Null). Expected channels: level, bass, mid, treble.",
    ),
  intensity: z.coerce
    .number()
    .min(0)
    .default(1)
    .describe("Master reactivity amount (0=off, 1=normal, 2=strong) — scales every binding."),
  mappings: z
    .array(
      z.object({
        param: z.string().describe("Custom parameter name on the target COMP, e.g. 'Speed'."),
        channel: z.string().describe("Source channel to drive it, e.g. 'bass'."),
        scale: z.coerce.number().default(1),
        offset: z.coerce.number().default(0),
      }),
    )
    .optional()
    .describe(
      "Explicit param→channel bindings. Omit to auto-map the target COMP's numeric custom parameters by name heuristics.",
    ),
  add_master: z
    .boolean()
    .default(true)
    .describe(
      "Append a 'Reactivity' master float knob (0-2, default = intensity) on the target COMP that scales every binding.",
    ),
});
type BindAudioReactiveArgs = z.infer<typeof bindAudioReactiveSchema>;

interface BoundEntry {
  param: string;
  channel: string;
  scale: number;
  expr: string;
}

interface AudioReactiveReport {
  target: string;
  source_chop: string;
  bound: BoundEntry[];
  source_channels: string[] | null;
  master?: string;
  // UNVERIFIED probe (TD offline): confirms the customPars/style read surface on the first run.
  probe?: { has_customPars: boolean; first_par_style: string | null };
  warnings: string[];
  fatal?: string;
}

// One Python pass that turns the core VJ thesis — "make this network react to the music" — into
// a single call: discover the target COMP's numeric custom parameters, map each to an audio
// feature channel (explicitly or by name heuristic), append an optional master Reactivity knob,
// and switch every mapped parameter to expression mode tracking its channel.
//
// Mechanisms are lifted verbatim from existing tools so they are house-idiomatic, not guesses:
//   - `_t.customPars` / `_par.style` / `getattr(_par, "isNumber", ...)` / `_par.readOnly` —
//     the custom-parameter read surface used by randomize_controls, manage_presets, manage_cue,
//     create_autopilot, generate_readme.
//   - `_page.appendFloat(...)` + normMin/normMax/default/val — the master knob, like
//     add_custom_parameters.
//   - `_par.expr = expr; _par.mode = type(_par.mode).EXPRESSION` — the expression-mode bind from
//     bind_to_channel (ParMode isn't in the exec globals, so the enum is derived from a live par).
//   - repr() around the source/channel/target strings in the expression — exactly how
//     bind_to_channel builds its expression so quoting is safe.
//
// Fail-forward: a missing source CHOP, a channel not present yet, an already-bound parameter, or a
// failed master-knob append are all collected as `warnings` and the work continues. `fatal` is
// reserved for "nothing could be done" — the target is missing or is not a COMP.
const AUDIO_REACTIVE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
  "target": _p["target"],
  "source_chop": _p["source_chop"],
  "bound": [],
  "source_channels": None,
  "warnings": [],
}

# Case-insensitive name heuristics: pick an audio band for a knob by what its name/label suggests.
# Order matters — the first matching group wins; an unmatched knob is skipped (no sensible band).
_HEUR = [
  (["bright", "level", "opacity", "alpha", "intens", "gain"], "level"),
  (["scale", "size", "zoom", "radius", "amount", "width"], "bass"),
  (["hue", "color", "rgb", "shift"], "treble"),
  (["speed", "rate", "freq", "rot", "spin"], "mid"),
]

def _pick_channel(*texts):
    _hay = " ".join([str(t) for t in texts if t]).lower()
    for _keys, _chan in _HEUR:
        for _k in _keys:
            if _k in _hay:
                return _chan
    return None

try:
    _t = op(_p["target"])
    if _t is None:
        report["fatal"] = "Target not found: " + str(_p["target"])
    elif not hasattr(_t, "customPars"):
        report["fatal"] = str(_p["target"]) + " is not a COMP, so it has no custom parameters to bind."
    else:
        # Probe the source channels (warn but keep going if the CHOP isn't there yet — the
        # expression will track once it exists). _chans = None means "unknown", so a binding is
        # never suppressed for a channel we simply could not enumerate.
        _src = op(_p["source_chop"])
        _chans = None
        if _src is None:
            report["warnings"].append("Source CHOP not found: %s; binding anyway (it will track once it exists)." % _p["source_chop"])
        else:
            try:
                _chans = [c.name for c in _src.chans()]
                report["source_channels"] = _chans
            except Exception:
                _chans = None

        # Master Reactivity knob (optional). Appended on a "Reactive" page; skipped (warning) if it
        # already exists. Failure here is non-fatal — the bindings still work without it.
        _master_name = None
        if _p.get("add_master"):
            try:
                _intensity = _p.get("intensity", 1)
                if getattr(_t.par, "Reactivity", None) is not None:
                    _master_name = "Reactivity"
                    report["warnings"].append("Master knob 'Reactivity' already exists on %s — reusing it." % _p["target"])
                else:
                    _page = None
                    for _pg in _t.customPages:
                        if _pg.name == "Reactive":
                            _page = _pg
                            break
                    if _page is None:
                        _page = _t.appendCustomPage("Reactive")
                    _mp = _page.appendFloat("Reactivity", label="Reactivity", replace=False)
                    for _pp in _mp:
                        _pp.normMin = 0
                        _pp.normMax = 2
                        _pp.default = _intensity
                        _pp.val = _intensity
                    _master_name = "Reactivity"
                report["master"] = _master_name
            except Exception:
                report["warnings"].append("Could not append master Reactivity knob: %s" % traceback.format_exc().splitlines()[-1])
                _master_name = None

        # Build the list of (param-name, channel, scale, offset) bindings.
        _binds = []
        _mappings = _p.get("mappings")
        if _mappings:
            for _m in _mappings:
                _binds.append((_m["param"], _m["channel"], _m.get("scale", 1), _m.get("offset", 0)))
        else:
            # AUTO-MAP: walk the target's numeric custom parameters and assign a band by heuristic.
            try:
                _cpars = list(_t.customPars)
            except Exception:
                _cpars = []
                report["warnings"].append("Could not read customPars on %s; nothing to auto-map." % _p["target"])
            _probed = False
            for _par in _cpars:
                # Capture the probe on the first par so the lead can verify the read surface live.
                if not _probed:
                    try:
                        report["probe"] = {"has_customPars": True, "first_par_style": getattr(_par, "style", None)}
                    except Exception:
                        report["probe"] = {"has_customPars": True, "first_par_style": None}
                    _probed = True
                try:
                    _style = getattr(_par, "style", None)
                    if _style not in ("Float", "Int"):
                        continue
                    if not getattr(_par, "isNumber", False) or getattr(_par, "readOnly", False):
                        continue
                    _chan = _pick_channel(getattr(_par, "name", ""), getattr(_par, "label", ""))
                    if _chan is None:
                        continue
                    _binds.append((_par.name, _chan, 1, 0))
                except Exception:
                    report["warnings"].append("Skipped a custom parameter during auto-map: %s" % traceback.format_exc().splitlines()[-1])
            if report.get("probe") is None:
                report["probe"] = {"has_customPars": True, "first_par_style": None}

        # Apply each binding as an expression on the target COMP's custom parameter.
        for _pname, _chan, _scale, _offset in _binds:
            try:
                _par = getattr(_t.par, _pname, None)
                if _par is None:
                    report["warnings"].append("Custom parameter not found on %s: %s" % (_p["target"], _pname))
                    continue
                # A channel known to be absent is still bound (it will track once it exists), but warned.
                if _chans is not None and _chan not in _chans:
                    report["warnings"].append("Channel '%s' not present on %s yet; binding %s anyway." % (_chan, _p["source_chop"], _pname))
                # An already-expression-bound parameter is left alone so we never clobber prior wiring.
                try:
                    _PM = type(_par.mode)
                    if _par.mode == _PM.EXPRESSION:
                        report["warnings"].append("Parameter %s is already bound (expression mode) — skipped." % _pname)
                        continue
                except Exception:
                    _PM = type(_par.mode)
                _src_str = repr(_p["source_chop"]); _chan_str = repr(_chan)
                if _master_name is not None:
                    _tgt_str = repr(_p["target"])
                    _expr = "op(%s)[%s] * %s * op(%s).par.%s + %s" % (
                        _src_str, _chan_str, repr(_scale), _tgt_str, _master_name, repr(_offset))
                else:
                    _eff = _scale * _p.get("intensity", 1)
                    _expr = "op(%s)[%s] * %s + %s" % (_src_str, _chan_str, repr(_eff), repr(_offset))
                _par.expr = _expr
                _par.mode = _PM.EXPRESSION
                report["bound"].append({"param": _pname, "channel": _chan, "scale": _scale, "expr": _expr})
            except Exception:
                report["warnings"].append("Failed to bind %s: %s" % (_pname, traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAudioReactiveScript(payload: object): string {
  return buildPayloadScript(AUDIO_REACTIVE_SCRIPT, payload);
}

export async function bindAudioReactiveImpl(
  ctx: ToolContext,
  args: BindAudioReactiveArgs,
): Promise<CallToolResult> {
  return guardTd(
    async () => {
      const script = buildAudioReactiveScript({
        target: args.target,
        source_chop: args.source_chop,
        intensity: args.intensity,
        add_master: args.add_master,
        // Normalize each mapping's defaulted fields here so the Python pass never sees a missing
        // scale/offset; null (not an empty array) signals "auto-map" to the script.
        mappings: args.mappings
          ? args.mappings.map((m) => ({
              param: m.param,
              channel: m.channel,
              scale: m.scale,
              offset: m.offset,
            }))
          : null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AudioReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not make ${args.target} react to audio: ${report.fatal}`, report);
      }
      const masterNote = report.master ? ` (master '${report.master}')` : "";
      const warnNote = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
      const summary = `Bound ${report.bound.length} knob(s) on ${report.target} to audio${masterNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerBindAudioReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bind_audio_reactive",
    {
      title: "Make a component react to audio",
      description:
        "Make a whole COMP react to the music in one call — the core VJ move. Point `target` at a COMP with numeric custom-parameter knobs and `source_chop` at an audio-feature CHOP (e.g. an extract_audio_features Null carrying level/bass/mid/treble), and each knob is switched to expression mode tracking an audio band. Omit `mappings` to auto-map knobs by name heuristic (bright/level/opacity→level, scale/size/zoom→bass, hue/color→treble, speed/rate/rot→mid; unrecognized knobs are skipped), or pass explicit param→channel bindings with per-binding scale/offset. By default appends a master 'Reactivity' float knob (0–2, default = intensity) that scales every binding so the artist can dial the whole network's reactivity from one control. Fail-forward: a missing source CHOP, an absent channel, or an already-bound parameter are warnings, not failures — only a missing/non-COMP target is fatal. This tool only WIRES an existing COMP to an existing CHOP, building no nodes: produce the feature CHOP with extract_audio_features (or create_spectrum) first, use create_audio_reactive when you want a whole new reactive network with its own visual, and bind_to_channel for finer single-parameter control.",
      inputSchema: bindAudioReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => bindAudioReactiveImpl(ctx, args),
  );
};
