import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { MORPH_HOOK } from "./manageCue.js";

const stepSchema = z.object({
  cue: z.string().min(1).describe("Name of a cue (stored on the target with manage_cue) to fire."),
  bars: z.coerce
    .number()
    .int()
    .positive()
    .default(4)
    .describe("How many quantize units (bars or beats) this step holds before advancing."),
});

export const createCueSequencerSchema = z.object({
  target: z
    .string()
    .default("/project1")
    .describe(
      "COMP whose stored cues (tdmcp_cues, from manage_cue) the sequencer recalls/morphs. Store the cues first.",
    ),
  steps: z
    .array(stepSchema)
    .min(1)
    .describe(
      "The ordered timeline: each step names a cue and how many bars/beats it holds before the next.",
    ),
  loop: z
    .boolean()
    .default(true)
    .describe("When the last step finishes, wrap back to the first (true) or stop (false)."),
  quantize: z
    .enum(["bar", "beat"])
    .default("bar")
    .describe(
      "Unit each step's count is measured in: 'bar' (× the project's beats-per-bar) or raw 'beat'.",
    ),
  morph_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "0 = snap to each cue instantly on its boundary; >0 = crossfade to it over this many seconds (via the same cue_morph engine manage_cue uses).",
    ),
  name: z.string().default("cue_seq").describe("Name of the engine container built inside target."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to create the sequencer engine COMP."),
});
type CreateCueSequencerArgs = z.infer<typeof createCueSequencerSchema>;

interface CueSequencerReport {
  comp: string;
  beat?: string;
  engine?: string;
  steps: Array<{ cue: string; bars: number }>;
  controls: string[];
  warnings: string[];
  fatal?: string;
}

// CHOP Execute callback deployed as the engine DAT's text (runs in TD's normal op context).
// It fires once per beat on the Beat CHOP's cumulative `count` channel and uses that count as a
// musical clock: a step boundary passes whenever floor(count / step_len_beats) increments, where
// step_len_beats = BarsPerStep × (beats-per-bar for 'bar' quantize, 1 for 'beat'). On a boundary
// (while Active) it advances the stored step index (wrapping if loop), writes the new index to the
// live Step control, and recalls (or, for __MORPH__>0, morphs over that many seconds) that step's
// cue on the target — reusing manage_cue's tdmcp_cues storage + tdmcp_cue_transition + cue_morph
// engine. State (the index + the last boundary block + the ordered steps) lives in the engine
// COMP's storage so the callback is self-contained. __TARGET__/__QUANT__/__LOOP__/__MORPH__ are
// substituted on build.
const SEQ_ENGINE = `import td

def _beats_per_bar():
    try:
        bpb = int(round(float(getattr(op('/').time, 'signature1', 4) or 4)))
        return bpb if bpb >= 1 else 4
    except Exception:
        return 4

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'count':
        return
    seq = me.parent()
    act = getattr(seq.par, 'Active', None)
    if act is not None and not act.eval():
        return
    steps = seq.fetch('tdmcp_seq_steps', [])
    if not steps:
        return
    bps_par = getattr(seq.par, 'Barsperstep', None)
    fallback = int(bps_par.eval()) if bps_par is not None else 4
    if fallback < 1:
        fallback = 1
    unit = _beats_per_bar() if '__QUANT__' == 'bar' else 1
    # Use the current step's own length as the boundary period (fall back to the live knob).
    idx = int(seq.fetch('tdmcp_seq_index', 0))
    if idx < 0 or idx >= len(steps):
        idx = 0
    # Honour a live Step change first: a performer/dashboard move to the Step control is a
    # cue-jump. Sync the internal index from seq.par.Step before advancing so the manual jump
    # wins (instead of being overwritten by the stored index on the next beat). When Step was
    # moved we land ON that step this boundary (jumped = True) rather than the usual idx+1.
    jumped = False
    sp = getattr(seq.par, 'Step', None)
    if sp is not None:
        try:
            stepval = int(sp.eval())
        except Exception:
            stepval = idx
        if 0 <= stepval < len(steps) and stepval != idx:
            idx = stepval
            jumped = True
    cur_bars = int(steps[idx].get('bars', fallback) or fallback)
    if cur_bars < 1:
        cur_bars = 1
    step_len = cur_bars * unit
    if step_len < 1:
        step_len = 1
    block = int(float(val) // step_len)
    last = int(seq.fetch('tdmcp_seq_block', -1))
    if block <= last and not jumped:
        return
    seq.store('tdmcp_seq_block', block)
    # A boundary passed (or a manual Step jump): advance — unless we just jumped, in which case
    # we recall the jumped-to step itself. Wrap or stop per loop on a normal advance.
    if jumped:
        nxt = idx
    else:
        nxt = idx + 1
        if nxt >= len(steps):
            if '__LOOP__' == 'loop':
                nxt = 0
            else:
                return
    seq.store('tdmcp_seq_index', nxt)
    # Write the live Step control back so it always reflects the current step (and so the
    # next beat's sync check sees index == Step rather than re-triggering a jump).
    if sp is not None and not sp.readOnly:
        try:
            sp.val = nxt
        except Exception:
            pass
    target = op('__TARGET__')
    if target is None:
        return
    to = target.fetch('tdmcp_cues', {}).get(steps[nxt].get('cue'))
    if not to:
        return
    dur = float('__MORPH__')
    if dur > 0:
        frm = {}
        for k in to:
            par = getattr(target.par, k, None)
            if par is not None:
                try:
                    frm[k] = par.eval()
                except Exception:
                    pass
        target.store('tdmcp_cue_transition', {'active': True, 'from': frm, 'to': to, 'start': td.absTime.seconds, 'duration': dur})
        h = target.op('cue_morph')
        if h is not None:
            h.par.active = True
    else:
        for k, v in to.items():
            par = getattr(target.par, k, None)
            if par is not None and not par.readOnly:
                try:
                    par.val = v
                except Exception:
                    pass
    return
`;

// One Python pass: build (or reuse) the engine COMP inside parent, drop a Beat CHOP on the global
// tempo + a CHOP Execute DAT watching its cumulative `count` channel, deploy the substituted
// engine callback, expose the Active/Step/Barsperstep custom params, store the ordered step list,
// and — when a morph time is set — make sure the target's cue_morph hook (manage_cue's engine) is
// running. Reports the created paths + control names back over stdout.
const CUE_SEQ_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["parent"], "steps": _p["steps"], "controls": [], "warnings": []}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP, so it cannot hold the sequencer engine."
    else:
        _seq = _parent.op(_p["name"]) or _parent.create(td.containerCOMP, _p["name"])
        try:
            _seq.store("tdmcp_role", "cue_sequencer")
        except Exception:
            pass
        report["comp"] = _seq.path
        _beat = _seq.op("beat") or _seq.create(td.beatCHOP, "beat")
        for _pn, _v in (("count", 1), ("beat", 1)):
            try:
                setattr(_beat.par, _pn, _v)
            except Exception:
                pass
        report["beat"] = _beat.path
        _eng = _seq.op("engine") or _seq.create(td.chopexecuteDAT, "engine")
        try:
            _eng.par.chop = _beat.path
            _eng.par.channel = "count"
            _eng.par.valuechange = True
            if hasattr(_eng.par, "offtoon"):
                _eng.par.offtoon = False
            _eng.par.active = True
        except Exception:
            report["warnings"].append("Could not fully wire the CHOP Execute engine.")
        _eng.text = _p["engine_text"]
        report["engine"] = _eng.path
        # Live controls: Active (pause), Step (current index, settable), Barsperstep (fallback hold).
        _page = None
        for _pg in _seq.customPages:
            if _pg.name == "Sequencer":
                _page = _pg; break
        if _page is None:
            _page = _seq.appendCustomPage("Sequencer")
        _nsteps = len(_p["steps"])
        _first_bars = int(_p["steps"][0].get("bars", 4)) if _nsteps else 4
        if getattr(_seq.par, "Active", None) is None:
            _ap = _page.appendToggle("Active")[0]
            _ap.default = True; _ap.val = True
        report["controls"].append("Active")
        if getattr(_seq.par, "Step", None) is None:
            _sp = _page.appendInt("Step")[0]
            _sp.normMin = 0; _sp.normMax = max(0, _nsteps - 1)
            _sp.default = 0; _sp.val = 0
        report["controls"].append("Step")
        if getattr(_seq.par, "Barsperstep", None) is None:
            _bp = _page.appendInt("Barsperstep")[0]
            _bp.normMin = 1; _bp.normMax = 32
            _bp.default = _first_bars; _bp.val = _first_bars
        report["controls"].append("Barsperstep")
        # Reset the runtime state so the first boundary fires step 0 -> 1 cleanly.
        _seq.store("tdmcp_seq_steps", _p["steps"])
        _seq.store("tdmcp_seq_index", 0)
        _seq.store("tdmcp_seq_block", -1)
        # A morph rides manage_cue's frame-driven engine on the TARGET — make sure it exists.
        if float(_p["morph_seconds"]) > 0:
            _tgt = op(_p["target"])
            if _tgt is None:
                report["warnings"].append("Target not found for morph hook: " + _p["target"])
            elif not hasattr(_tgt, "create"):
                report["warnings"].append("Target is not a COMP: " + _p["target"])
            else:
                _hook = _tgt.op("cue_morph") or _tgt.create(td.executeDAT, "cue_morph")
                _hook.text = _p["morph_hook"]
                if hasattr(_hook.par, "framestart"):
                    _hook.par.framestart = True
                _hook.par.active = True
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCueSequencerScript(payload: object): string {
  return buildPayloadScript(CUE_SEQ_SCRIPT, payload);
}

export async function createCueSequencerImpl(ctx: ToolContext, args: CreateCueSequencerArgs) {
  return guardTd(
    async () => {
      const engineText = SEQ_ENGINE.replaceAll("__TARGET__", args.target)
        .replaceAll("__QUANT__", args.quantize)
        .replaceAll("__LOOP__", args.loop ? "loop" : "stop")
        .replaceAll("__MORPH__", String(args.morph_seconds));
      const script = buildCueSequencerScript({
        target: args.target,
        name: args.name,
        parent: args.parent_path,
        steps: args.steps,
        loop: args.loop,
        quantize: args.quantize,
        morph_seconds: args.morph_seconds,
        engine_text: engineText,
        morph_hook: MORPH_HOOK,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CueSequencerReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build cue sequencer: ${report.fatal}`, report);
      }
      const unit = args.quantize === "bar" ? "bar" : "beat";
      const summary = `Built cue sequencer ${report.comp}: ${report.steps.length} step(s) advancing every ${unit} on ${args.target}${
        args.morph_seconds > 0 ? ` (morph ${args.morph_seconds}s)` : ""
      }. Toggle Active to pause; set Step to jump.${
        report.warnings.length ? ` ${report.warnings.length} warning(s).` : ""
      }`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateCueSequencer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_cue_sequencer",
    {
      title: "Create cue sequencer",
      description:
        "Build a bar-quantized cue timeline: a Beat CHOP (on the global tempo) + a CHOP Execute DAT that, on each bar (or beat) boundary, advances through an ordered list of steps and recalls — or morphs over morph_seconds — that step's cue on a target COMP. The deterministic, musically-timed counterpart to create_autopilot (which is random/cyclic). Reuses manage_cue's stored cues and the same cue_morph engine, so store the target's cues with manage_cue first. Live Active / Step / BarsPerStep controls let you pause, jump, or retune on stage.",
      inputSchema: createCueSequencerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createCueSequencerImpl(ctx, args),
  );
};
