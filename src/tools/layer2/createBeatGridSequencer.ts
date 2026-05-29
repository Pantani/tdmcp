import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createBeatGridSequencerSchema = z.object({
  name: z.string().default("beat_grid").describe("Name for the sequencer COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path to create the sequencer inside."),
  target: z
    .string()
    .describe("COMP whose parameter or cue each active step fires on a beat boundary."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16)
    .describe("Number of steps in the grid (e.g. 16 = one bar of 16th notes at 4/4)."),
  action: z
    .enum(["param", "cue"])
    .default("param")
    .describe(
      "param: set a target custom-parameter value per active step; cue: recall a named cue per active step (cues stored with manage_cue).",
    ),
  param: z
    .string()
    .optional()
    .describe(
      "(action=param) The custom-parameter name on the target COMP to set on each active step.",
    ),
  pattern: z
    .array(z.number())
    .default([])
    .describe(
      "Per-step values (action=param) or 1/0 active flags (action=cue); length should match 'steps'. Omit to auto-generate an example pattern.",
    ),
  bpm_source: z
    .string()
    .optional()
    .describe(
      "Path to an existing Beat CHOP or tempo source. Omit to create a new Beat CHOP (on the global TD tempo).",
    ),
});
type CreateBeatGridSequencerArgs = z.infer<typeof createBeatGridSequencerSchema>;

interface BeatGridReport {
  comp: string;
  beat: string;
  table: string;
  dispatch: string;
  controls: string[];
  steps: number;
  action: string;
  warnings: string[];
  fatal?: string;
}

// CHOP Execute callback deployed as the dispatch DAT's text.
// It fires on every beat/count channel change and uses `count % steps` to advance the
// step pointer. At each step boundary it reads the pattern value from the Table DAT,
// then dispatches: action=param → set op(target).par.<param> to the step value;
// action=cue → recall the cue named by the step value on the target (reusing
// manage_cue's tdmcp_cues storage). Active toggle gates the whole dispatch.
//
// UNVERIFIED (TD OFFLINE): Beat CHOP channel names (count/beat), the exact
// `onValueChange` beat-callback timing, and per-step dispatch when the TD timeline
// is paused (reads 0 — paused-timeline gotcha; check `time.play` if steps don't fire).
// The Table DAT lookup and container wiring are constructed; live timing is UNVERIFIED
// until validated inside a running TouchDesigner session.
const DISPATCH_CALLBACK = `import traceback

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'count':
        return
    seq = me.parent()
    act_par = getattr(seq.par, 'Active', None)
    if act_par is not None and not act_par.eval():
        return
    tbl = seq.op('step_table')
    if tbl is None:
        return
    n_steps = tbl.numCols
    if n_steps < 1:
        return
    step_idx = int(val) % n_steps
    try:
        cell_val = tbl[0, step_idx]
        raw = cell_val.val if hasattr(cell_val, 'val') else str(cell_val)
    except Exception:
        return
    tgt = op('__TARGET__')
    if tgt is None:
        return
    action = '__ACTION__'
    if action == 'param':
        par_name = '__PARAM__'
        if not par_name:
            return
        p = getattr(tgt.par, par_name, None)
        if p is None:
            return
        try:
            p.val = float(raw)
        except Exception:
            try:
                p.val = raw
            except Exception:
                pass
    elif action == 'cue':
        try:
            active_flag = int(float(raw))
        except Exception:
            active_flag = 0
        if not active_flag:
            return
        cues = tgt.fetch('tdmcp_cues', {})
        if not cues:
            return
        cue_names = list(cues.keys())
        cue_name = cue_names[step_idx % len(cue_names)] if cue_names else None
        if cue_name is None:
            return
        cue_vals = cues.get(cue_name, {})
        for k, v in cue_vals.items():
            par = getattr(tgt.par, k, None)
            if par is not None and not par.readOnly:
                try:
                    par.val = v
                except Exception:
                    pass
    return
`;

// One Python pass: build (or reuse) the sequencer COMP inside parent, create or
// reuse the Beat CHOP (uses bpm_source if given, otherwise a fresh beatCHOP on the
// global tempo), create a Table DAT pre-filled with the step pattern, deploy the
// substituted dispatch callback as a CHOP Execute DAT watching the beat/count channel,
// and expose Active (toggle) + Steps (informative int) controls via a custom page.
const BEAT_GRID_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["parent"], "beat": "", "table": "", "dispatch": "", "controls": [], "steps": _p["steps"], "action": _p["action"], "warnings": []}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP, so it cannot hold the beat-grid sequencer."
    else:
        _seq = _parent.op(_p["name"]) or _parent.create(td.containerCOMP, _p["name"])
        try:
            _seq.store("tdmcp_role", "beat_grid_sequencer")
        except Exception:
            pass
        report["comp"] = _seq.path

        # Beat CHOP: reuse bpm_source if given, otherwise create a fresh one.
        _bpm_src = _p.get("bpm_source")
        if _bpm_src:
            _beat = op(_bpm_src)
            if _beat is None:
                report["warnings"].append("bpm_source not found: " + str(_bpm_src) + "; creating a new Beat CHOP instead.")
                _bpm_src = None
        if not _bpm_src:
            _beat = _seq.op("beat") or _seq.create(td.beatCHOP, "beat")
            for _pn, _v in (("count", 1), ("beat", 1)):
                try:
                    setattr(_beat.par, _pn, _v)
                except Exception:
                    pass
        report["beat"] = _beat.path

        # Table DAT: pre-fill with the pattern (or default example).
        _tbl = _seq.op("step_table") or _seq.create(td.tableDAT, "step_table")
        _n = _p["steps"]
        _pattern = _p["pattern"]
        # Build the default example if the pattern is absent or wrong length.
        if not _pattern or len(_pattern) != _n:
            if _p["action"] == "param":
                _pattern = [1.0 if i % 4 == 0 else 0.0 for i in range(_n)]
            else:
                _pattern = [1 if i % 4 == 0 else 0 for i in range(_n)]
            if not _p["pattern"]:
                pass
            else:
                report["warnings"].append(
                    "pattern length (" + str(len(_p["pattern"])) + ") != steps (" + str(_n) + "); using default example."
                )
        try:
            _tbl.clear(keepFirstRow=False)
            _tbl.setSize(1, _n)
            for _ci, _val in enumerate(_pattern):
                _tbl[0, _ci] = str(_val)
        except Exception as e:
            report["warnings"].append("Could not write step table: " + str(e))
        report["table"] = _tbl.path

        # CHOP Execute DAT: deploy the substituted dispatch callback.
        _disp = _seq.op("dispatch") or _seq.create(td.chopexecuteDAT, "dispatch")
        try:
            _disp.par.chop = _beat.path
            _disp.par.channel = "count"
            _disp.par.valuechange = True
            if hasattr(_disp.par, "offtoon"):
                _disp.par.offtoon = False
            _disp.par.active = True
        except Exception:
            report["warnings"].append("Could not fully wire the CHOP Execute dispatch DAT.")
        _disp.text = _p["dispatch_text"]
        report["dispatch"] = _disp.path

        # Custom controls: Active (pause), Steps (informative).
        _page = None
        for _pg in _seq.customPages:
            if _pg.name == "BeatGrid":
                _page = _pg; break
        if _page is None:
            _page = _seq.appendCustomPage("BeatGrid")
        if getattr(_seq.par, "Active", None) is None:
            _ap = _page.appendToggle("Active")[0]
            _ap.default = True; _ap.val = True
        report["controls"].append("Active")
        if getattr(_seq.par, "Steps", None) is None:
            _sp = _page.appendInt("Steps")[0]
            _sp.normMin = 1; _sp.normMax = 64
            _sp.default = _n; _sp.val = _n
        report["controls"].append("Steps")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildBeatGridSequencerScript(payload: object): string {
  return buildPayloadScript(BEAT_GRID_SCRIPT, payload);
}

export async function createBeatGridSequencerImpl(
  ctx: ToolContext,
  args: CreateBeatGridSequencerArgs,
) {
  if (args.action === "param" && !args.param) {
    return errorResult(
      "A `param` name is required when action is 'param'. Provide the custom-parameter name on the target COMP.",
    );
  }
  return guardTd(
    async () => {
      const dispatchText = DISPATCH_CALLBACK.replaceAll("__TARGET__", args.target)
        .replaceAll("__ACTION__", args.action)
        .replaceAll("__PARAM__", args.param ?? "");
      const script = buildBeatGridSequencerScript({
        name: args.name,
        parent: args.parent_path,
        target: args.target,
        steps: args.steps,
        action: args.action,
        param: args.param ?? "",
        pattern: args.pattern,
        bpm_source: args.bpm_source ?? null,
        dispatch_text: dispatchText,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BeatGridReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build beat-grid sequencer: ${report.fatal}`, report);
      }
      const actionDesc =
        args.action === "param"
          ? `sets '${args.param ?? "?"}' on ${args.target}`
          : `recalls cues on ${args.target}`;
      const summary = `Built beat-grid sequencer ${report.comp}: ${report.steps} steps, each step ${actionDesc} on the beat boundary (UNVERIFIED — timing requires live TD). Edit the step_table DAT to reprogramme the grid. Toggle Active to pause.${
        report.warnings.length ? ` ${report.warnings.length} warning(s).` : ""
      }`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateBeatGridSequencer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_beat_grid_sequencer",
    {
      title: "Create beat-grid sequencer",
      description:
        "Build a programmable step-grid sequencer driven by a Beat CHOP on the global TD tempo: a Table DAT holds the per-step pattern (values or 1/0 flags), and a CHOP Execute DAT fires on every beat boundary, reads the current step (count % steps) from the table, and dispatches — action=param sets a custom parameter to the step value; action=cue recalls the cue for active steps (cues stored with manage_cue). The deterministic, repeating-rhythm instrument between create_autopilot (random drift) and create_cue_sequencer (linear list): program a strobe on beats 1+3, a hue shift on the bar, etc. Reprogramme the grid live by editing the step_table DAT. NOTE: beat-callback timing is UNVERIFIED offline — check op().time.play if steps don't fire when the TD timeline is paused.",
      inputSchema: createBeatGridSequencerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBeatGridSequencerImpl(ctx, args),
  );
};
