import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
// SURFACE_BUTTON_CB is the recall-button dispatcher manage_cue/create_control_surface use.
// Reuse decision A (approved): the integrator adds `export` to it in createControlSurface.ts;
// look-bank mirrors each slot into the COMP's tdmcp_cues so this exact callback drives recall.
import { SURFACE_BUTTON_CB } from "./createControlSurface.js";
import { MORPH_HOOK } from "./manageCue.js";

export const createLookBankSchema = z.object({
  action: z
    .enum(["build", "store", "recall", "set_ab", "list", "delete"])
    .default("build")
    .describe(
      "build: create the look-bank container (Table DAT + A↔B morph knob + recall button row) on a control COMP. store: snapshot the COMP's current numeric look into a named slot. recall: jump or crossfade to a slot. set_ab: assign which two slots the A↔B knob blends, and optionally set the knob. list / delete slots.",
    ),
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "Control COMP whose custom-parameter values the looks capture (a control-panel container, e.g. from create_control_panel). The look-bank widgets are built inside it; recall drives this COMP's params.",
    ),
  name: z
    .string()
    .default("look_bank")
    .describe("Name of the look-bank panel container built inside comp_path."),
  slot: z.string().optional().describe("Slot name (required for store / recall / delete)."),
  morph_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "(recall) 0 = snap instantly; >0 = crossfade to the slot over this many seconds (eased), via the cue morph engine.",
    ),
  quantize: z
    .enum(["off", "beat", "bar"])
    .default("off")
    .describe(
      "(recall) Defer the snap/crossfade to the next musical boundary (project tempo), so look changes land on the downbeat. Mirrors manage_cue.",
    ),
  slot_a: z.string().optional().describe("(set_ab) Slot the A↔B knob reads at value 0."),
  slot_b: z.string().optional().describe("(set_ab) Slot the A↔B knob reads at value 1."),
  ab: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "(set_ab) Optionally set the A↔B knob position now (0 = slot A, 1 = slot B, 0.5 = halfway). Omit to just (re)assign the slots.",
    ),
  include: z
    .array(z.string())
    .optional()
    .describe(
      "(store) Restrict the snapshot to these custom-parameter names. Omit to capture every numeric/toggle/menu parameter (pulses and strings are always skipped).",
    ),
});
type CreateLookBankArgs = z.infer<typeof createLookBankSchema>;

interface LookBankReport {
  action: string;
  comp: string;
  bank?: string;
  table?: string;
  slot?: string;
  slots?: string[];
  captured?: string[];
  skipped?: string[];
  restored?: string[];
  morph_seconds?: number;
  quantize?: "beat" | "bar";
  scheduled_in?: number;
  slot_a?: string;
  slot_b?: string;
  ab?: number;
  buttons?: string[];
  deleted?: string;
  warnings: string[];
  fatal?: string;
}

// Execute DAT body watching the look-bank's `Ab` custom Float par. On any change it reads the
// stored slot_a/slot_b from <name> storage, pulls both columns from the `looks` table, and for
// each numeric param sets comp.par.<k> = a + (b-a)*ab (rounding when style=='Int'). This is a LIVE
// scrub (immediate, no transition record) — distinct from the timed morph a recall uses. Toggles/
// menus are not blended (they have no meaningful midpoint); only par.isNumber values move.
export const AB_BLEND_CB = `import td

def _lookbank_blend():
    bank = me.parent()
    comp = bank.parent()
    st = bank.fetch('tdmcp_lookbank_ab', {})
    sa = st.get('slot_a'); sb = st.get('slot_b')
    if not sa or not sb:
        return
    tbl = bank.op('looks')
    if tbl is None or tbl.numRows < 1:
        return
    header = [tbl[0, c].val for c in range(tbl.numCols)]
    if sa not in header or sb not in header:
        return
    ca = header.index(sa); cb = header.index(sb)
    abpar = getattr(bank.par, 'Ab', None)
    ab = float(abpar.eval()) if abpar is not None else 0.0
    for r in range(1, tbl.numRows):
        k = tbl[r, 0].val
        par = getattr(comp.par, k, None)
        if par is None or par.readOnly or not getattr(par, 'isNumber', False):
            continue
        try:
            a = float(tbl[r, ca].val); b = float(tbl[r, cb].val)
        except Exception:
            continue
        val = a + (b - a) * ab
        try:
            par.val = int(round(val)) if getattr(par, 'style', '') == 'Int' else val
        except Exception:
            pass
    return

def onValueChange(par, prev):
    if par.name == 'Ab':
        _lookbank_blend()
    return

def onPulse(par):
    return
`;

// One Python pass per action. The `looks` Table DAT (param-rows x slot-columns) inside <name> is
// the source of truth; slots are also mirrored into comp_path's tdmcp_cues so they interoperate
// with manage_cue / create_control_surface and so the shared SURFACE_BUTTON_CB recall dispatcher
// (button_cb) can fire them. A recall writes the same tdmcp_cue_transition record MORPH_HOOK
// (morph_text) consumes; quantize defers the start to the next beat/bar boundary.
const LOOKBANK_SCRIPT = `
import ast, json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "comp": _p["comp"], "warnings": []}
_c = op(_p["comp"])

def _next_boundary_delay(quant):
    # Seconds from now (absTime) to the next beat/bar boundary, from the project tempo + signature.
    # Returns 0.0 for 'off' or on any failure, degrading to an immediate change.
    if quant not in ("beat", "bar"):
        return 0.0
    try:
        _t = op('/').time
        _tempo = float(getattr(_t, 'tempo', 0.0) or 0.0)
        if _tempo <= 0.0:
            return 0.0
        _spb = 60.0 / _tempo
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
        _phase = _beat % _period
        _remaining = _period - _phase
        if _remaining <= 1e-6:
            _remaining = _period
        return _remaining * _spb
    except Exception:
        return 0.0

def _table(bank):
    return bank.op('looks') or bank.create(td.tableDAT, 'looks')

def _header(tbl):
    if tbl.numRows < 1:
        tbl.appendRow(['param'])
    return [tbl[0, c].val for c in range(tbl.numCols)]

def _slots(tbl):
    return _header(tbl)[1:] if tbl.numRows >= 1 else []

def _col_dict(tbl, slot):
    # Read a slot column into {param: typed value}. Values are stored as repr() so bools/ints/
    # floats round-trip; fall back to a float, then the raw string.
    hdr = _header(tbl)
    if slot not in hdr:
        return {}
    ci = hdr.index(slot)
    out = {}
    for r in range(1, tbl.numRows):
        k = tbl[r, 0].val
        raw = tbl[r, ci].val
        if raw == '':
            continue
        v = raw
        try:
            # literal_eval safely round-trips the repr() values written by store
            # (numbers, strings, bool, None, tuples/lists) and REJECTS code, so a
            # hand-edited look slot cannot execute arbitrary expressions in TD.
            v = ast.literal_eval(raw)
        except Exception:
            try:
                v = float(raw)
            except Exception:
                v = raw
        out[k] = v
    return out

def _ensure_morph(comp, text):
    h = comp.op('cue_morph') or comp.create(td.executeDAT, 'cue_morph')
    h.text = text
    if hasattr(h.par, 'framestart'):
        h.par.framestart = True
    h.par.active = True
    return h

def _btn_name(s):
    # Button COMP names must be valid TD identifiers; slot labels are arbitrary and
    # may contain spaces/slashes/punctuation that would break create() or make
    # bank.op() resolve as a path (e.g. 'recall_intro/drop'). Map to [A-Za-z0-9_];
    # the displayed label and the cue key keep the raw slot string.
    _safe = ''.join(_ch if (_ch.isalnum() or _ch == '_') else '_' for _ch in str(s))
    return 'recall_' + (_safe.strip('_') or 'slot')

def _rebuild_buttons(bank, comp, btn_cb):
    # One momentary buttonCOMP per slot + one Panel Execute DAT dispatching them via the shared
    # tdmcp_surface_cues map (same shape create_control_surface uses), so SURFACE_BUTTON_CB fires
    # the mirrored cue. morph_seconds per button defaults to 0 (snap) on (re)build.
    tbl = _table(bank)
    slots = _slots(tbl)
    cmap = {}
    paths = []
    for s in slots:
        _nm = _btn_name(s)
        bt = bank.op(_nm) or bank.create(td.buttonCOMP, _nm)
        try:
            bt.par.w = 110; bt.par.h = 60
            bt.par.label = s
            if hasattr(bt.par, 'buttontype'):
                bt.par.buttontype = 'momentary'
        except Exception:
            pass
        cmap[bt.path] = {"comp": comp.path, "cue": s, "dur": 0}
        paths.append(bt.path)
    if paths:
        bank.store('tdmcp_surface_cues', cmap)
        pe = bank.op('recall_exec') or bank.create(td.panelexecuteDAT, 'recall_exec')
        pe.text = btn_cb
        try:
            pe.par.panels = " ".join(paths)
            if hasattr(pe.par, 'offtoon'):
                pe.par.offtoon = True
            pe.par.active = True
        except Exception:
            pass
    return paths

try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it has no custom parameters to snapshot."
    else:
        _action = _p["action"]
        _bank = _c.op(_p["name"]) or _c.create(td.containerCOMP, _p["name"])
        report["bank"] = _bank.path
        _tbl = _table(_bank)
        report["table"] = _tbl.path
        _ensure_morph(_c, _p["morph_text"])
        # Ensure the Ab knob + its watcher exist on every action so the panel is always live.
        if getattr(_bank.par, "Ab", None) is None:
            _pg = None
            for _g in _bank.customPages:
                if _g.name == "LookBank":
                    _pg = _g; break
            if _pg is None:
                _pg = _bank.appendCustomPage("LookBank")
            _abp = _pg.appendFloat("Ab")[0]
            _abp.normMin = 0; _abp.normMax = 1; _abp.default = 0; _abp.val = 0
        _abx = _bank.op("ab_exec") or _bank.create(td.parameterexecuteDAT, "ab_exec")
        _abx.text = _p["ab_cb"]
        try:
            _abx.par.op = _bank.path
            if hasattr(_abx.par, "valuechange"):
                _abx.par.valuechange = True
            if hasattr(_abx.par, "pars"):
                _abx.par.pars = "Ab"
            _abx.par.active = True
        except Exception:
            report["warnings"].append("Could not fully wire the A/B watcher.")

        if _action == "build":
            report["buttons"] = _rebuild_buttons(_bank, _c, _p["button_cb"])
            report["slots"] = _slots(_tbl)
        elif _action == "list":
            report["slots"] = _slots(_tbl)
        elif _action == "store":
            _slot = _p.get("slot")
            _include = _p.get("include")
            _captured = []; _skipped = []
            _vals = {}
            for _pr in _c.customPars:
                _name = _pr.name
                if _include and _name not in _include:
                    continue
                _keep = ((_pr.isNumber or _pr.isToggle or _pr.isMenu)
                         and not _pr.readOnly
                         and not (_pr.isPulse or _pr.isMomentary)
                         and not _pr.isString)
                if not _keep:
                    _skipped.append(_name); continue
                try:
                    _vals[_name] = _pr.eval()
                    _captured.append(_name)
                except Exception:
                    _skipped.append(_name)
            # Write the slot column into the looks table (append the column if new).
            _hdr = _header(_tbl)
            if _slot not in _hdr:
                _tbl.appendCol([_slot])
                _hdr = _header(_tbl)
            _ci = _hdr.index(_slot)
            # Ensure a row exists for each captured param, then write repr() into the slot cell.
            _rows = {_tbl[_r, 0].val: _r for _r in range(1, _tbl.numRows)}
            for _k, _v in _vals.items():
                if _k not in _rows:
                    _newrow = [''] * _tbl.numCols
                    _newrow[0] = _k
                    _tbl.appendRow(_newrow)
                    _rows[_k] = _tbl.numRows - 1
                _tbl[_rows[_k], _ci] = repr(_v)
            # Mirror into comp_path's tdmcp_cues so the slot is interoperable + recall-able.
            _cues = dict(_c.fetch("tdmcp_cues", {}))
            _cues[_slot] = _vals
            _c.store("tdmcp_cues", _cues)
            report["slot"] = _slot
            report["captured"] = sorted(_captured)
            report["skipped"] = sorted(_skipped)
            report["slots"] = _slots(_tbl)
            report["buttons"] = _rebuild_buttons(_bank, _c, _p["button_cb"])
        elif _action == "recall":
            _slot = _p.get("slot")
            _to = _col_dict(_tbl, _slot)
            if not _to and _slot not in _slots(_tbl):
                report["fatal"] = "Slot not found: '%s' (available: %s)" % (_slot, ", ".join(_slots(_tbl)) or "none")
            else:
                _quant = _p.get("quantize") or "off"
                _delay = _next_boundary_delay(_quant)
                _dur = float(_p.get("morph_seconds") or 0)
                if _dur <= 0 and _delay <= 0.0:
                    _restored = []
                    for _k, _v in _to.items():
                        _pr = getattr(_c.par, _k, None)
                        if _pr is None or _pr.readOnly:
                            report["warnings"].append("skipped " + _k); continue
                        try:
                            _pr.val = _v; _restored.append(_k)
                        except Exception:
                            report["warnings"].append("could not set " + _k)
                    report["restored"] = sorted(_restored)
                else:
                    _from = {}
                    for _k in _to.keys():
                        _pr = getattr(_c.par, _k, None)
                        if _pr is not None:
                            try:
                                _from[_k] = _pr.eval()
                            except Exception:
                                pass
                    _tdur = _dur if _dur > 0 else 0.0001
                    _start = td.absTime.seconds + _delay
                    _c.store("tdmcp_cue_transition", {"active": True, "from": _from, "to": _to, "start": _start, "duration": _tdur})
                    _ensure_morph(_c, _p["morph_text"])
                    report["restored"] = sorted(_from.keys())
                    if _dur > 0:
                        report["morph_seconds"] = _dur
                    if _delay > 0.0:
                        report["quantize"] = _quant; report["scheduled_in"] = round(_delay, 4)
                report["slot"] = _slot
        elif _action == "set_ab":
            _sa = _p.get("slot_a"); _sb = _p.get("slot_b")
            _st = dict(_bank.fetch("tdmcp_lookbank_ab", {}))
            _st["slot_a"] = _sa; _st["slot_b"] = _sb
            _ab = _p.get("ab")
            if _ab is not None:
                _st["ab"] = float(_ab)
            _bank.store("tdmcp_lookbank_ab", _st)
            report["slot_a"] = _sa; report["slot_b"] = _sb
            if _ab is not None:
                _abp = getattr(_bank.par, "Ab", None)
                if _abp is not None and not _abp.readOnly:
                    try:
                        _abp.val = float(_ab)
                    except Exception:
                        pass
                report["ab"] = float(_ab)
                # Run the blend once so the knob preview is live immediately.
                _hdr = _header(_tbl)
                if _sa in _hdr and _sb in _hdr:
                    _da = _col_dict(_tbl, _sa); _dbb = _col_dict(_tbl, _sb)
                    for _k, _av in _da.items():
                        _pr = getattr(_c.par, _k, None)
                        if _pr is None or _pr.readOnly or not getattr(_pr, "isNumber", False):
                            continue
                        _bv = _dbb.get(_k, _av)
                        try:
                            _val = float(_av) + (float(_bv) - float(_av)) * float(_ab)
                            _pr.val = int(round(_val)) if getattr(_pr, "style", "") == "Int" else _val
                        except Exception:
                            pass
            report["slots"] = _slots(_tbl)
        elif _action == "delete":
            _slot = _p.get("slot")
            _hdr = _header(_tbl)
            if _slot in _hdr:
                _tbl.deleteCol(_hdr.index(_slot))
                _bt = _bank.op(_btn_name(_slot))
                if _bt is not None:
                    _bt.destroy()
                _cues = dict(_c.fetch("tdmcp_cues", {}))
                if _slot in _cues:
                    _cues.pop(_slot, None); _c.store("tdmcp_cues", _cues)
                report["deleted"] = _slot
                report["buttons"] = _rebuild_buttons(_bank, _c, _p["button_cb"])
            else:
                report["warnings"].append("Slot not found: " + str(_slot))
            report["slots"] = _slots(_tbl)
        else:
            report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildLookBankScript(payload: object): string {
  return buildPayloadScript(LOOKBANK_SCRIPT, payload);
}

export async function createLookBankImpl(ctx: ToolContext, args: CreateLookBankArgs) {
  // Name guards (mirror manageCueImpl): actions that act on a single slot need a slot.
  if (
    (args.action === "store" || args.action === "recall" || args.action === "delete") &&
    !args.slot
  ) {
    return errorResult(`A slot name is required for the '${args.action}' action.`);
  }
  if (args.action === "set_ab" && (!args.slot_a || !args.slot_b)) {
    return errorResult("set_ab needs both slot_a and slot_b (the two looks the A↔B knob blends).");
  }

  return guardTd(
    async () => {
      const script = buildLookBankScript({
        action: args.action,
        comp: args.comp_path,
        name: args.name,
        slot: args.slot,
        morph_seconds: args.morph_seconds,
        quantize: args.quantize,
        slot_a: args.slot_a,
        slot_b: args.slot_b,
        ab: args.ab,
        include: args.include,
        morph_text: MORPH_HOOK,
        ab_cb: AB_BLEND_CB,
        // SURFACE_BUTTON_CB is exported by the integrator (reuse decision A). Coalesce to "" so
        // this file is runtime-safe before that one-line export lands; an empty dispatcher simply
        // means no recall buttons fire until the export is applied (build still succeeds).
        button_cb: SURFACE_BUTTON_CB ?? "",
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<LookBankReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Look bank ${report.action} failed: ${report.fatal}`, report);
      }
      let summary: string;
      switch (report.action) {
        case "build":
          summary = `Built look bank ${report.bank} on ${report.comp} (${report.slots?.length ?? 0} slot(s), A↔B morph knob ready).`;
          break;
        case "store": {
          const cap = report.captured?.length ?? 0;
          const skip = report.skipped?.length ?? 0;
          summary = `Stored look "${report.slot}" (${cap} control(s) captured${
            skip ? `, ${skip} skipped` : ""
          }) on ${report.comp}.`;
          break;
        }
        case "recall": {
          const n = report.restored?.length ?? 0;
          if (report.quantize) {
            summary = `Look "${report.slot}" (${n} control(s)) ${
              report.morph_seconds ? `crossfades over ${report.morph_seconds}s` : "snaps"
            } on the next ${report.quantize} (~${report.scheduled_in}s) on ${report.comp}.`;
          } else if (report.morph_seconds) {
            summary = `Crossfading to look "${report.slot}" over ${report.morph_seconds}s (${n} control(s)) on ${report.comp}.`;
          } else {
            summary = `Recalled look "${report.slot}" (${n} control(s)) — jumped on ${report.comp}.`;
          }
          break;
        }
        case "set_ab":
          summary =
            report.ab === undefined
              ? `A↔B knob (re)assigned: A="${report.slot_a}" → B="${report.slot_b}" on ${report.comp} (knob not moved).`
              : `A↔B knob set to ${report.ab} blending A="${report.slot_a}" → B="${report.slot_b}" on ${report.comp}.`;
          break;
        case "delete":
          summary = report.deleted
            ? `Deleted look "${report.deleted}" on ${report.comp}.`
            : `No look to delete on ${report.comp}.`;
          break;
        default:
          summary = `${report.slots?.length ?? 0} look(s) on ${report.comp}: ${report.slots?.join(", ") || "no slots"}.`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateLookBank: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_look_bank",
    {
      title: "Create look bank",
      description:
        "A playable snapshot row: store N named 'looks' (snapshots of a control COMP's numeric/toggle/menu parameters) in a visible, editable Table DAT, with one momentary recall button per slot (snap or crossfade) plus a master A↔B morph knob that blends continuously between two chosen looks. Reuses manage_cue's morph engine (so a recall behaves exactly like a cue morph, with optional beat/bar quantize) and mirrors slots into the COMP's cues so they interoperate with manage_cue / create_control_surface. Pulses and strings are always skipped at capture. Build cues/params with create_control_panel first.",
      inputSchema: createLookBankSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLookBankImpl(ctx, args),
  );
};
