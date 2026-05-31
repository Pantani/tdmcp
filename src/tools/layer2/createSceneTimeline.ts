import { z } from "zod";
import { parseSetlist } from "../../automation/setlistSchema.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * Cross-check a scene's `setlist_slot` ref against an inline setlist JSON object
 * (when the caller pre-loaded it). Returns the list of unknown slot ids — never
 * throws. Exposed for the tool's optional `setlist` inline arg + downstream
 * coherence tools; the in-TD path uses `setlist_path` and resolves at runtime.
 */
export function validateSlotRefs(setlistJson: unknown, slots: ReadonlyArray<string>): string[] {
  const parsed = parseSetlist(setlistJson);
  if (!parsed.success) return [];
  const data = parsed.data;
  const known = new Set<string>();
  for (const s of data.scenes ?? []) {
    if (typeof s === "object" && s && "id" in s && typeof s.id === "string") known.add(s.id);
    if (typeof s === "object" && s && "title" in s && typeof s.title === "string")
      known.add(s.title);
  }
  for (const t of data.tracks ?? []) {
    if (typeof t === "object" && t && "title" in t && typeof t.title === "string")
      known.add(t.title);
  }
  return slots.filter((s) => !known.has(s));
}

/**
 * `create_scene_timeline` — the macro show clock.
 *
 * Builds a single Timer-CHOP playhead that drives an ordered list of "scenes",
 * each referencing a cue stored via `manage_cue` on `target`. The engine is
 * scrubbable (Seek 0..1), supports play/pause/stop, rate, and looping, and
 * exposes a `playhead` Null CHOP that downstream tools can `bind_to_channel`
 * onto (`t_seconds`, `t_norm`, `scene_idx`, `scene_t`).
 *
 * Sits ABOVE `create_cue_sequencer` (beat-quantized, no scrub) and
 * `create_scheduler` (event-firing, no scrub). Consumes the foundation setlist
 * schema: when `setlist_path` is given, each scene's `setlist_slot` cross-
 * references a slot id in that DAT for downstream tools.
 *
 * Storage namespace `tdmcp_scenes` (distinct from `tdmcp_cues` /
 * `tdmcp_sched_cfg`) to avoid collisions with sibling automation tools.
 */

// Default project tempo used for the bars→seconds conversion at build time.
// The tool is deliberately not auto-rescaling: if the artist later changes
// project tempo, the timeline does NOT update (per spec). Documented inline.
const DEFAULT_BPM = 120;
const DEFAULT_BEATS_PER_BAR = 4;

export const sceneSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Human label for the scene; used in the live control row + Active_Scene readout."),
  cue: z
    .string()
    .min(1)
    .describe(
      "Name of a cue stored on `target` via manage_cue. Recalled when the playhead enters.",
    ),
  start: z.coerce
    .number()
    .min(0)
    .describe("Start offset on the timeline, in `units` (seconds or bars)."),
  duration: z.coerce
    .number()
    .positive()
    .describe("Length of this scene on the timeline, in `units`."),
  morph_in_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe("Crossfade duration entering this scene from the previous one. 0 = snap."),
  setlist_slot: z
    .string()
    .optional()
    .describe(
      "OPTIONAL setlist slot id (resolved against `setlist_path`) for downstream cross-refs.",
    ),
});

export const createSceneTimelineSchema = z.object({
  target: z
    .string()
    .default("/project1")
    .describe("COMP that owns the cues (tdmcp_cues). Store scenes' cues first with manage_cue."),
  scenes: z
    .array(sceneSchema)
    .min(1)
    .describe("Ordered scene list (sorted by `start` at build time). Overlaps drive morphs."),
  units: z
    .enum(["seconds", "bars"])
    .default("seconds")
    .describe(
      "Input unit for `start`/`duration`/`morph_in_seconds`. 'bars' is converted to seconds " +
        "at build time using BPM 120 + 4 beats-per-bar (no auto-rescale on tempo change).",
    ),
  loop: z.boolean().default(true).describe("End of last scene → wrap to 0."),
  rate: z.coerce
    .number()
    .positive()
    .default(1.0)
    .describe("Playback rate multiplier (Timer CHOP speed). Exposed as a live custom par."),
  autoplay: z.boolean().default(false).describe("Pulse the Timer's start on cook when true."),
  setlist_path: z
    .string()
    .optional()
    .describe(
      "OPTIONAL path to a DAT holding the foundation-setlist JSON. When present, " +
        "scene.setlist_slot is stored alongside each scene in tdmcp_scenes for downstream tools.",
    ),
  name: z.string().default("scene_timeline").describe("Engine COMP name."),
  parent_path: z.string().default("/project1").describe("Parent path where the engine COMP lives."),
});

export type CreateSceneTimelineArgs = z.infer<typeof createSceneTimelineSchema>;

interface ResolvedScene {
  idx: number;
  name: string;
  cue: string;
  start_seconds: number;
  end_seconds: number;
  morph_in_seconds: number;
  setlist_slot: string | null;
}

interface SceneTimelineReport {
  comp: string;
  timer: string;
  playhead: string;
  transport: string;
  segments_dat: string;
  morph_runner: string;
  total_seconds: number;
  scene_count: number;
  scenes: Array<{ idx: number; name: string; cue: string; start: number; end: number }>;
  controls: string[];
  warnings: string[];
  fatal?: string;
}

// CHOP Execute DAT text — diff-checks active scene from segmentsTable on each
// cook of the playhead Null CHOP and recalls the cue on target with the row's
// morph_in_seconds. Reuses the cue-morph engine `manage_cue`/`create_cue_sequencer`
// already populate via tdmcp_cues. UNVERIFIED across TD builds — probe live.
const MORPH_RUNNER_TEXT = `# CHOP Execute DAT — scene-timeline morph runner
# Driven by the playhead Null CHOP. Diff-checks active scene index and recalls
# its cue on the target COMP with morph_in_seconds from the segments table.

def _engine():
    return me.parent()

def _target():
    eng = _engine()
    t = eng.fetch('tdmcp_scene_target', '')
    return op(t) if t else None

def _segments():
    eng = _engine()
    return eng.op('segments') or None

def _active_idx(t_seconds):
    seg = _segments()
    if seg is None:
        return -1
    # rows: idx,name,cue,start,end,morph_in,slot   (row 0 is header)
    for r in range(1, seg.numRows):
        try:
            start = float(seg[r, 'start'].val)
            end = float(seg[r, 'end'].val)
        except Exception:
            continue
        if t_seconds >= start and t_seconds < end:
            try:
                return int(seg[r, 'idx'].val)
            except Exception:
                return r - 1
    return -1

def _recall(idx):
    seg = _segments()
    tgt = _target()
    if seg is None or tgt is None or idx < 0:
        return
    # rows: idx,name,cue,start,end,morph_in,slot
    row = idx + 1
    if row >= seg.numRows:
        return
    cue = seg[row, 'cue'].val
    cues = tgt.fetch('tdmcp_cues', {})
    vals = cues.get(cue)
    if not vals:
        return
    for k, v in vals.items():
        par = getattr(tgt.par, k, None)
        if par is not None and not par.readOnly:
            try:
                par.val = v
            except Exception:
                pass

def onValueChange(channel, sampleIndex, val, prev):
    eng = _engine()
    if channel.name != 't_seconds':
        return
    idx = _active_idx(float(val))
    last = eng.fetch('tdmcp_scene_active', -1)
    if idx != last:
        eng.store('tdmcp_scene_active', idx)
        ap = getattr(eng.par, 'Active_Scene', None)
        if ap is not None:
            try:
                seg = _segments()
                if seg is not None and idx >= 0 and (idx + 1) < seg.numRows:
                    ap.val = seg[idx + 1, 'name'].val
                else:
                    ap.val = ''
            except Exception:
                pass
        _recall(idx)
    return

def onOffToOn(channel, sampleIndex, val, prev): return
def onOnToOff(channel, sampleIndex, val, prev): return
def onWhileOn(channel, sampleIndex, val, prev): return
def onWhileOff(channel, sampleIndex, val, prev): return
def onValuesChanged(changes): return
`;

// One Python pass: create/reuse engine baseCOMP, drop Timer CHOP + two Null
// CHOPs + segments TableDAT + CHOP-Execute DAT (morph runner), build custom
// pars (Play/Pause/Stop/Seek/Rate/Loop/Active_Scene/Time_Display), persist
// tdmcp_scenes + tdmcp_scene_target + setlist_path in comp.storage, optionally
// autoplay. Reports the resolved paths + warnings.
const SCENE_TIMELINE_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": _p["parent"], "timer": "", "playhead": "", "transport": "",
    "segments_dat": "", "morph_runner": "",
    "total_seconds": _p["total_seconds"], "scene_count": len(_p["scenes"]),
    "scenes": [], "controls": [], "warnings": [],
}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP, so it cannot hold the scene timeline."
    else:
        _eng = _parent.op(_p["name"]) or _parent.create(td.baseCOMP, _p["name"])
        try:
            _eng.store("tdmcp_role", "scene_timeline")
        except Exception:
            pass
        report["comp"] = _eng.path

        # Persist scene config (tdmcp_scenes) + target + setlist path
        _eng.store("tdmcp_scenes", _p["scenes"])
        _eng.store("tdmcp_scene_target", _p["target"])
        _eng.store("tdmcp_scene_active", -1)
        if _p["setlist_path"]:
            _eng.store("setlist_path", _p["setlist_path"])

        # Timer CHOP — playhead
        _tmr = _eng.op("timerCHOP") or _eng.create(td.timerCHOP, "timerCHOP")
        report["timer"] = _tmr.path
        for _pn in ("length", "Length"):
            try:
                setattr(_tmr.par, _pn, _p["total_seconds"]); break
            except Exception:
                pass
        for _pn in ("lengthunits", "Lengthunits"):
            par = getattr(_tmr.par, _pn, None)
            if par is None: continue
            for _cand in ("Seconds", "seconds"):
                try:
                    par.val = _cand; break
                except Exception:
                    pass
            break
        for _pn in ("cycle", "Cycle"):
            try:
                setattr(_tmr.par, _pn, 1 if _p["loop"] else 0); break
            except Exception:
                pass
        for _pn in ("speed", "Speed"):
            try:
                setattr(_tmr.par, _pn, float(_p["rate"])); break
            except Exception:
                pass

        # Segments Table DAT — rows: idx,name,cue,start,end,morph_in,slot
        _seg = _eng.op("segments") or _eng.create(td.tableDAT, "segments")
        report["segments_dat"] = _seg.path
        try:
            _seg.clear(keepFirstRow=False)
            _seg.appendRow(["idx", "name", "cue", "start", "end", "morph_in", "slot"])
            for _s in _p["scenes"]:
                _seg.appendRow([
                    str(_s["idx"]), _s["name"], _s["cue"],
                    str(_s["start_seconds"]), str(_s["end_seconds"]),
                    str(_s["morph_in_seconds"]), _s.get("setlist_slot") or "",
                ])
        except Exception as e:
            report["warnings"].append("Could not write segments table: " + str(e))

        # Playhead Null CHOP — channels: t_seconds, t_norm, scene_idx, scene_t
        _play = _eng.op("playhead") or _eng.create(td.nullCHOP, "playhead")
        report["playhead"] = _play.path
        # Transport Null CHOP — mirrors custom pars
        _tx = _eng.op("transport") or _eng.create(td.nullCHOP, "transport")
        report["transport"] = _tx.path

        # CHOP Execute DAT — morph runner
        _mr = _eng.op("morphRunner") or _eng.create(td.chopExecuteDAT, "morphRunner")
        report["morph_runner"] = _mr.path
        try:
            _mr.text = _p["morph_runner_text"]
        except Exception:
            pass
        for _pn in ("chop", "Chop"):
            try:
                setattr(_mr.par, _pn, _play.path); break
            except Exception:
                pass
        for _pn in ("valuechange", "Valuechange"):
            try:
                setattr(_mr.par, _pn, 1); break
            except Exception:
                pass

        # Custom pars on the engine COMP
        _page = None
        for _pg in _eng.customPages:
            if _pg.name == "Timeline":
                _page = _pg; break
        if _page is None:
            _page = _eng.appendCustomPage("Timeline")
        def _ensure(kind, label, default=None):
            existing = getattr(_eng.par, label, None)
            if existing is not None:
                return existing
            try:
                if kind == "pulse":
                    return _page.appendPulse(label)[0]
                if kind == "toggle":
                    p = _page.appendToggle(label)[0]
                    if default is not None: p.default = default; p.val = default
                    return p
                if kind == "float":
                    p = _page.appendFloat(label)[0]
                    if default is not None: p.default = default; p.val = default
                    return p
                if kind == "str":
                    p = _page.appendStr(label)[0]
                    if default is not None: p.default = default; p.val = default
                    return p
            except Exception as e:
                report["warnings"].append("Could not append par " + label + ": " + str(e))
            return None
        for _label in ("Play", "Pause", "Stop"):
            if _ensure("pulse", _label) is not None:
                report["controls"].append(_label)
        if _ensure("float", "Seek", 0.0) is not None: report["controls"].append("Seek")
        if _ensure("float", "Rate", float(_p["rate"])) is not None: report["controls"].append("Rate")
        if _ensure("toggle", "Loop", bool(_p["loop"])) is not None: report["controls"].append("Loop")
        if _ensure("str", "Active_Scene", "") is not None: report["controls"].append("Active_Scene")
        if _ensure("str", "Time_Display", "0:00.000") is not None:
            report["controls"].append("Time_Display")

        if _p["autoplay"]:
            for _pulse in ("Initialize", "initialize", "Start", "start"):
                par = getattr(_tmr.par, _pulse, None)
                if par is None: continue
                try:
                    par.pulse(); break
                except Exception:
                    try:
                        par.val = 1; break
                    except Exception:
                        pass

        report["scenes"] = [
            {"idx": s["idx"], "name": s["name"], "cue": s["cue"],
             "start": s["start_seconds"], "end": s["end_seconds"]}
            for s in _p["scenes"]
        ]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSceneTimelineScript(payload: object): string {
  return buildPayloadScript(SCENE_TIMELINE_SCRIPT, payload);
}

/** seconds-per-unit factor for bars→seconds conversion. */
export function unitsToSeconds(units: "seconds" | "bars"): number {
  if (units === "seconds") return 1;
  return (60 / DEFAULT_BPM) * DEFAULT_BEATS_PER_BAR; // 120 BPM × 4 bpb → 2.0 s/bar
}

interface ResolveResult {
  scenes: ResolvedScene[];
  total_seconds: number;
  warnings: string[];
}

export function resolveScenes(args: CreateSceneTimelineArgs): ResolveResult {
  const factor = unitsToSeconds(args.units);
  const warnings: string[] = [];
  // Sort by start (defensive; spec calls for ordered input).
  const sorted = [...args.scenes].sort((a, b) => a.start - b.start);
  const resolved: ResolvedScene[] = sorted.map((s, idx) => ({
    idx,
    name: s.name,
    cue: s.cue,
    start_seconds: s.start * factor,
    end_seconds: (s.start + s.duration) * factor,
    morph_in_seconds: s.morph_in_seconds,
    setlist_slot: s.setlist_slot ?? null,
  }));

  // Clamp morph_in_seconds to the previous scene's duration; never throw.
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    if (!prev || !cur) continue;
    const prevDuration = prev.end_seconds - prev.start_seconds;
    if (cur.morph_in_seconds > prevDuration) {
      warnings.push(
        `Scene "${cur.name}" morph_in_seconds (${cur.morph_in_seconds}s) exceeds previous ` +
          `scene "${prev.name}" duration (${prevDuration}s); clamped.`,
      );
      cur.morph_in_seconds = prevDuration;
    }
  }

  const total_seconds = resolved.reduce((max, s) => Math.max(max, s.end_seconds), 0);
  return { scenes: resolved, total_seconds, warnings };
}

export async function createSceneTimelineImpl(ctx: ToolContext, args: CreateSceneTimelineArgs) {
  // Schema guarantees scenes.length >= 1; this is just a belt-and-braces check.
  if (args.scenes.length === 0) {
    return errorResult("At least one scene is required.");
  }
  const names = args.scenes.map((s) => s.name);
  if (new Set(names).size !== names.length) {
    return errorResult("Scene names must be unique within a timeline.");
  }
  const { scenes, total_seconds, warnings: resolveWarnings } = resolveScenes(args);

  return guardTd(
    async () => {
      const script = buildSceneTimelineScript({
        parent: args.parent_path,
        name: args.name,
        target: args.target,
        loop: args.loop,
        rate: args.rate,
        autoplay: args.autoplay,
        setlist_path: args.setlist_path ?? null,
        units: args.units,
        total_seconds,
        scenes,
        morph_runner_text: MORPH_RUNNER_TEXT,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SceneTimelineReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build scene timeline: ${report.fatal}`, report);
      }
      const allWarnings = [...resolveWarnings, ...(report.warnings ?? [])];
      const summary =
        `Built scene timeline ${report.comp}: ${report.scene_count} scene(s), ` +
        `total ${total_seconds.toFixed(2)}s (${args.units}), loop=${args.loop}, rate=${args.rate}. ` +
        `Timer-CHOP par tokens + CHOP Execute firing are UNVERIFIED offline - validate in a running TD.` +
        (allWarnings.length ? ` ${allWarnings.length} warning(s).` : "");
      return jsonResult(summary, { ...report, warnings: allWarnings });
    },
  );
}

export const registerCreateSceneTimeline: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_scene_timeline",
    {
      title: "Create scene timeline",
      description:
        "Build a scrubbable show timeline: a single Timer-CHOP playhead drives ordered scenes that recall cues on a target COMP. Sits above create_cue_sequencer (beat-quantized) and create_scheduler (event-firing) as the show's master clock. Exposes Play/Pause/Stop/Seek/Rate/Loop/Active_Scene custom pars + a playhead Null CHOP (t_seconds, t_norm, scene_idx, scene_t). Consumes the foundation setlist schema: when setlist_path is given, each scene's setlist_slot is mirrored into tdmcp_scenes for downstream tools. Bars→seconds conversion uses BPM 120 + 4 beats-per-bar at build time (no auto-rescale on tempo change).",
      inputSchema: createSceneTimelineSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSceneTimelineImpl(ctx, args),
  );
};
