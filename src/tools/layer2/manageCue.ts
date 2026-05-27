import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const manageCueSchema = z.object({
  action: z
    .enum(["store", "recall", "morph", "list", "delete"])
    .describe(
      "store a cue (snapshot of the COMP's custom params), recall it instantly, morph to it over time, list, or delete.",
    ),
  comp_path: z
    .string()
    .default("/project1")
    .describe("COMP whose custom-parameter values the cue captures (a control-panel container)."),
  name: z.string().optional().describe("Cue name (required for store/recall/morph/delete)."),
  duration: z.coerce
    .number()
    .positive()
    .default(2)
    .describe("(morph) Crossfade time in seconds from the current look to the cue."),
  quantize: z
    .enum(["off", "beat", "bar"])
    .optional()
    .describe(
      "(recall/morph) Snap the scene change to the music. 'off' (the default) fires immediately. 'beat' defers the recall/morph until the next beat boundary; 'bar' until the next bar (measure) boundary — read from the project tempo (op('/').time.tempo) and time signature. The change is scheduled, not blocking.",
    ),
});
type ManageCueArgs = z.infer<typeof manageCueSchema>;

interface CueReport {
  action: string;
  comp: string;
  name?: string;
  cues?: string[];
  captured?: string[];
  restored?: string[];
  morphing?: string[];
  duration?: number;
  deleted?: string;
  quantize?: "beat" | "bar";
  scheduled_in?: number;
  warnings: string[];
  fatal?: string;
}

// Execute DAT body (runs in TD's normal op context). Each frame, if a transition is active
// it eases the COMP's custom params from the stored `from` values to the cue's `to` values
// (smoothstep), then deactivates itself when done. Numeric params are interpolated; any
// non-numeric ones snap at the end.
export const MORPH_HOOK = `import td

def onFrameStart(frame):
    comp = me.parent()
    st = comp.fetch('tdmcp_cue_transition', None)
    if not st or not st.get('active'):
        return
    now = td.absTime.seconds
    start = st.get('start', now)
    # Beat-quantized recalls/morphs schedule a future start (the next beat/bar in absTime
    # seconds). Until that boundary arrives, leave the look completely untouched so the
    # scene change snaps to the music instead of easing early. Records written by an
    # immediate (quantize 'off') recall/morph always have start <= now, so this never
    # fires for them — current behavior is unchanged.
    if now < start:
        return
    dur = st.get('duration') or 0.0001
    t = (now - start) / dur
    if t < 0:
        t = 0.0
    done = t >= 1.0
    if done:
        t = 1.0
    e = t * t * (3.0 - 2.0 * t)
    frm = st.get('from', {})
    to = st.get('to', {})
    for k, vt in to.items():
        try:
            par = getattr(comp.par, k, None)
            if par is None or par.readOnly:
                continue
            vf = frm.get(k, vt)
            if isinstance(vt, (int, float)) and isinstance(vf, (int, float)) and not isinstance(vt, bool):
                val = vf + (vt - vf) * e
                par.val = int(round(val)) if getattr(par, 'style', '') == 'Int' else val
            elif done:
                par.val = vt
        except Exception:
            pass
    if done:
        st['active'] = False
        comp.store('tdmcp_cue_transition', st)
    return

def onFrameEnd(frame):
    return
`;

// One Python pass for store/recall/morph/list/delete. Cues live in the COMP's storage under
// 'tdmcp_cues'. A morph writes a transition record to 'tdmcp_cue_transition' and ensures a
// 'cue_morph' Execute DAT (its text passed in via the payload) is running to animate it.
const CUE_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
KEY = "tdmcp_cues"
report = {"action": _p["action"], "comp": _p["comp"], "warnings": []}
_c = op(_p["comp"])

def _next_boundary_delay(quant):
    # Seconds from now (in absTime) until the next beat/bar boundary, read from the project
    # timeline's tempo + signature. Returns 0.0 for 'off' or on any failure, so a quantize
    # that can't read the clock degrades to an immediate (current-behavior) change.
    if quant not in ("beat", "bar"):
        return 0.0
    try:
        _t = op('/').time
        _tempo = float(getattr(_t, 'tempo', 0.0) or 0.0)
        if _tempo <= 0.0:
            return 0.0
        _spb = 60.0 / _tempo  # seconds per beat
        # Current musical position in beats. Prefer the timeline's own beat counter; fall
        # back to deriving it from elapsed timeline seconds when .beat isn't exposed.
        _beat = getattr(_t, 'beat', None)
        if _beat is None:
            _secs = float(getattr(_t, 'seconds', 0.0) or 0.0)
            _beat = _secs / _spb
        _beat = float(_beat)
        if quant == "beat":
            _period = 1.0
        else:
            _bpb = int(round(float(getattr(_t, 'signature1', 4) or 4)))
            if _bpb < 1:
                _bpb = 4
            _period = float(_bpb)
        _phase = _beat % _period  # beats already elapsed into the current beat/bar
        _remaining = _period - _phase
        # On an exact boundary, snap to the *next* one rather than firing instantly.
        if _remaining <= 1e-6:
            _remaining = _period
        return _remaining * _spb
    except Exception:
        return 0.0
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it has no custom parameters to snapshot."
    else:
        _store = dict(_c.fetch(KEY, {}))
        _action = _p["action"]; _name = _p.get("name")
        if _action == "list":
            report["cues"] = sorted(_store.keys())
        elif _action == "store":
            _vals = {}
            for _pr in _c.customPars:
                try:
                    _vals[_pr.name] = _pr.eval()
                except Exception:
                    pass
            _store[_name] = _vals; _c.store(KEY, _store)
            report["name"] = _name; report["captured"] = sorted(_vals.keys()); report["cues"] = sorted(_store.keys())
        elif _action == "delete":
            if _name in _store:
                _store.pop(_name, None); _c.store(KEY, _store); report["deleted"] = _name
            else:
                report["warnings"].append("Cue not found: " + str(_name))
            report["cues"] = sorted(_store.keys())
        elif _action in ("recall", "morph"):
            if _name not in _store:
                report["fatal"] = "Cue not found: '%s' (available: %s)" % (_name, ", ".join(sorted(_store.keys())) or "none")
            else:
                _to = _store[_name]
                _quant = _p.get("quantize") or "off"
                _delay = _next_boundary_delay(_quant)
                if _action == "recall" and _delay <= 0.0:
                    # Immediate recall (quantize 'off', or no readable tempo): snap params now.
                    _restored = []
                    for _k, _v in _to.items():
                        _pr = getattr(_c.par, _k, None)
                        if _pr is None or _pr.readOnly:
                            report["warnings"].append("skipped " + _k); continue
                        try:
                            _pr.val = _v; _restored.append(_k)
                        except Exception:
                            report["warnings"].append("could not set " + _k)
                    report["name"] = _name; report["restored"] = sorted(_restored)
                else:
                    # Morph, OR a beat/bar-quantized recall. Both ride the frame-driven
                    # transition engine: a quantized recall is just a snap (tiny duration)
                    # scheduled at the next boundary; a morph eases over its duration. A
                    # future start time keeps the look untouched until the boundary arrives.
                    _from = {}
                    for _k in _to.keys():
                        _pr = getattr(_c.par, _k, None)
                        if _pr is not None:
                            try:
                                _from[_k] = _pr.eval()
                            except Exception:
                                pass
                    _dur = (_p.get("duration") or 0.0001) if _action == "morph" else 0.0001
                    _start = td.absTime.seconds + _delay
                    _c.store("tdmcp_cue_transition", {"active": True, "from": _from, "to": _to, "start": _start, "duration": _dur})
                    _hook = _c.op("cue_morph") or _c.create(td.executeDAT, "cue_morph")
                    _hook.text = _p["morph_text"]
                    if hasattr(_hook.par, "framestart"):
                        _hook.par.framestart = True
                    _hook.par.active = True
                    report["name"] = _name
                    if _action == "morph":
                        report["morphing"] = sorted(_from.keys()); report["duration"] = _dur
                    else:
                        report["restored"] = sorted(_from.keys())
                    if _delay > 0.0:
                        report["quantize"] = _quant; report["scheduled_in"] = round(_delay, 4)
        else:
            report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCueScript(payload: object): string {
  return buildPayloadScript(CUE_SCRIPT, payload);
}

export async function manageCueImpl(ctx: ToolContext, args: ManageCueArgs) {
  if (args.action !== "list" && !args.name) {
    return errorResult(`A cue name is required for the '${args.action}' action.`);
  }
  return guardTd(
    async () => {
      const script = buildCueScript({
        action: args.action,
        comp: args.comp_path,
        name: args.name,
        duration: args.duration,
        quantize: args.quantize ?? "off",
        morph_text: MORPH_HOOK,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CueReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Cue ${report.action} failed: ${report.fatal}`, report);
      }
      let summary: string;
      switch (report.action) {
        case "store":
          summary = `Stored cue "${report.name}" (${report.captured?.length ?? 0} control(s)) on ${report.comp}.`;
          break;
        case "recall":
          summary = report.quantize
            ? `Cue "${report.name}" (${report.restored?.length ?? 0} control(s)) will snap on ${report.comp} at the next ${report.quantize} (~${report.scheduled_in}s).`
            : `Recalled cue "${report.name}" (${report.restored?.length ?? 0} control(s)) on ${report.comp}.`;
          break;
        case "morph":
          summary = report.quantize
            ? `Morph to cue "${report.name}" over ${report.duration}s (${report.morphing?.length ?? 0} control(s)) on ${report.comp} starts at the next ${report.quantize} (~${report.scheduled_in}s).`
            : `Morphing to cue "${report.name}" over ${report.duration}s (${report.morphing?.length ?? 0} control(s)) on ${report.comp}.`;
          break;
        case "delete":
          summary = report.deleted
            ? `Deleted cue "${report.deleted}" on ${report.comp}.`
            : `No cue to delete on ${report.comp}.`;
          break;
        default:
          summary = `${report.cues?.length ?? 0} cue(s) on ${report.comp}: ${report.cues?.join(", ") || "none"}.`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerManageCue: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_cue",
    {
      title: "Manage cue",
      description:
        "Live-performance scene system: store / recall / morph / list / delete named cues (snapshots of a COMP's custom-parameter values). Unlike manage_presets, a cue can be reached with a timed `morph` that crossfades every numeric control from the current look to the cue over N seconds (eased), via a small Execute DAT — so you can glide between looks on stage instead of hard-cutting. Recall and morph also take an optional `quantize` ('beat'/'bar') that defers the change to the next musical boundary (from the project tempo) so scene changes land on the downbeat. Build cues with create_control_panel, then jump or morph between them.",
      inputSchema: manageCueSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => manageCueImpl(ctx, args),
  );
};
