import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Device presets — CC/note numbers are BEST-EFFORT and UNVERIFIED.
// Real hardware may use different CC assignments depending on firmware version.
// All maps must be validated with the physical controller before use in
// production. This tool is HARDWARE-GATED: held from release until validated.
// ---------------------------------------------------------------------------

/**
 * Per-device map of control id → CC or note number.
 * Channel numbers are 0-indexed (MIDI channel 0 = CH1 in TD's midiinCHOP).
 * CC type = "cc", note type = "note".
 *
 * ALL ENTRIES ARE UNVERIFIED — best-effort from published MIDI implementation
 * charts and community documentation. Real hardware may differ.
 */
export const DEVICE_PRESETS: Record<
  string,
  Array<{ id: string; type: "cc" | "note"; number: number; channel: number }>
> = {
  // Akai APC Mini Mk1 — UNVERIFIED
  // Faders: CC 48-55 on ch1; pads: note-on on ch1 (rows 0-7, cols 0-7)
  // Sources: community MIDI chart + Akai product page
  apc_mini: [
    { id: "fader1", type: "cc", number: 48, channel: 0 },
    { id: "fader2", type: "cc", number: 49, channel: 0 },
    { id: "fader3", type: "cc", number: 50, channel: 0 },
    { id: "fader4", type: "cc", number: 51, channel: 0 },
    { id: "fader5", type: "cc", number: 52, channel: 0 },
    { id: "fader6", type: "cc", number: 53, channel: 0 },
    { id: "fader7", type: "cc", number: 54, channel: 0 },
    { id: "fader8", type: "cc", number: 55, channel: 0 },
    { id: "master_fader", type: "cc", number: 56, channel: 0 },
    // Pads row 7 (top) — note 56 to 63; row 0 (bottom) — note 0 to 7
    { id: "pad0", type: "note", number: 0, channel: 0 },
    { id: "pad1", type: "note", number: 1, channel: 0 },
    { id: "pad2", type: "note", number: 2, channel: 0 },
    { id: "pad3", type: "note", number: 3, channel: 0 },
    { id: "pad4", type: "note", number: 4, channel: 0 },
    { id: "pad5", type: "note", number: 5, channel: 0 },
    { id: "pad6", type: "note", number: 6, channel: 0 },
    { id: "pad7", type: "note", number: 7, channel: 0 },
  ],

  // Novation Launchpad (Mk2 / X) — UNVERIFIED
  // Pads send note-on on ch1; top row buttons send CC 104-111
  // Sources: Novation Launchpad Mk2 Programmer's Reference
  launchpad: [
    { id: "pad0", type: "note", number: 11, channel: 0 },
    { id: "pad1", type: "note", number: 12, channel: 0 },
    { id: "pad2", type: "note", number: 13, channel: 0 },
    { id: "pad3", type: "note", number: 14, channel: 0 },
    { id: "pad4", type: "note", number: 15, channel: 0 },
    { id: "pad5", type: "note", number: 16, channel: 0 },
    { id: "pad6", type: "note", number: 17, channel: 0 },
    { id: "pad7", type: "note", number: 18, channel: 0 },
    // Top-row scene buttons
    { id: "scene0", type: "cc", number: 104, channel: 0 },
    { id: "scene1", type: "cc", number: 105, channel: 0 },
    { id: "scene2", type: "cc", number: 106, channel: 0 },
    { id: "scene3", type: "cc", number: 107, channel: 0 },
    { id: "scene4", type: "cc", number: 108, channel: 0 },
    { id: "scene5", type: "cc", number: 109, channel: 0 },
    { id: "scene6", type: "cc", number: 110, channel: 0 },
    { id: "scene7", type: "cc", number: 111, channel: 0 },
  ],

  // MIDI Solutions MIDI Mix — UNVERIFIED
  // 8 channel strips: knob1-3 on CC 16-39, fader on CC 0-7, solo/mute/rec buttons
  // Sources: MIDI Mix reference manual community transcription
  midi_mix: [
    { id: "fader1", type: "cc", number: 0, channel: 0 },
    { id: "fader2", type: "cc", number: 1, channel: 0 },
    { id: "fader3", type: "cc", number: 2, channel: 0 },
    { id: "fader4", type: "cc", number: 3, channel: 0 },
    { id: "fader5", type: "cc", number: 4, channel: 0 },
    { id: "fader6", type: "cc", number: 5, channel: 0 },
    { id: "fader7", type: "cc", number: 6, channel: 0 },
    { id: "fader8", type: "cc", number: 7, channel: 0 },
    { id: "master_fader", type: "cc", number: 62, channel: 0 },
    // Knobs (row 1 per channel = send knob A)
    { id: "knob1", type: "cc", number: 16, channel: 0 },
    { id: "knob2", type: "cc", number: 17, channel: 0 },
    { id: "knob3", type: "cc", number: 18, channel: 0 },
    { id: "knob4", type: "cc", number: 19, channel: 0 },
    { id: "knob5", type: "cc", number: 20, channel: 0 },
    { id: "knob6", type: "cc", number: 21, channel: 0 },
    { id: "knob7", type: "cc", number: 22, channel: 0 },
    { id: "knob8", type: "cc", number: 23, channel: 0 },
    // Mute buttons (note-on)
    { id: "mute1", type: "note", number: 1, channel: 0 },
    { id: "mute2", type: "note", number: 4, channel: 0 },
    { id: "mute3", type: "note", number: 7, channel: 0 },
    { id: "mute4", type: "note", number: 10, channel: 0 },
    { id: "mute5", type: "note", number: 13, channel: 0 },
    { id: "mute6", type: "note", number: 16, channel: 0 },
    { id: "mute7", type: "note", number: 19, channel: 0 },
    { id: "mute8", type: "note", number: 22, channel: 0 },
  ],

  // Korg nanoKONTROL2 — UNVERIFIED
  // 8 channel strips: knob=CC10-17, fader=CC0-7, solo=CC32-39,
  // mute=CC48-55, rec=CC64-71, transport buttons=CC41-46
  // Sources: Korg nanoKONTROL2 MIDI Implementation (rev. 1.10)
  nanokontrol: [
    { id: "fader1", type: "cc", number: 0, channel: 0 },
    { id: "fader2", type: "cc", number: 1, channel: 0 },
    { id: "fader3", type: "cc", number: 2, channel: 0 },
    { id: "fader4", type: "cc", number: 3, channel: 0 },
    { id: "fader5", type: "cc", number: 4, channel: 0 },
    { id: "fader6", type: "cc", number: 5, channel: 0 },
    { id: "fader7", type: "cc", number: 6, channel: 0 },
    { id: "fader8", type: "cc", number: 7, channel: 0 },
    { id: "knob1", type: "cc", number: 10, channel: 0 },
    { id: "knob2", type: "cc", number: 11, channel: 0 },
    { id: "knob3", type: "cc", number: 12, channel: 0 },
    { id: "knob4", type: "cc", number: 13, channel: 0 },
    { id: "knob5", type: "cc", number: 14, channel: 0 },
    { id: "knob6", type: "cc", number: 15, channel: 0 },
    { id: "knob7", type: "cc", number: 16, channel: 0 },
    { id: "knob8", type: "cc", number: 17, channel: 0 },
    { id: "solo1", type: "cc", number: 32, channel: 0 },
    { id: "solo2", type: "cc", number: 33, channel: 0 },
    { id: "solo3", type: "cc", number: 34, channel: 0 },
    { id: "solo4", type: "cc", number: 35, channel: 0 },
    { id: "solo5", type: "cc", number: 36, channel: 0 },
    { id: "solo6", type: "cc", number: 37, channel: 0 },
    { id: "solo7", type: "cc", number: 38, channel: 0 },
    { id: "solo8", type: "cc", number: 39, channel: 0 },
    { id: "mute1", type: "cc", number: 48, channel: 0 },
    { id: "mute2", type: "cc", number: 49, channel: 0 },
    { id: "mute3", type: "cc", number: 50, channel: 0 },
    { id: "mute4", type: "cc", number: 51, channel: 0 },
    { id: "mute5", type: "cc", number: 52, channel: 0 },
    { id: "mute6", type: "cc", number: 53, channel: 0 },
    { id: "mute7", type: "cc", number: 54, channel: 0 },
    { id: "mute8", type: "cc", number: 55, channel: 0 },
    // Transport buttons
    { id: "transport_rewind", type: "cc", number: 43, channel: 0 },
    { id: "transport_play", type: "cc", number: 41, channel: 0 },
    { id: "transport_stop", type: "cc", number: 42, channel: 0 },
    { id: "transport_record", type: "cc", number: 45, channel: 0 },
  ],

  // generic: bare MIDI In + empty template table — no preset bindings
  generic: [],
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bindingSchema = z.object({
  control: z
    .string()
    .describe(
      "Control id from the device preset map, e.g. 'fader1', 'knob3', 'pad5'. " +
        "For 'generic' device, use any label you choose.",
    ),
  target_param: z
    .string()
    .optional()
    .describe("'nodePath.parName' to drive (for continuous controls)."),
  cue: z.string().optional().describe("Cue name to recall when this pad is triggered."),
});

export const createMidiMapSchema = z.object({
  parent_path: z.string().default("/project1").describe("COMP to create the MIDI map inside."),
  name: z
    .string()
    .default("midi_map")
    .describe("Name for the MIDI In CHOP node created under parent_path."),
  device: z
    .enum(["apc_mini", "launchpad", "midi_mix", "nanokontrol", "generic"])
    .default("nanokontrol")
    .describe(
      "Controller preset. Each preset embeds a best-effort CC/note map for that device " +
        "(UNVERIFIED — real numbers depend on firmware; validate with hardware). " +
        "'generic' builds a bare MIDI In + a template bind table with no preset.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "COMP whose custom numeric params/cues the preset auto-binds faders/knobs onto. " +
        "Faders bind to the first N float/int custom pars; pads look for matching cues. " +
        "Auto-binding is best-effort and hardware-gated.",
    ),
  bindings: z
    .array(bindingSchema)
    .default([])
    .describe(
      "Explicit control→param/cue overrides. Applied after the preset auto-map. " +
        "Omit to rely entirely on the device preset's default map.",
    ),
});
type CreateMidiMapArgs = z.infer<typeof createMidiMapSchema>;

// ---------------------------------------------------------------------------
// Bridge report
// ---------------------------------------------------------------------------

interface MidiMapReport {
  device: string;
  midi_in: string | null;
  bind_table: string | null;
  bound: Array<{ control: string; cc_or_note: string; target_param?: string; cue?: string }>;
  warnings: string[];
  unverified: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python bridge script — ONE pass
// ---------------------------------------------------------------------------
// Probing notes:
//   - midiinCHOP par names probed from TD docs + community: "norm" for normalize
//     mode (same as in createExternalIo), "active" for enable. NOT validated live.
//   - Channel name format in TD's midiinCHOP: for CC messages the channel is
//     typically "ch<N>_cc<M>" (e.g. "ch1_cc0"). For notes: "ch<N>_note<M>".
//     This is UNVERIFIED — actual names depend on TD version and device.
//   - The bind expression mirrors bindToChannel/learnControl: op(path)[chan].
//   - ParMode enum is derived from a live parameter (type(par.mode).EXPRESSION).
//   - Binding to cues is a placeholder: we set a note-triggered boolean par expression.
//     Real cue-recall needs the cue-sequencer API (out of scope here).
const MIDI_MAP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"device": _p["device"], "midi_in": None, "bind_table": None, "bound": [], "warnings": [], "unverified": [
    "CC/note channel numbers per device are best-effort from published MIDI charts — validate with real hardware.",
    "midiinCHOP parameter names (norm, active) assumed from TD docs — probe if parameters are missing.",
    "TD channel name format assumed as ch<N>_cc<M> / ch<N>_note<M> — may vary by TD version.",
    "Auto-binding faders→custom pars and pads→cues is best-effort and requires live hardware validation.",
]}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        # --- Create the MIDI In CHOP ---
        try:
            _node = _parent.create(midiinCHOP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create midiinCHOP: " + str(_e)
        if not report.get("fatal"):
            report["midi_in"] = _node.path
            # Set normalize mode defensively — par name may differ
            def _setpar(parname, val):
                if val is None:
                    return
                pr = getattr(_node.par, parname, None)
                if pr is None:
                    report["warnings"].append("No parameter '%s' on midiinCHOP (skipped)" % parname)
                    return
                try:
                    pr.val = val
                except Exception:
                    report["warnings"].append("Could not set par '%s'" % parname)
            _setpar("norm", "0to1")
            # --- Create the bind Table DAT ---
            _tbl_name = _p["name"] + "_binds"
            try:
                _tbl = _parent.create(tableDAT, _tbl_name)
                _tbl.clear()
                _tbl.appendRow(["control_id", "type", "cc_or_note", "channel", "target_param", "cue"])
                report["bind_table"] = _tbl.path
            except Exception as _e:
                report["warnings"].append("Could not create bind TableDAT: " + str(_e))
                _tbl = None
            # --- Build the preset map ---
            _preset = _p.get("presets", [])
            _preset_map = {entry["id"]: entry for entry in _preset}
            # Collect the user's explicit bindings (overrides or additions)
            _user_bindings = _p.get("bindings", [])
            _user_map = {b["control"]: b for b in _user_bindings}
            # Merge: start from preset, override with user bindings
            _all_ids = list(dict.fromkeys([e["id"] for e in _preset] + [b["control"] for b in _user_bindings]))
            # Try auto-bind: map faders/knobs to target comp's numeric custom pars
            _auto_par_bindings = {}  # control_id -> "nodePath.parName"
            _auto_cue_bindings = {}  # control_id -> cue_name
            _target_path = _p.get("target")
            if _target_path:
                _target_comp = op(_target_path)
                if _target_comp is None:
                    report["warnings"].append("Auto-bind target not found: " + _target_path)
                else:
                    # Collect numeric custom pars (page name != 'Built-in Parameters')
                    _num_pars = []
                    try:
                        for _pg in _target_comp.customPages:
                            for _par in _pg.pars:
                                if _par.style in ("Float", "Int", "Int32"):
                                    _num_pars.append(_target_path + "." + _par.name)
                    except Exception as _ex:
                        report["warnings"].append("Could not read custom pars of target: " + str(_ex))
                    # Map faders then knobs to params in order
                    _par_idx = 0
                    for _cid in [e["id"] for e in _preset]:
                        if not (_cid.startswith("fader") or _cid.startswith("knob")):
                            continue
                        if _par_idx < len(_num_pars):
                            _auto_par_bindings[_cid] = _num_pars[_par_idx]
                            _par_idx += 1
            # --- Apply all bindings ---
            for _cid in _all_ids:
                _entry = _preset_map.get(_cid)
                _user = _user_map.get(_cid, {})
                _tp = _user.get("target_param") or _auto_par_bindings.get(_cid)
                _cue = _user.get("cue") or _auto_cue_bindings.get(_cid)
                _cc_type = _entry["type"] if _entry else "cc"
                _cc_num = _entry["number"] if _entry else 0
                _ch_num = _entry["channel"] if _entry else 0
                # Channel name TD uses: ch<N+1>_cc<M> or ch<N+1>_note<M> (UNVERIFIED)
                _td_chan = "ch%d_%s%d" % (_ch_num + 1, _cc_type, _cc_num)
                if _tbl is not None:
                    try:
                        _tbl.appendRow([_cid, _cc_type, _cc_num, _ch_num + 1, _tp or "", _cue or ""])
                    except Exception:
                        pass
                _bound_entry = {"control": _cid, "cc_or_note": _td_chan}
                if _tp:
                    _bound_entry["target_param"] = _tp
                    # Set expression on the target param (mirrors bind_to_channel pattern)
                    _dot = _tp.rfind(".")
                    if _dot <= 0:
                        report["warnings"].append("Invalid target_param '%s' (expected nodePath.parName)" % _tp)
                    else:
                        _np = _tp[:_dot]; _pn = _tp[_dot + 1:]
                        _tn = op(_np)
                        if _tn is None:
                            report["warnings"].append("Target node not found: " + _np)
                        else:
                            _par = getattr(_tn.par, _pn, None)
                            if _par is None:
                                report["warnings"].append("Target par not found: " + _tp)
                            else:
                                try:
                                    _expr = "op(%r)[%r] if %r in [c.name for c in op(%r).chans()] else 0" % (_node.path, _td_chan, _td_chan, _node.path)
                                    _PM = type(_par.mode)
                                    _par.expr = _expr; _par.mode = _PM.EXPRESSION
                                except Exception as _ex:
                                    report["warnings"].append("Could not set expression on %s: %s" % (_tp, str(_ex)))
                if _cue:
                    _bound_entry["cue"] = _cue
                    report["warnings"].append(
                        "Cue recall for '%s' → cue '%s' is a placeholder — real cue-recall needs the cue sequencer API (hardware-gated)." % (_cid, _cue)
                    )
                report["bound"].append(_bound_entry)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildMidiMapScript(payload: object): string {
  return buildPayloadScript(MIDI_MAP_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createMidiMapImpl(ctx: ToolContext, args: CreateMidiMapArgs) {
  return guardTd(
    async () => {
      const preset = DEVICE_PRESETS[args.device] ?? [];
      const script = buildMidiMapScript({
        parent: args.parent_path,
        name: args.name,
        device: args.device,
        presets: preset,
        target: args.target ?? null,
        bindings: args.bindings,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<MidiMapReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(
          `create_midi_map failed for device '${args.device}': ${report.fatal}`,
          report,
        );
      }
      const n = report.bound.length;
      const warnNote = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built ${args.device} MIDI map (${n} binding(s)) — hardware-UNVERIFIED${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateMidiMap: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_midi_map",
    {
      title: "Create MIDI controller map",
      description:
        "HARDWARE-GATED SCAFFOLD. Build a MIDI controller preset for a supported device " +
        "(apc_mini / launchpad / midi_mix / nanokontrol / generic): creates a midiinCHOP + " +
        "a labeled bind Table DAT, and optionally auto-binds faders/knobs to a target COMP's " +
        "numeric custom parameters. Explicit bindings can override or supplement the preset. " +
        "CC/note numbers are best-effort from published MIDI charts and MUST be validated with " +
        "real hardware — actual assignments depend on device firmware. This tool is HELD FROM " +
        "RELEASE until hardware validation is complete. For one-at-a-time MIDI learn of a " +
        "single control, use learn_control instead.",
      inputSchema: createMidiMapSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMidiMapImpl(ctx, args),
  );
};
