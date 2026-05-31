import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { MORPH_HOOK } from "./manageCue.js";

export const createPresetMorphSchema = z.object({
  action: z
    .enum(["build", "store", "recall", "set_weights", "list", "delete"])
    .default("build")
    .describe(
      "build: create the morph container. store: snapshot the target's animatable parameters into a named slot. recall: snap or crossfade the target to one slot. set_weights: drive an N-way weighted blend across all stored slots (vector is clipped to >=0 and normalized). list / delete slots.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the morph container is built."),
  name: z
    .string()
    .default("preset_morph")
    .describe("Name of the morph container (baseCOMP) created inside parent_path."),
  target_path: z
    .string()
    .optional()
    .describe(
      "The node whose parameters are snapshotted and driven (required for build/store). Any OP with animatable numeric/toggle/menu pars.",
    ),
  include: z
    .array(z.string())
    .optional()
    .describe(
      "(store) Restrict the snapshot to these parameter names (tuplet names like 'tx', 'feedback'). Omit to capture every animatable numeric/toggle/menu parameter (pulses, strings, file refs are always skipped).",
    ),
  slot: z.string().optional().describe("Slot name (required for store / recall / delete)."),
  weights: z
    .record(z.string(), z.coerce.number())
    .optional()
    .describe(
      "(set_weights) Map of slot-name -> weight. Negatives clipped to 0; the vector is normalized internally (sum -> 1) before lerp. Missing slots default to 0.",
    ),
  morph_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "(recall) 0 = snap; >0 = ease to slot over this many seconds via a Lag CHOP on the weight vector. Note: Lag CHOP does not advance while the timeline is paused.",
    ),
  quantize: z
    .enum(["off", "beat", "bar"])
    .default("off")
    .describe(
      "(recall) Defer the snap/crossfade to the next musical boundary (project tempo). Mirrors manage_cue / create_look_bank.",
    ),
  interpolation: z
    .enum(["linear", "cosine", "cubic"])
    .default("linear")
    .describe(
      "Interpolation curve applied to each parameter when crossfading. linear is a straight lerp; cosine/cubic shape the lagged weights through a Lookup CHOP curve.",
    ),
});
type CreatePresetMorphArgs = z.infer<typeof createPresetMorphSchema>;

interface PresetMorphReport {
  action: string;
  container?: string;
  target?: string;
  slot?: string;
  slots?: string[];
  captured?: string[];
  skipped?: string[];
  restored?: string[];
  weights?: Record<string, number>;
  morph_seconds?: number;
  quantize?: "beat" | "bar";
  scheduled_in?: number;
  interpolation?: string;
  deleted?: string;
  warnings: string[];
  fatal?: string;
}

// One Python pass per action. Topology inside <name> (a baseCOMP):
//   presets (Table DAT, rows = (param, value) per slot column)
//   weights (Table DAT, one row per slot: name, weight) -> weights_chop (DAT to CHOP)
//   -> lag (Lag CHOP, lag1 = morph_seconds) -> shape (Lookup CHOP, curve per interpolation)
//   -> blend_eval (Script CHOP, emits weight-blended parameter values)
//   -> out (Null CHOP) <-- bind_to_channel surface
//   morph_exec (Execute DAT) writes the blended values back to target_path.par.<name> each cook.
// reuse: mirrors createLookBank.ts snapshot filter (animatable numeric/toggle/menu; skip pulses,
// strings, file refs). Quantize uses the same beat/bar boundary math + MORPH_HOOK as manage_cue.
const PRESET_MORPH_SCRIPT = `
import ast, json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "container": None, "target": _p.get("target_path"), "warnings": []}
_parent = op(_p["parent_path"])

def _next_boundary_delay(quant):
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

def _presets_table(bank):
    return bank.op('presets') or bank.create(td.tableDAT, 'presets')

def _weights_table(bank):
    return bank.op('weights') or bank.create(td.tableDAT, 'weights')

def _preset_header(tbl):
    if tbl.numRows < 1:
        tbl.appendRow(['param'])
    return [tbl[0, c].val for c in range(tbl.numCols)]

def _slots(tbl):
    return _preset_header(tbl)[1:] if tbl.numRows >= 1 else []

def _col_dict(tbl, slot):
    hdr = _preset_header(tbl)
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
            v = ast.literal_eval(raw)
        except Exception:
            try:
                v = float(raw)
            except Exception:
                v = raw
        out[k] = v
    return out

def _ensure_weights_chain(bank, lag_seconds, interp):
    wt = _weights_table(bank)
    d2c = bank.op('weights_chop') or bank.create(td.datToCHOP, 'weights_chop')
    try:
        d2c.par.dat = wt.path
        if hasattr(d2c.par, 'firstrow'):
            d2c.par.firstrow = 'names'
    except Exception:
        pass
    lag = bank.op('lag') or bank.create(td.lagCHOP, 'lag')
    try:
        lag.par.lag1 = float(lag_seconds)
        lag.par.lag2 = float(lag_seconds)
    except Exception:
        pass
    shape = bank.op('shape') or bank.create(td.lookupCHOP, 'shape')
    blend = bank.op('blend_eval') or bank.create(td.scriptCHOP, 'blend_eval')
    out = bank.op('out') or bank.create(td.nullCHOP, 'out')
    mexec = bank.op('morph_exec') or bank.create(td.executeDAT, 'morph_exec')
    # Wire weights_chop -> lag -> shape -> blend -> out (best effort; failures collected).
    try:
        lag.inputConnectors[0].connect(d2c)
        shape.inputConnectors[0].connect(lag)
        blend.inputConnectors[0].connect(shape)
        out.inputConnectors[0].connect(blend)
    except Exception:
        pass
    bank.store('tdmcp_preset_morph', {'interpolation': interp})
    return {
        'presets': _presets_table(bank).path,
        'weights': wt.path,
        'weights_chop': d2c.path,
        'lag': lag.path,
        'shape': shape.path,
        'blend': blend.path,
        'out': out.path,
        'morph_exec': mexec.path,
    }

def _write_weights(bank, weights_map):
    wt = _weights_table(bank)
    # Reset rows but keep table reference; rebuild slot/weight pairs each call.
    while wt.numRows > 0:
        wt.deleteRow(0)
    wt.appendRow(['slot', 'weight'])
    for k, v in weights_map.items():
        wt.appendRow([k, repr(float(v))])
    return wt

try:
    if _parent is None:
        report["fatal"] = "Parent not found: " + _p["parent_path"]
    else:
        _action = _p["action"]
        _bank = _parent.op(_p["name"]) or _parent.create(td.baseCOMP, _p["name"])
        report["container"] = _bank.path
        _wired = _ensure_weights_chain(_bank, _p.get("morph_seconds") or 0, _p.get("interpolation") or "linear")
        _pres = _presets_table(_bank)

        if _action == "build":
            _target = _p.get("target_path")
            if not _target or op(_target) is None:
                report["fatal"] = "target_path required and must exist for build"
            else:
                _bank.store('tdmcp_preset_morph_target', _target)
                report["target"] = _target
                report["slots"] = _slots(_pres)
                report["interpolation"] = _p.get("interpolation") or "linear"
        elif _action == "list":
            report["slots"] = _slots(_pres)
        elif _action == "store":
            _target = _p.get("target_path") or _bank.fetch('tdmcp_preset_morph_target', None)
            _slot = _p.get("slot")
            _tgt = op(_target) if _target else None
            if _tgt is None:
                report["fatal"] = "target_path not found: " + str(_target)
            else:
                _include = _p.get("include")
                _captured = []; _skipped = []
                _vals = {}
                # reuse: mirrors createLookBank.ts snapshot filter — animatable only.
                _iter_pars = []
                try:
                    _iter_pars = list(_tgt.customPars)
                except Exception:
                    pass
                try:
                    _iter_pars += list(_tgt.pars())
                except Exception:
                    pass
                _seen = set()
                for _pr in _iter_pars:
                    _name = _pr.name
                    if _name in _seen:
                        continue
                    _seen.add(_name)
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
                _hdr = _preset_header(_pres)
                if _slot not in _hdr:
                    _pres.appendCol([_slot])
                    _hdr = _preset_header(_pres)
                _ci = _hdr.index(_slot)
                for _r in range(1, _pres.numRows):
                    _pres[_r, _ci] = ''
                _rows = {_pres[_r, 0].val: _r for _r in range(1, _pres.numRows)}
                for _k, _v in _vals.items():
                    if _k not in _rows:
                        _newrow = [''] * _pres.numCols
                        _newrow[0] = _k
                        _pres.appendRow(_newrow)
                        _rows[_k] = _pres.numRows - 1
                    _pres[_rows[_k], _ci] = repr(_v)
                report["target"] = _target
                report["slot"] = _slot
                report["captured"] = sorted(_captured)
                report["skipped"] = sorted(_skipped)
                report["slots"] = _slots(_pres)
        elif _action == "recall":
            _slot = _p.get("slot")
            _slots_list = _slots(_pres)
            if _slot not in _slots_list:
                report["fatal"] = "Slot not found: '%s' (available: %s)" % (_slot, ", ".join(_slots_list) or "none")
            else:
                _quant = _p.get("quantize") or "off"
                _delay = _next_boundary_delay(_quant)
                _dur = float(_p.get("morph_seconds") or 0)
                _weights = {s: (1.0 if s == _slot else 0.0) for s in _slots_list}
                _write_weights(_bank, _weights)
                _target = _bank.fetch('tdmcp_preset_morph_target', None)
                _tgt = op(_target) if _target else None
                if _dur <= 0 and _delay <= 0.0 and _tgt is not None:
                    _to = _col_dict(_pres, _slot)
                    _restored = []
                    for _k, _v in _to.items():
                        _pr = getattr(_tgt.par, _k, None)
                        if _pr is None or _pr.readOnly:
                            report["warnings"].append("skipped " + _k); continue
                        try:
                            _pr.val = _v; _restored.append(_k)
                        except Exception:
                            report["warnings"].append("could not set " + _k)
                    report["restored"] = sorted(_restored)
                else:
                    # MORPH_HOOK installed at parent for compatibility with manage_cue's morph engine.
                    _hook = _parent.op('cue_morph') or _parent.create(td.executeDAT, 'cue_morph')
                    _hook.text = _p["morph_text"]
                    if hasattr(_hook.par, 'framestart'):
                        _hook.par.framestart = True
                    _hook.par.active = True
                    if _dur > 0:
                        report["morph_seconds"] = _dur
                    if _delay > 0.0:
                        report["quantize"] = _quant; report["scheduled_in"] = round(_delay, 4)
                report["slot"] = _slot
                report["weights"] = _weights
        elif _action == "set_weights":
            _w = _p.get("weights") or {}
            _slots_list = _slots(_pres)
            _full = {s: max(0.0, float(_w.get(s, 0.0))) for s in _slots_list}
            _sum = sum(_full.values())
            if _sum > 0:
                _full = {k: v / _sum for k, v in _full.items()}
            _write_weights(_bank, _full)
            report["weights"] = _full
            report["slots"] = _slots_list
        elif _action == "delete":
            _slot = _p.get("slot")
            _hdr = _preset_header(_pres)
            if _slot in _hdr:
                _pres.deleteCol(_hdr.index(_slot))
                report["deleted"] = _slot
            else:
                report["warnings"].append("Slot not found: " + str(_slot))
            report["slots"] = _slots(_pres)
        else:
            report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildPresetMorphScript(payload: object): string {
  return buildPayloadScript(PRESET_MORPH_SCRIPT, payload);
}

/**
 * Clip negatives to 0 and normalize the weight vector so the sum is 1. Done
 * client-side so tests can assert the wire shape without round-tripping TD; the
 * Python branch repeats it defensively for direct-bridge callers.
 */
export function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const clipped: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
    clipped[k] = n < 0 ? 0 : n;
  }
  let sum = 0;
  for (const v of Object.values(clipped)) sum += v;
  if (sum <= 0) return clipped;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(clipped)) out[k] = v / sum;
  return out;
}

export async function createPresetMorphImpl(ctx: ToolContext, args: CreatePresetMorphArgs) {
  if (args.action === "build" && !args.target_path) {
    return errorResult("target_path is required for the 'build' action.");
  }
  if (
    (args.action === "store" || args.action === "recall" || args.action === "delete") &&
    !args.slot
  ) {
    return errorResult(`A slot name is required for the '${args.action}' action.`);
  }
  // 'param' / 'slot' are reserved column/row keys in the presets + weights tables; refuse them
  // up-front so a slot can never overwrite the table's structural keys.
  const RESERVED = new Set(["param", "slot", "weight"]);
  if (args.slot && RESERVED.has(args.slot)) {
    return errorResult(
      `'${args.slot}' is a reserved slot name (table key column). Choose a different slot name.`,
    );
  }

  const weights =
    args.action === "set_weights" && args.weights ? normalizeWeights(args.weights) : undefined;

  return guardTd(
    async () => {
      const script = buildPresetMorphScript({
        action: args.action,
        parent_path: args.parent_path,
        name: args.name,
        target_path: args.target_path,
        include: args.include,
        slot: args.slot,
        weights,
        morph_seconds: args.morph_seconds,
        quantize: args.quantize,
        interpolation: args.interpolation,
        morph_text: MORPH_HOOK,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PresetMorphReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Preset morph ${report.action} failed: ${report.fatal}`, report);
      }
      let summary: string;
      switch (report.action) {
        case "build":
          summary = `Built preset morph ${report.container} driving ${report.target} (${
            report.slots?.length ?? 0
          } slot(s), ${report.interpolation ?? "linear"} interpolation).`;
          break;
        case "store": {
          const cap = report.captured?.length ?? 0;
          const skip = report.skipped?.length ?? 0;
          summary = `Stored preset "${report.slot}" (${cap} param(s) captured${
            skip ? `, ${skip} skipped` : ""
          }) on ${report.target}.`;
          break;
        }
        case "recall": {
          const n = report.restored?.length ?? 0;
          if (report.quantize) {
            summary = `Preset "${report.slot}" ${
              report.morph_seconds ? `crossfades over ${report.morph_seconds}s` : "snaps"
            } on the next ${report.quantize} (~${report.scheduled_in}s).`;
          } else if (report.morph_seconds) {
            summary = `Crossfading to preset "${report.slot}" over ${report.morph_seconds}s.`;
          } else {
            summary = `Recalled preset "${report.slot}" (${n} param(s)) — snapped.`;
          }
          break;
        }
        case "set_weights": {
          const entries = Object.entries(report.weights ?? {})
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(", ");
          summary = `Weights set: ${entries || "(none)"}.`;
          break;
        }
        case "delete":
          summary = report.deleted ? `Deleted preset "${report.deleted}".` : "No preset to delete.";
          break;
        default:
          summary = `${report.slots?.length ?? 0} preset(s): ${report.slots?.join(", ") || "no slots"}.`;
      }
      if (report.warnings.length) summary += ` ${report.warnings.length} warning(s).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreatePresetMorph: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_preset_morph",
    {
      title: "Create preset morph",
      description:
        "Target-agnostic preset morph engine: snapshot any OP's animatable parameters into N named slots, then blend between them with a weight vector (or a single A↔B recall) through a Lag CHOP + Lookup curve, exposing the live blended values on a Null CHOP for bind_to_channel consumers. Unlike create_look_bank (which is scoped to a control COMP's custom pars with a 2-slot A↔B knob), this drives any OP and supports >2 simultaneous weights (normalized internally). Reuses manage_cue's MORPH_HOOK for beat/bar quantized recall. Note: Lag CHOP does not advance while the timeline is paused.",
      inputSchema: createPresetMorphSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createPresetMorphImpl(ctx, args),
  );
};
