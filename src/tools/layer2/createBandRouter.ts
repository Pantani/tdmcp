import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createBandRouterSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to build the band-router container (a COMP path, e.g. '/project1')."),
  name: z
    .string()
    .default("band_router")
    .describe("Base name for the container COMP that holds the EQ split + router."),
  source_chop: z
    .string()
    .describe(
      "Path of the raw audio CHOP to split (e.g. an Audio Device In or Audio File In, '/project1/audiodevin1'). REQUIRED.",
    ),
  bands: z.coerce
    .number()
    .int()
    .min(2)
    .max(8)
    .default(4)
    .describe(
      "Number of EQ bands to split the signal into (e.g. 4 = sub / low / mid / high). The output Null carries one channel per band, named band0..bandN-1 (band0 = lowest).",
    ),
  targets: z
    .array(
      z.object({
        band: z.coerce
          .number()
          .int()
          .describe("Band index to read from (0 = lowest band, bands-1 = highest)."),
        node_param: z
          .string()
          .describe("Target written as 'nodePath.parName' (e.g. '/project1/glow1.intensity')."),
        scale: z.coerce.number().default(1).describe("Multiply the band level (mapping gain)."),
        offset: z.coerce.number().default(0).describe("Add to the scaled value (mapping offset)."),
      }),
    )
    .default([])
    .describe(
      "Optional band->parameter routes. Each binds one band's smoothed level to a parameter by expression (op('<bands_out>')['band<i>'] * scale + offset). Omit to just build the split (bind later with bind_to_channel against the bands_out Null).",
    ),
  smooth: z.coerce
    .number()
    .min(0)
    .default(0.1)
    .describe(
      "Release/lag time in seconds applied to every band level — smooths the per-band envelope so reactivity follows a clean curve instead of flickering on raw audio (e.g. 0.05 punchy, 0.2 smooth).",
    ),
});
type CreateBandRouterArgs = z.infer<typeof createBandRouterSchema>;

interface BandRouterReport {
  container: string;
  bands_out: string;
  bands: number;
  split_optype: string;
  level_function: string;
  lag_chop: string;
  bound: string[];
  warnings: string[];
  fatal?: string;
}

// Build an EQ band-split + multi-target router inside a container, using the audio idioms
// already proven in extractAudioFeatures (audiofilterCHOP band-pass + analyzeCHOP level):
//
//   source_chop (external, read by absolute path) ->
//   Select CHOP (isolate the source by absolute path — no cross-container wire needed) ->
//   N x audiofilterCHOP, one per band. Each is a band-pass slice of the spectrum spread
//     evenly in log-frequency space across the audible range (band0 = lowest). audiofilter
//     pars used are EXACTLY the ones extractAudioFeatures live-validated: `filter`
//     ("lowpass"/"bandpass"/"highpass"), `units = "frequency"`, and `cutofffrequency` in Hz
//     (computed from evenly-spaced log-frequency edges). The lowest band uses a lowpass, the
//     highest a highpass, the middle bands a bandpass between adjacent cutoffs — so the bands
//     tile the spectrum. Per-band par failures -> warnings.
//   analyzeCHOP per band reducing the filtered audio to a scalar level. IMPORTANT
//     (project memory): the analyze FUNCTION is 'rmspower', NOT plain 'rms'. The function
//     par name ('function') and the 'rmspower' value are UNVERIFIED across TD builds — set
//     in a guarded try; on failure we warn and fall back to abs+Lag (a Math `abs` op
//     followed by the smoothing Lag still yields a usable envelope). If audiofilterCHOP
//     itself cannot be created we fall back to a single audiospectrumCHOP whose bins are
//     grouped into `bands` averaged bands — all of this is warnings, never fatal.
//   Each band's scalar level is renamed to band<i> (its Analyze output channel renamed via
//     renameCHOP — par names 'renamefrom'/'renameto' are UNVERIFIED, guarded) and merged.
//   Merge CHOP gathers the N renamed band levels into one CHOP.
//   Lag CHOP (smooth) — lag2 = `smooth` release in seconds, so each band level decays
//     smoothly. lagunit set to seconds (guarded).
//   Null CHOP "bands_out" — stable output handle carrying band0..bandN-1.
//   For each target, bind the chosen band's channel to the parameter by expression (mirror
//     createEnvelopeFollower's binding block): op('<bands_out>')['band<i>'] (* scale)
//     (+ offset), switching the parameter to EXPRESSION mode (enum derived from a live
//     parameter via type(par.mode), since ParMode is not in the exec globals).
//   Per-op and per-target failures -> report["warnings"] (fail-forward). fatal ONLY when the
//   source CHOP or the parent COMP is missing (nothing could be done).
const BAND_ROUTER_SCRIPT = `
import json, base64, traceback, math
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "bands_out": "",
    "bands": _p["bands"],
    "split_optype": "",
    "level_function": "",
    "lag_chop": "",
    "bound": [],
    "warnings": [],
}
try:
    _src = _p["source_chop"]
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source CHOP not found: " + str(_src)
    else:
        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
        else:
            _bands = int(_p["bands"])
            try:
                _cont = _parent.create(baseCOMP, _p["name"])
            except Exception as _e:
                report["fatal"] = "Could not create container: " + str(_e)
                _cont = None
            if _cont is not None:
                report["container"] = _cont.path

                # --- Select CHOP: isolate source by absolute path ---
                _sel = None
                try:
                    _sel = _cont.create(selectCHOP, "src")
                    _sel.par.chop = _src
                except Exception as _e:
                    report["warnings"].append("Select CHOP failed: " + str(_e))
                    _sel = None

                # Helper: set a level function on an analyzeCHOP (rmspower per project memory),
                # falling back to abs(Math) if the function par/value is unavailable on this build.
                def _level(_node, _name, _src_op):
                    _ana = None
                    try:
                        _ana = _cont.create(analyzeCHOP, _name)
                        if _src_op is not None:
                            _ana.inputConnectors[0].connect(_src_op)
                        try:
                            _ana.par.function = "rmspower"
                            if not report["level_function"]:
                                report["level_function"] = "rmspower"
                        except Exception:
                            try:
                                _apars = [pp.name for pp in _ana.pars()]
                            except Exception:
                                _apars = []
                            report["warnings"].append(
                                "analyzeCHOP function='rmspower' could not be set (pars: %s); using op default level. UNVERIFIED-live."
                                % _apars[:10]
                            )
                            if not report["level_function"]:
                                report["level_function"] = "default"
                        return _ana
                    except Exception as _e:
                        report["warnings"].append("analyzeCHOP '%s' failed: %s" % (_name, str(_e)))
                        # Fallback: Math abs gives a crude rectified envelope (smoothed later by Lag).
                        try:
                            _m = _cont.create(mathCHOP, _name)
                            if _src_op is not None:
                                _m.inputConnectors[0].connect(_src_op)
                            try:
                                _m.par.chanop = "abs"
                            except Exception:
                                pass
                            if not report["level_function"]:
                                report["level_function"] = "abs(fallback)"
                            return _m
                        except Exception as _e2:
                            report["warnings"].append("Level fallback failed for '%s': %s" % (_name, str(_e2)))
                            return None

                # Helper: rename a single-channel CHOP's channel(s) to a stable name (band<i>).
                def _rename(_node, _to):
                    if _node is None:
                        return None
                    try:
                        _r = _cont.create(renameCHOP, _to + "_n")
                        _r.inputConnectors[0].connect(_node)
                        _ok = False
                        try:
                            _r.par.renamefrom = "*"
                            _r.par.renameto = _to
                            _ok = True
                        except Exception:
                            pass
                        if not _ok:
                            report["warnings"].append(
                                "renameCHOP par names not found; '%s' keeps its upstream channel name. UNVERIFIED-live." % _to
                            )
                            return _node
                        return _r
                    except Exception as _e:
                        report["warnings"].append("renameCHOP for '%s' failed: %s" % (_to, str(_e)))
                        return _node

                _band_outs = []
                _split_ok = False

                # --- Primary: N audiofilterCHOP band-pass slices (extractAudioFeatures idiom) ---
                # Spread cutoffs evenly in log-frequency space across ~30 Hz .. ~16 kHz.
                _lo = math.log10(30.0); _hi = math.log10(16000.0)
                try:
                    for _i in range(_bands):
                        _flt = _cont.create(audiofilterCHOP, "band%d" % _i)
                        if _sel is not None:
                            _flt.inputConnectors[0].connect(_sel)
                        # Cutoff edges for this band, evenly spaced in log space, then to Hz.
                        _f0 = 10.0 ** (_lo + (_hi - _lo) * (_i / float(_bands)))
                        _f1 = 10.0 ** (_lo + (_hi - _lo) * ((_i + 1) / float(_bands)))
                        try:
                            _flt.par.units = "frequency"
                            if _i == 0:
                                _flt.par.filter = "lowpass"
                                _flt.par.cutofffrequency = _f1
                            elif _i == _bands - 1:
                                _flt.par.filter = "highpass"
                                _flt.par.cutofffrequency = _f0
                            else:
                                _flt.par.filter = "bandpass"
                                # bandpass: center cutoff between the two edges (geometric mean)
                                _flt.par.cutofffrequency = (_f0 * _f1) ** 0.5
                        except Exception as _e:
                            report["warnings"].append(
                                "audiofilterCHOP par set failed on band%d (%s); band may pass full spectrum." % (_i, str(_e))
                            )
                        _lvl = _level(_flt, "lvl%d" % _i, _flt)
                        _named = _rename(_lvl, "band%d" % _i)
                        if _named is not None:
                            _band_outs.append(_named)
                    if _band_outs:
                        _split_ok = True
                        report["split_optype"] = "audiofilterCHOP"
                except Exception as _e:
                    report["warnings"].append(
                        "audiofilterCHOP band split failed (%s); trying audiospectrumCHOP fallback." % str(_e)
                    )

                # --- Fallback: single audiospectrumCHOP, bins grouped into bands ---
                if not _split_ok:
                    try:
                        _spec = _cont.create(audiospectrumCHOP, "spectrum")
                        if _sel is not None:
                            _spec.inputConnectors[0].connect(_sel)
                        report["split_optype"] = "audiospectrumCHOP"
                        # One analyze over the spectrum, then we still expose per-band via rename of
                        # grouped channels would need a Script CHOP; keep it simple: a single level
                        # CHOP over the whole spectrum named band0 so at least one route works, and
                        # warn that per-band granularity needs audiofilterCHOP on this build.
                        _lvl = _level(_spec, "lvl_spec", _spec)
                        _named = _rename(_lvl, "band0")
                        if _named is not None:
                            _band_outs.append(_named)
                        report["warnings"].append(
                            "audiofilterCHOP unavailable; used audiospectrumCHOP with a single combined level on 'band0'. Per-band granularity is reduced. UNVERIFIED-live."
                        )
                    except Exception as _e:
                        report["warnings"].append("audiospectrumCHOP fallback also failed: " + str(_e))

                # --- Merge band levels into one CHOP ---
                _merged = None
                if len(_band_outs) == 1:
                    _merged = _band_outs[0]
                elif len(_band_outs) > 1:
                    try:
                        _mrg = _cont.create(mergeCHOP, "bands")
                        for _bi, _bo in enumerate(_band_outs):
                            try:
                                _mrg.inputConnectors[_bi].connect(_bo)
                            except Exception:
                                # Some builds expose only one input connector until wired; retry append.
                                _mrg.inputConnectors[len(_mrg.inputs)].connect(_bo)
                        _merged = _mrg
                    except Exception as _e:
                        report["warnings"].append("Merge CHOP failed: " + str(_e))
                        _merged = _band_outs[0] if _band_outs else None

                # --- Lag CHOP: smooth/release per band ---
                _lag = None
                if _merged is not None:
                    try:
                        _lag = _cont.create(lagCHOP, "smooth")
                        _lag.inputConnectors[0].connect(_merged)
                        try:
                            _lag.par.lagunit = "seconds"
                        except Exception:
                            pass
                        try:
                            _lag.par.lag1 = 0
                            _lag.par.lag2 = _p["smooth"]
                        except Exception as _e:
                            report["warnings"].append("Could not set Lag times: " + str(_e))
                        report["lag_chop"] = _lag.path
                    except Exception as _e:
                        report["warnings"].append("Lag CHOP failed: " + str(_e))
                        _lag = None

                # --- Null CHOP: stable output handle ---
                _out_src = _lag if _lag is not None else _merged
                if _out_src is not None:
                    try:
                        _null = _cont.create(nullCHOP, "bands_out")
                        _null.inputConnectors[0].connect(_out_src)
                        report["bands_out"] = _null.path
                    except Exception as _e:
                        report["bands_out"] = _out_src.path
                        report["warnings"].append("Null CHOP failed: " + str(_e))

                # --- Bind targets by expression (mirror createEnvelopeFollower) ---
                _read_path = report["bands_out"] if report["bands_out"] else report["lag_chop"]
                for _t in _p.get("targets", []):
                    _np = _t.get("node_param", "")
                    try:
                        _band = int(_t.get("band", 0))
                        if _band < 0 or _band >= _bands:
                            report["warnings"].append(
                                "Target band %d out of range [0, %d) for '%s'; skipped." % (_band, _bands, _np)
                            )
                            continue
                        if not _read_path:
                            report["warnings"].append(
                                "No band output to bind '%s' to (split chain failed)." % _np
                            )
                            continue
                        _dot = _np.rfind(".")
                        if _dot <= 0:
                            report["warnings"].append(
                                "Invalid target '%s' (expected 'nodePath.parName')." % _np
                            )
                            continue
                        _node = _np[:_dot]; _pn = _np[_dot + 1:]
                        _n = op(_node)
                        if _n is None:
                            report["warnings"].append("Target node not found: " + _node)
                            continue
                        _par = getattr(_n.par, _pn, None)
                        if _par is None:
                            report["warnings"].append("Target parameter not found: " + _np)
                            continue
                        _ch = "band%d" % _band
                        _expr = "op(%s)[%s]" % (repr(_read_path), repr(_ch))
                        _scale = _t.get("scale", 1); _offset = _t.get("offset", 0)
                        if _scale != 1:
                            _expr = "(%s) * %s" % (_expr, repr(_scale))
                        if _offset != 0:
                            _expr = "%s + %s" % (_expr, repr(_offset))
                        _PM = type(_par.mode)
                        _par.expr = _expr
                        _par.mode = _PM.EXPRESSION
                        report["bound"].append(_np)
                    except Exception:
                        report["warnings"].append(
                            "Failed to bind '%s': %s" % (_np, traceback.format_exc().splitlines()[-1])
                        )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildBandRouterScript(payload: object): string {
  return buildPayloadScript(BAND_ROUTER_SCRIPT, payload);
}

export async function createBandRouterImpl(ctx: ToolContext, args: CreateBandRouterArgs) {
  return guardTd(
    async () => {
      const script = buildBandRouterScript({
        parent_path: args.parent_path,
        name: args.name,
        source_chop: args.source_chop,
        bands: args.bands,
        smooth: args.smooth,
        targets: args.targets,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BandRouterReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Band router build failed: ${report.fatal}`, report);
      }
      const boundNote =
        report.bound.length > 0 ? `, routed ${report.bound.length} band(s) to parameters` : "";
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Split ${args.source_chop} into ${report.bands} EQ band(s) (${report.split_optype || "band split"}, ${report.level_function || "level"}, smooth ${args.smooth}s) -> ${report.bands_out}${boundNote}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateBandRouter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_band_router",
    {
      title: "Create band router",
      description:
        "Split an audio signal into EQ bands and route each band to its own target parameter(s) — the musician-friendly 'bass -> this, highs -> that' patch. Builds a container with: a Select CHOP isolating the source audio by absolute path (no cross-container wire), N audiofilterCHOP band-pass slices tiling the spectrum in log-frequency space (the same audioFilter idiom extract_audio_features uses), an Analyze CHOP per band measuring its level via rmspower, a Merge + Lag smoothing the per-band envelope (release in seconds), and a Null 'bands_out' carrying one channel per band named band0..bandN-1 (band0 = lowest). Each target route binds a band's smoothed level to a parameter by expression (op('<bands_out>')['band<i>'] * scale + offset). The bands_out Null is also directly bind_to_channel-able for routes you add later. EXTENSION sibling of extract_audio_features (that one extracts named features; this one is the band-split + multi-target router). NOTE: the analyze 'rmspower' function value and the channel-rename pars are UNVERIFIED across TD builds — they are set in guarded tries with fallbacks (abs envelope / upstream channel names), and a single audiospectrumCHOP is the fallback if audiofilterCHOP is unavailable; per-item failures surface as warnings rather than failing the build.",
      inputSchema: createBandRouterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBandRouterImpl(ctx, args),
  );
};
