import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const segmentSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Segment name; written to the Segments DAT and reported by the onSegmentEnter callback.",
    ),
  length: z.coerce
    .number()
    .positive()
    .default(4)
    .describe(
      "Length of this segment, in the parent timer's length_unit (seconds or beats). The timer's total run = sum of its segment lengths.",
    ),
});

const timerSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Timer name -> the Timer CHOP node name (and the 'timer' field the callback reports). Must be unique within the scheduler.",
    ),
  length: z.coerce
    .number()
    .positive()
    .default(8)
    .describe(
      "Total length when this timer has no segments. Ignored (a warning is added) when segments is non-empty.",
    ),
  length_unit: z
    .enum(["seconds", "beats"])
    .default("seconds")
    .describe(
      "Unit for length and every segment length. 'seconds' = wall-clock; 'beats' = musical, locked to the global tempo.",
    ),
  segments: z
    .array(segmentSchema)
    .default([])
    .describe(
      "Optional ordered segment list. When present, the timer runs named segments back-to-back and fires onSegmentEnter at each boundary.",
    ),
  loop: z
    .boolean()
    .default(false)
    .describe(
      "true -> the timer cycles forever (Cycle on, Cycle Limit off) and onDone fires once per cycle; false -> runs once to Done.",
    ),
  autostart: z
    .boolean()
    .default(true)
    .describe(
      "true -> initialize + start the timer on build so it begins counting immediately; false -> primed but stopped.",
    ),
});

export const createSchedulerSchema = z.object({
  timers: z
    .array(timerSchema)
    .min(1)
    .describe(
      "One or more named timers built inside the scheduler COMP. Each becomes a Timer CHOP + segment Table DAT, all sharing one Callbacks DAT.",
    ),
  name: z
    .string()
    .default("scheduler")
    .describe(
      "Name of the scheduler engine COMP (a containerCOMP) created inside parent_path. Re-running with the same name reuses it.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the scheduler COMP is created inside."),
  action: z
    .enum(["cue", "param", "script"])
    .default("cue")
    .describe(
      "What the callbacks fire. 'cue': recall a cue (reuses manage_cue's tdmcp_cues). 'param': set target.par.param. 'script': artist-edited stub.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "(action cue/param) COMP the callback acts on. For 'cue', store the cues first with manage_cue.",
    ),
  param: z
    .string()
    .optional()
    .describe("(action param) Custom-parameter name on target the callback sets."),
  on_done_value: z.coerce
    .number()
    .default(1)
    .describe("(action param) Value written to target.par.param on onDone."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Append an Active toggle on the scheduler COMP, so a dashboard can pause callback dispatch live.",
    ),
});
type CreateSchedulerArgs = z.infer<typeof createSchedulerSchema>;

interface SchedulerReport {
  comp: string;
  callbacks: string;
  timers: Array<{
    name: string;
    path: string;
    segments_dat?: string;
    length: number;
    length_unit: "seconds" | "beats";
    loop: boolean;
    autostart: boolean;
    segment_count: number;
  }>;
  controls: string[];
  warnings: string[];
  fatal?: string;
}

// Timer CHOP Callbacks DAT — generic scheduler dispatch (config lives in COMP storage).
// Hook names/signatures are the documented modern Timer-CHOP shape; UNVERIFIED across TD builds.
// Each hook is fail-soft: an unrecognised/absent hook simply never fires and never breaks the others.
const SCHEDULER_CALLBACKS = `import td

def _cfg():
    return me.parent().fetch('tdmcp_sched_cfg', {}) or {}

def _active():
    a = getattr(me.parent().par, 'Active', None)
    return True if a is None else bool(a.eval())

def _target(cfg):
    t = cfg.get('target')
    return op(t) if t else None

def _fire_cue(cfg, cue_name):
    tgt = _target(cfg)
    if tgt is None or not cue_name:
        return
    cues = tgt.fetch('tdmcp_cues', {})
    vals = cues.get(cue_name)
    if not vals:
        return
    for k, v in vals.items():
        par = getattr(tgt.par, k, None)
        if par is not None and not par.readOnly:
            try:
                par.val = v
            except Exception:
                pass

def _fire_param(cfg, value):
    tgt = _target(cfg)
    if tgt is None:
        return
    name = cfg.get('param')
    if not name:
        return
    par = getattr(tgt.par, name, None)
    if par is None or par.readOnly:
        return
    try:
        par.val = float(value)
    except Exception:
        try:
            par.val = value
        except Exception:
            pass

def _fire_script(label, info):
    return

def _dispatch(timer_name, label, seg_name=None, value=None):
    if not _active():
        return
    cfg = _cfg()
    action = cfg.get('action', 'cue')
    if action == 'cue':
        cue = seg_name if seg_name is not None else cfg.get('timers', {}).get(timer_name, {}).get('on_done_cue')
        _fire_cue(cfg, cue)
    elif action == 'param':
        _fire_param(cfg, value)
    else:
        _fire_script(label, seg_name)

def _name(timerOp):
    try:
        return timerOp.name
    except Exception:
        return ''

def onSegmentEnter(timerOp, segment, interrupt):
    seg = getattr(segment, 'name', None)
    if seg is None:
        try:
            seg = str(segment)
        except Exception:
            seg = None
    _dispatch(_name(timerOp), 'segment', seg_name=seg, value=getattr(segment, 'index', 0))
    return

def onCycle(timerOp, segment, interrupt):
    return

def onDone(timerOp, segment, interrupt):
    cfg = _cfg()
    val = cfg.get('on_done_value', 1)
    _dispatch(_name(timerOp), 'done', seg_name=None, value=val)
    return
`;

// One Python pass: build (or reuse) the scheduler COMP, deploy the shared Callbacks DAT, write
// config to storage, then for each timer create a Timer CHOP (+ Segments Table DAT when needed),
// apply length/units/cycle/segments wiring through candidate par tokens (UNVERIFIED across TD
// builds), point each timer at the shared Callbacks DAT, and autostart when requested. Reports
// the created paths + per-timer detail + collected warnings back over stdout.
const SCHEDULER_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["parent"], "callbacks": "", "timers": [], "controls": [], "warnings": []}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP, so it cannot hold the scheduler."
    else:
        _sched = _parent.op(_p["name"]) or _parent.create(td.containerCOMP, _p["name"])
        try:
            _sched.store("tdmcp_role", "scheduler")
        except Exception:
            pass
        report["comp"] = _sched.path

        _cb = _sched.op("callbacks") or _sched.create(td.textDAT, "callbacks")
        _cb.text = _p["callbacks_text"]
        report["callbacks"] = _cb.path

        _cfg = {
            "action": _p["action"], "target": _p["target"], "param": _p["param"],
            "on_done_value": _p["on_done_value"],
            "timers": {t["name"]: {"on_done_cue": t["on_done_cue"]} for t in _p["timers"]},
        }
        _sched.store("tdmcp_sched_cfg", _cfg)

        for _t in _p["timers"]:
            _entry = {"name": _t["name"], "path": "", "length": _t["length"],
                      "length_unit": _t["length_unit"], "loop": _t["loop"],
                      "autostart": _t["autostart"], "segment_count": len(_t["segments"])}
            _tmr = _sched.op(_t["name"]) or _sched.create(td.timerCHOP, _t["name"])
            _entry["path"] = _tmr.path

            _set_len = False
            for _pn in ("length", "Length"):
                try:
                    setattr(_tmr.par, _pn, _t["length"]); _set_len = True; break
                except Exception:
                    pass
            if not _set_len:
                report["warnings"].append("Could not set Length on timer " + _t["name"])
            _unit_ok = False
            for _pn in ("lengthunits", "Lengthunits", "lengthtype"):
                par = getattr(_tmr.par, _pn, None)
                if par is None:
                    continue
                _cands = (["Seconds", "seconds"] if _t["length_unit"] == "seconds"
                          else ["Beats", "beats", "Samples", "samples"])
                for _cand in _cands:
                    try:
                        par.val = _cand; _unit_ok = True; break
                    except Exception:
                        pass
                if _unit_ok:
                    break
            if not _unit_ok:
                report["warnings"].append("Length Units (" + _t["length_unit"] + ") UNVERIFIED on timer " + _t["name"] + " - check par token live.")

            for _pn in ("cycle", "Cycle"):
                try:
                    setattr(_tmr.par, _pn, 1 if _t["loop"] else 0); break
                except Exception:
                    pass
            if _t["loop"]:
                for _pn in ("cyclelimit", "Cyclelimit"):
                    try:
                        setattr(_tmr.par, _pn, 0); break
                    except Exception:
                        pass

            if _t["segments"]:
                _seg = _sched.op(_t["name"] + "_segments") or _sched.create(td.tableDAT, _t["name"] + "_segments")
                try:
                    _seg.clear(keepFirstRow=False)
                    _seg.appendRow(["name", "length"])
                    for _s in _t["segments"]:
                        _seg.appendRow([_s["name"], str(_s["length"])])
                except Exception as e:
                    report["warnings"].append("Could not write segments for " + _t["name"] + ": " + str(e))
                _entry["segments_dat"] = _seg.path
                for _pn in ("segmentsdat", "segdat", "Segdat"):
                    try:
                        setattr(_tmr.par, _pn, _seg.path); break
                    except Exception:
                        pass
                for _pn in ("segmentmethod", "segmethod", "Segmethod"):
                    par = getattr(_tmr.par, _pn, None)
                    if par is None:
                        continue
                    for _cand in ("From DAT", "fromdat", "DAT"):
                        try:
                            par.val = _cand; break
                        except Exception:
                            pass
                    break

            _cbset = False
            for _pn in ("callbacks", "callbackdat", "callbacksdat", "Callbacks"):
                try:
                    setattr(_tmr.par, _pn, _cb.path); _cbset = True; break
                except Exception:
                    pass
            if not _cbset:
                report["warnings"].append("Could not point timer " + _t["name"] + " at the Callbacks DAT (par token UNVERIFIED).")

            for _pn in ("active", "Active"):
                try:
                    setattr(_tmr.par, _pn, 1); break
                except Exception:
                    pass
            if _t["autostart"]:
                for _pulse in ("Initialize", "initialize", "Start", "start"):
                    par = getattr(_tmr.par, _pulse, None)
                    if par is None:
                        continue
                    try:
                        par.pulse()
                    except Exception:
                        try:
                            par.val = 1
                        except Exception:
                            pass
            report["timers"].append(_entry)

        if _p["expose_controls"]:
            _page = None
            for _pg in _sched.customPages:
                if _pg.name == "Scheduler":
                    _page = _pg; break
            if _page is None:
                _page = _sched.appendCustomPage("Scheduler")
            if getattr(_sched.par, "Active", None) is None:
                _ap = _page.appendToggle("Active")[0]
                _ap.default = True; _ap.val = True
            report["controls"].append("Active")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSchedulerScript(payload: object): string {
  return buildPayloadScript(SCHEDULER_SCRIPT, payload);
}

export async function createSchedulerImpl(ctx: ToolContext, args: CreateSchedulerArgs) {
  if ((args.action === "cue" || args.action === "param") && !args.target) {
    return errorResult(
      "`target` is required when action is 'cue' or 'param' (the COMP the callbacks act on).",
    );
  }
  if (args.action === "param" && !args.param) {
    return errorResult(
      "`param` is required when action is 'param' (the custom-parameter name on target).",
    );
  }
  const names = args.timers.map((t) => t.name);
  if (new Set(names).size !== names.length) {
    return errorResult("Timer names must be unique within a scheduler.");
  }
  for (const t of args.timers) {
    if (t.segments.length > 0) {
      // length is ignored when segments are present; not fatal — surfaced via report warning.
    }
  }
  return guardTd(
    async () => {
      const script = buildSchedulerScript({
        parent: args.parent_path,
        name: args.name,
        action: args.action,
        target: args.target ?? null,
        param: args.param ?? null,
        on_done_value: args.on_done_value,
        expose_controls: args.expose_controls,
        callbacks_text: SCHEDULER_CALLBACKS,
        timers: args.timers.map((t) => ({
          name: t.name,
          length: t.length,
          length_unit: t.length_unit,
          loop: t.loop,
          autostart: t.autostart,
          segments: t.segments,
          on_done_cue: t.name,
        })),
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SchedulerReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build scheduler: ${report.fatal}`, report);
      }
      const timerSummary = report.timers
        .map(
          (t) =>
            `${t.name} ${t.length}${t.length_unit === "beats" ? "b" : "s"}${
              t.segment_count ? `/${t.segment_count}seg` : ""
            }${t.loop ? " loop" : ""}`,
        )
        .join(", ");
      const summary =
        `Built scheduler ${report.comp}: ${report.timers.length} timer(s) [${timerSummary}], ` +
        `callbacks -> ${args.action}${args.target ? ` on ${args.target}` : ""}. ` +
        `Timer-CHOP length-unit/segment/callback wiring is UNVERIFIED offline - validate in a running TD.` +
        (report.warnings.length ? ` ${report.warnings.length} warning(s).` : "");
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateScheduler: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_scheduler",
    {
      title: "Create scheduler",
      description:
        "Build a Timer-CHOP scheduler COMP: one or more named timers (seconds or beats), each with an optional ordered segment list, sharing a Callbacks DAT that fires a cue/param/script action on onDone and onSegmentEnter. Atomic timer primitive that create_scene_timeline and other automation rides on. Reuses manage_cue's tdmcp_cues storage for the default 'cue' action - store target cues first with manage_cue.",
      inputSchema: createSchedulerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSchedulerImpl(ctx, args),
  );
};
