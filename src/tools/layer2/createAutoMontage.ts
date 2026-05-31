import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";

const q = (value: string): string => JSON.stringify(value);

export const createAutoMontageSchema = z.object({
  name: z.string().default("auto_montage").describe("Container COMP name."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  folder: z.string().describe("Folder on the TD machine to scan for clips/stills."),
  extensions: z
    .array(z.string())
    .default(["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"])
    .describe("Allow-listed extensions (lower-case, no dot)."),
  max_clips: z.number().int().min(1).max(64).default(16).describe("Cap clip count."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Switch TOP output resolution [w,h]."),
  mode: z
    .enum(["sequential", "random", "shuffle", "weighted"])
    .default("shuffle")
    .describe(
      "Sequence policy: sequential, random, shuffle (no immediate repeat), weighted (per-clip Weight par).",
    ),
  clock: z
    .enum(["beat", "bar", "interval"])
    .default("bar")
    .describe("Trigger source: beat/bar (Beat CHOP) or interval (LFO CHOP)."),
  bpm: z.number().min(20).max(300).default(120).describe("Tempo when clock=beat|bar."),
  division: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(4)
    .describe("Advance every N beats (beat) or N bars (bar)."),
  interval_s: z
    .number()
    .min(0.05)
    .max(600)
    .default(4.0)
    .describe("Seconds between advances when clock=interval."),
  crossfade: z.number().min(0).max(10).default(0.5).describe("Crossfade seconds (0 = hard cut)."),
  autoplay: z.boolean().default(true).describe("Start in playing state."),
  seed: z.number().int().nullable().default(null).describe("If set, seeds the RNG (reproducible)."),
});
export type CreateAutoMontageArgs = z.infer<typeof createAutoMontageSchema>;

interface AutoMontageReport {
  container: string;
  output_path: string;
  state_chop: string;
  switch_path: string;
  clock_path: string;
  engine: string;
  ramp: string;
  advance: string;
  clips: string[];
  files: string[];
  files_found: number;
  files_scanned: number;
  warnings: string[];
  fatal?: string;
}

// ---- DAT text (generated TS-side, pasted via dat.text = ...) ----

const ENGINE = (switchName: string, clipCount: number): string => `import td

SWITCH = ${q(switchName)}
COUNT = ${clipCount}

def _switch():
    ap = me.parent()
    return ap.op(SWITCH)

def _target(ap):
    try:
        return int(round(float(ap.par.Index.eval()))) % max(1, COUNT)
    except Exception:
        return 0

def _start_ramp(ap, target):
    sw = _switch()
    if sw is None or COUNT <= 1:
        return
    try:
        cur = float(sw.par.index)
    except Exception:
        cur = 0.0
    try:
        xf = max(0.0, float(ap.par.Crossfade.eval()))
    except Exception:
        xf = 0.0
    ap.store('tdmcp_bin', {'from': cur, 'to': float(target), 'start': absTime.seconds, 'dur': xf})
    if xf <= 0.0:
        sw.par.index = float(target)
        ap.store('tdmcp_bin', None)

def onValueChange(par, prev):
    if par.name == 'Index':
        ap = par.owner
        _start_ramp(ap, _target(ap))
    return

def onPulse(par):
    ap = par.owner
    if par.name not in ('Next', 'Prev'):
        return
    step = 1 if par.name == 'Next' else -1
    nxt = (_target(ap) + step) % max(1, COUNT)
    ap.par.Index = nxt
    _start_ramp(ap, nxt)
    return
`;

const RAMP = (switchName: string): string => `import td

SWITCH = ${q(switchName)}

def onFrameStart(frame):
    ap = me.parent()
    state = ap.fetch('tdmcp_bin', None)
    if not state:
        return
    sw = ap.op(SWITCH)
    if sw is None:
        ap.store('tdmcp_bin', None)
        return
    dur = float(state.get('dur', 0.0) or 0.0)
    if dur <= 0.0:
        sw.par.index = float(state['to'])
        ap.store('tdmcp_bin', None)
        return
    t = (absTime.seconds - float(state['start'])) / dur
    if t >= 1.0:
        sw.par.index = float(state['to'])
        ap.store('tdmcp_bin', None)
        return
    a = float(state['from'])
    b = float(state['to'])
    sw.par.index = a + (b - a) * t
    return
`;

const ADVANCE = (clipCount: number): string => `import td, random

COUNT = ${clipCount}

def _pick_next(ap, cur, count):
    mode = str(ap.par.Mode.eval())
    if count <= 1:
        return 0
    if mode == 'sequential':
        return (cur + 1) % count
    rng = ap.fetch('tdmcp_rng', None)
    if rng is None:
        try:
            seed = int(ap.par.Seed.eval() or 0)
        except Exception:
            seed = 0
        rng = random.Random(seed if seed else None)
        ap.store('tdmcp_rng', rng)
    if mode == 'random':
        return rng.randrange(count)
    if mode == 'shuffle':
        bag = ap.fetch('tdmcp_bag', [])
        if not bag:
            bag = list(range(count))
            rng.shuffle(bag)
            if bag and bag[0] == cur and count > 1:
                bag.append(bag.pop(0))
        nxt = bag.pop(0)
        ap.store('tdmcp_bag', bag)
        return nxt
    if mode == 'weighted':
        weights = []
        for i in range(count):
            try:
                w = float(ap.op('clip%d' % (i + 1)).par.Weight.eval())
            except Exception:
                w = 1.0
            weights.append(max(0.0, w))
        total = sum(weights) or 1.0
        r = rng.random() * total
        acc = 0.0
        for i, w in enumerate(weights):
            acc += w
            if r <= acc:
                return i
        return count - 1
    return (cur + 1) % count

def onOffToOn(channel, sampleIndex, val, prev):
    ap = me.parent()
    try:
        if not bool(ap.par.Play.eval()):
            return
    except Exception:
        return
    try:
        n = max(1, int(ap.par.Division.eval()))
    except Exception:
        n = 1
    cnt = ap.fetch('tdmcp_div', 0) + 1
    if cnt < n:
        ap.store('tdmcp_div', cnt)
        return
    ap.store('tdmcp_div', 0)
    try:
        cur = int(ap.par.Index.eval())
    except Exception:
        cur = 0
    nxt = _pick_next(ap, cur, COUNT)
    ap.par.Index = nxt
`;

// One Python pass: scan the folder, build the baseCOMP, the clip TOPs, switch+null, the
// clock CHOP (beat or LFO), the chop-execute + execute DATs (with text pasted in), the
// custom pars, and the state Null CHOP. Fail-forward — every per-step failure becomes a
// warning; only a missing parent COMP is fatal.
const AUTO_MONTAGE_SCRIPT = `
import os, json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_path": "",
    "state_chop": "",
    "switch_path": "",
    "clock_path": "",
    "engine": "",
    "ramp": "",
    "advance": "",
    "clips": [],
    "files": [],
    "files_found": 0,
    "files_scanned": 0,
    "warnings": [],
}

def _setpar(_node, _name, _val, _warns, _label=None):
    pr = getattr(_node.par, _name, None)
    if pr is None:
        _warns.append("No par '%s' on %s." % (_name, _label or _node.name))
        return False
    try:
        pr.val = _val
        return True
    except Exception as _e:
        _warns.append("Could not set %s.%s: %s" % (_label or _node.name, _name, _e))
        return False

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        # ---------- folder scan ----------
        _folder = _p["folder"]
        _exts = set(str(e).lower().lstrip(".") for e in _p["extensions"])
        _cap = int(_p["max_clips"])
        _files = []
        if not os.path.isdir(_folder):
            report["warnings"].append("Folder not found: " + str(_folder) + " - building an empty montage.")
        else:
            _names = sorted(os.listdir(_folder))
            report["files_scanned"] = len(_names)
            for _n in _names:
                _full = os.path.join(_folder, _n)
                if not os.path.isfile(_full):
                    continue
                _ext = os.path.splitext(_n)[1].lower().lstrip(".")
                if _ext in _exts:
                    _files.append(_full)
            if len(_files) > _cap:
                report["warnings"].append("Capped %d files to first %d." % (len(_files), _cap))
            _files = _files[:_cap]
        report["files"] = list(_files)
        report["files_found"] = len(_files)

        try:
            _cont = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _cont = None

        if _cont is not None:
            report["container"] = _cont.path

            # ---------- clip TOPs ----------
            _clips = []
            if not _files:
                try:
                    _c = _cont.create(moviefileinTOP, "clip1")
                    _setpar(_c, "play", 1, report["warnings"])
                    _clips.append(_c)
                except Exception as _e:
                    report["warnings"].append("Empty clip slot failed: " + str(_e))
            else:
                for _i, _f in enumerate(_files):
                    try:
                        _c = _cont.create(moviefileinTOP, "clip%d" % (_i + 1))
                        _setpar(_c, "file", _f, report["warnings"])
                        _setpar(_c, "play", 1, report["warnings"])
                        _clips.append(_c)
                    except Exception as _e:
                        report["warnings"].append("Clip %d failed: %s" % (_i + 1, _e))
            report["clips"] = [c.path for c in _clips]
            _count = len(_clips)

            # ---------- switch + null ----------
            _res = _p.get("resolution") or [1280, 720]
            _switch = None
            if _count > 1:
                try:
                    _switch = _cont.create(switchTOP, "switch")
                    _setpar(_switch, "index", 0, report["warnings"])
                    _setpar(_switch, "blend", 1, report["warnings"])
                    _setpar(_switch, "outputresolution", "custom", report["warnings"])
                    _setpar(_switch, "resolutionw", int(_res[0]), report["warnings"])
                    _setpar(_switch, "resolutionh", int(_res[1]), report["warnings"])
                    for _i, _c in enumerate(_clips):
                        try:
                            _switch.inputConnectors[_i].connect(_c)
                        except Exception as _e:
                            report["warnings"].append("Switch input %d failed: %s" % (_i, _e))
                    report["switch_path"] = _switch.path
                except Exception as _e:
                    report["warnings"].append("Switch TOP failed: " + str(_e))
            _src = _switch if _switch is not None else (_clips[0] if _clips else None)

            try:
                _out = _cont.create(nullTOP, "out1")
                if _src is not None:
                    _out.inputConnectors[0].connect(_src)
                report["output_path"] = _out.path
            except Exception as _e:
                report["warnings"].append("Output Null TOP failed: " + str(_e))

            # ---------- custom pars on the container ----------
            try:
                _page = _cont.appendCustomPage("AutoMontage")
                _pl = _page.appendToggle("Play")[0]
                _pl.default = bool(_p["autoplay"]); _pl.val = bool(_p["autoplay"])
                _ix = _page.appendInt("Index")[0]
                _ix.min = 0; _ix.max = max(0, _count - 1); _ix.default = 0
                _page.appendPulse("Next")
                _page.appendPulse("Prev")
                _xf = _page.appendFloat("Crossfade")[0]
                _xf.min = 0.0; _xf.max = 10.0
                _xf.default = float(_p["crossfade"]); _xf.val = float(_p["crossfade"])
                _bp = _page.appendFloat("Bpm")[0]
                _bp.min = 20.0; _bp.max = 300.0
                _bp.default = float(_p["bpm"]); _bp.val = float(_p["bpm"])
                _dv = _page.appendInt("Division")[0]
                _dv.min = 1; _dv.max = 32
                _dv.default = int(_p["division"]); _dv.val = int(_p["division"])
                _md = _page.appendMenu("Mode")[0]
                _md.menuNames = ["sequential", "random", "shuffle", "weighted"]
                _md.menuLabels = ["sequential", "random", "shuffle", "weighted"]
                _md.default = str(_p["mode"]); _md.val = str(_p["mode"])
                _sd = _page.appendInt("Seed")[0]
                _seed = _p.get("seed")
                _sd.default = int(_seed) if _seed is not None else 0
                _sd.val = int(_seed) if _seed is not None else 0
            except Exception as _e:
                report["warnings"].append("Custom pars failed: " + str(_e))

            # ---------- clock CHOP ----------
            _clock_kind = str(_p["clock"])
            _clock = None
            try:
                if _clock_kind == "interval":
                    _clock = _cont.create(lfoCHOP, "clock")
                    _setpar(_clock, "type", "square", report["warnings"])
                    _period = max(0.001, float(_p["interval_s"]))
                    if not _setpar(_clock, "frequency", 1.0 / _period, report["warnings"], "lfo"):
                        _setpar(_clock, "period", _period, report["warnings"], "lfo")
                else:
                    _clock = _cont.create(beatCHOP, "clock")
                    # Bind tempo to the container's Bpm par so external clock can drive it.
                    _tp = getattr(_clock.par, "tempo", None)
                    if _tp is not None:
                        try:
                            _tp.expr = "op('..').par.Bpm"
                            _tp.mode = ParMode.EXPRESSION
                        except Exception:
                            try:
                                _tp.val = float(_p["bpm"])
                            except Exception:
                                report["warnings"].append("Could not bind Beat CHOP tempo.")
                report["clock_path"] = _clock.path if _clock is not None else ""
            except Exception as _e:
                report["warnings"].append("Clock CHOP failed: " + str(_e))

            # ---------- chop-execute DAT (advance) ----------
            _advance = None
            if _clock is not None:
                try:
                    _advance = _cont.create(chopexecuteDAT, "advance")
                    # Pick the channel name: 'beat' or 'bar' from Beat CHOP, 'chan1' from LFO.
                    if _clock_kind == "bar":
                        _setpar(_advance, "channels", "bar", report["warnings"], "advance")
                    elif _clock_kind == "beat":
                        _setpar(_advance, "channels", "beat", report["warnings"], "advance")
                    else:
                        _setpar(_advance, "channels", "*", report["warnings"], "advance")
                    _setpar(_advance, "chop", _clock.path, report["warnings"], "advance")
                    _setpar(_advance, "offtoon", True, report["warnings"], "advance")
                    _setpar(_advance, "valuechange", False, report["warnings"], "advance")
                    _setpar(_advance, "active", True, report["warnings"], "advance")
                    _advance.text = _p["advance_text"]
                    report["advance"] = _advance.path
                except Exception as _e:
                    report["warnings"].append("CHOP-Execute (advance) failed: " + str(_e))

            # ---------- engine + ramp DATs (only when there is something to switch) ----------
            if _count > 1:
                try:
                    _engine = _cont.create(parameterexecuteDAT, "engine")
                    _setpar(_engine, "op", _cont.path, report["warnings"], "engine")
                    _setpar(_engine, "pars", "Index Next Prev", report["warnings"], "engine")
                    _setpar(_engine, "custom", True, report["warnings"], "engine")
                    _setpar(_engine, "builtin", False, report["warnings"], "engine")
                    _setpar(_engine, "valuechange", True, report["warnings"], "engine")
                    _setpar(_engine, "onpulse", True, report["warnings"], "engine")
                    _setpar(_engine, "active", True, report["warnings"], "engine")
                    _engine.text = _p["engine_text"]
                    report["engine"] = _engine.path
                except Exception as _e:
                    report["warnings"].append("Engine DAT failed: " + str(_e))
                try:
                    _ramp = _cont.create(executeDAT, "ramp")
                    _setpar(_ramp, "framestart", True, report["warnings"], "ramp")
                    _setpar(_ramp, "active", True, report["warnings"], "ramp")
                    _ramp.text = _p["ramp_text"]
                    report["ramp"] = _ramp.path
                except Exception as _e:
                    report["warnings"].append("Ramp DAT failed: " + str(_e))

            # ---------- state out Null CHOP ----------
            try:
                _state = _cont.create(nullCHOP, "state_out")
                report["state_chop"] = _state.path
            except Exception as _e:
                report["warnings"].append("State Null CHOP failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAutoMontageScript(args: CreateAutoMontageArgs, clipCountHint: number): string {
  return buildPayloadScript(AUTO_MONTAGE_SCRIPT, {
    parent_path: args.parent_path,
    name: args.name,
    folder: args.folder,
    extensions: args.extensions,
    max_clips: args.max_clips,
    resolution: args.resolution,
    mode: args.mode,
    clock: args.clock,
    bpm: args.bpm,
    division: args.division,
    interval_s: args.interval_s,
    crossfade: args.crossfade,
    autoplay: args.autoplay,
    seed: args.seed,
    engine_text: ENGINE("switch", clipCountHint),
    ramp_text: RAMP("switch"),
    advance_text: ADVANCE(clipCountHint),
  });
}

export async function createAutoMontageImpl(ctx: ToolContext, args: CreateAutoMontageArgs) {
  return guardTd(
    async () => {
      // The DAT texts capture clipCount at build time. We don't know it until the scan runs
      // inside TD, so we embed the *cap* (max_clips) — the Python `COUNT = N` is used as an
      // upper bound for modulo math; the runtime _pick_next reads the live `clips` list and
      // is robust to count<=1. This is the same trade-off createMediaBin makes.
      const script = buildAutoMontageScript(args, args.max_clips);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AutoMontageReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Auto-montage build failed: ${report.fatal}`, report);
      }
      const controls: ControlSpec[] = [
        { name: "Play", type: "toggle", default: args.autoplay, bind_to: [] },
        {
          name: "Index",
          type: "int",
          min: 0,
          max: Math.max(0, report.clips.length - 1),
          default: 0,
          bind_to: [],
        },
        { name: "Next", type: "pulse", bind_to: [] },
        { name: "Prev", type: "pulse", bind_to: [] },
        { name: "Crossfade", type: "float", min: 0, max: 10, default: args.crossfade, bind_to: [] },
        { name: "Bpm", type: "float", min: 20, max: 300, default: args.bpm, bind_to: [] },
        { name: "Division", type: "int", min: 1, max: 32, default: args.division, bind_to: [] },
        { name: "Seed", type: "int", default: args.seed ?? 0, bind_to: [] },
      ];
      const unverified: string[] = [
        "Beat CHOP tempo/par + channel names (probed best-effort; live-validate channel='beat' vs 'bar').",
        "Switch TOP fractional-index crossfade ramp (set best-effort offline).",
        "CHOP-Execute onOffToOn firing directly on a Beat CHOP channel without an intermediate Trigger CHOP.",
        "Per-clip `Weight` custom par on Movie File In TOPs (weighted mode; fallback: Table DAT).",
      ];
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary =
        report.files_found === 0
          ? `Built an empty auto-montage at ${report.container} (no files found in ${args.folder})${warnNote}.`
          : `Built an auto-montage of ${report.files_found} clip(s) at ${report.container} → ${report.output_path} (clock=${args.clock}, mode=${args.mode})${warnNote}.`;
      return jsonResult(summary, {
        ...report,
        controls,
        unverified,
      });
    },
  );
}

export const registerCreateAutoMontage: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_auto_montage",
    {
      title: "Create auto montage",
      description:
        "Point at a folder and build a self-running clip montage: scans the folder for clips/stills, builds one Movie File In TOP per file feeding a Switch TOP (fractional-index crossfade) → Null TOP, and adds an auto-advance brain on top — a Beat CHOP (clock='beat' or 'bar' with division) or LFO CHOP (clock='interval') drives a CHOP-Execute DAT that picks the next clip per `mode` (sequential / random / shuffle-no-repeat / weighted) and animates the Switch index with a crossfade. Exposes Play / Index / Next / Prev / Crossfade / Bpm / Division / Mode / Seed custom pars on the container; emits a state_out Null CHOP so bind_to_channel can read clip_index/beat. Folder is read inside TD. Missing folder → empty pointable montage instead of error.",
      inputSchema: createAutoMontageSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAutoMontageImpl(ctx, args),
  );
};
