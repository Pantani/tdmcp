import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createSetNavigatorSchema = z.object({
  name: z.string().default("set_navigator").describe("Name of the navigator COMP to create."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the navigator container is created inside."),
  target: z
    .string()
    .describe(
      "The COMP whose cues this navigator steps through. Cues are recalled on it via manage_cue.",
    ),
  scenes: z
    .array(z.string())
    .default([])
    .describe(
      "Ordered cue names to navigate. Omit or leave empty to read the target's existing cues.",
    ),
  go_on_beat: z
    .boolean()
    .default(false)
    .describe("Quantize GO to the next beat (needs a tempo/beat source)."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Panel resolution [width, height] in pixels."),
});
type CreateSetNavigatorArgs = z.infer<typeof createSetNavigatorSchema>;

// The Python pass that:
// 1. Reads existing cues from the target COMP (when scenes list is empty)
// 2. Creates the navigator COMP (table DAT + status text DAT)
// 3. Writes the scene list Table DAT
// 4. Adds custom parameters: Index (int), Next (pulse), Prev (pulse), Go (pulse),
//    NowPlaying (string read-only)
// 5. Installs a Parameter Execute DAT that handles Next/Prev/Go pulses
//
// UNVERIFIED (offline / TD not reachable):
// - par.style for custom parameters ('Int', 'Str', 'Pulse') may need probe at runtime
// - appendCustomPage().appendPulse/.appendStr/.appendInt exact names verified against
//   known createControlPanel pattern; used defensively with try/except
// - The Parameter Execute callback wiring (par.op, par.custom, par.onpulse, par.valuechange)
//   mirrors createSyncExternalClock's engine DAT, but pulse-on-Navigator triggering cue
//   recall on *target* is cross-COMP and best-effort
const NAV_SETUP_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": _p["container"], "target": _p["target"], "warnings": [], "scenes": [], "navigator": None}
try:
    _nav = op(_p["container"])
    if _nav is None:
        report["fatal"] = "Navigator container not found: " + _p["container"]
    else:
        _target = op(_p["target"])
        if _target is None:
            report["warnings"].append("Target COMP not found: " + _p["target"] + " — navigator built, but cue recall will fail until the target exists.")

        # Resolve scene list: prefer caller-supplied list; fall back to target's stored cues.
        _scenes = _p.get("scenes") or []
        if not _scenes and _target is not None:
            try:
                _stored = _target.fetch("tdmcp_cues", {})
                _scenes = sorted(_stored.keys())
            except Exception:
                report["warnings"].append("Could not read existing cues from target — scene list empty.")

        # Create (or reuse) the Table DAT that holds the ordered scene list.
        _tbl = _nav.op("scenes") or _nav.create(td.tableDAT, "scenes")
        try:
            _tbl.clear()
            for _s in _scenes:
                _tbl.appendRow([_s])
        except Exception as _ex:
            report["warnings"].append("Scene table write failed: " + str(_ex))

        # Create a text DAT for now-playing feedback (read by scripts at runtime).
        _status = _nav.op("now_playing") or _nav.create(td.textDAT, "now_playing")
        try:
            _init_scene = _scenes[0] if _scenes else ""
            _status.text = _init_scene
        except Exception:
            pass

        report["scenes"] = list(_scenes)
        report["navigator"] = _nav.path
        report["scene_table"] = _tbl.path if _tbl else None

        # Expose custom parameters: Index, Next, Prev, Go, NowPlaying.
        # Defensively try each appendX variant; warn on failure but keep going.
        try:
            _page = None
            for _pg in _nav.customPages:
                if _pg.name == "Navigator":
                    _page = _pg
                    break
            if _page is None:
                _page = _nav.appendCustomPage("Navigator")

            # Index (Int)
            try:
                if not hasattr(_nav.par, "Index"):
                    _page.appendInt("Index", label="Index")[0].min = 0
                    _nav.par.Index = 0
            except Exception as _ex:
                report["warnings"].append("Could not append Index par: " + str(_ex))

            # Next pulse
            try:
                if not hasattr(_nav.par, "Next"):
                    _page.appendPulse("Next", label="Next")
            except Exception as _ex:
                report["warnings"].append("Could not append Next par: " + str(_ex))

            # Prev pulse
            try:
                if not hasattr(_nav.par, "Prev"):
                    _page.appendPulse("Prev", label="Prev")
            except Exception as _ex:
                report["warnings"].append("Could not append Prev par: " + str(_ex))

            # Go pulse
            try:
                if not hasattr(_nav.par, "Go"):
                    _page.appendPulse("Go", label="Go")
            except Exception as _ex:
                report["warnings"].append("Could not append Go par: " + str(_ex))

            # NowPlaying (read-only Str showing current cue name)
            try:
                if not hasattr(_nav.par, "Nowplaying"):
                    _np_par = _page.appendStr("Nowplaying", label="Now Playing")[0]
                    try:
                        _np_par.readOnly = True
                    except Exception:
                        pass
                    if _scenes:
                        _nav.par.Nowplaying = _scenes[0]
            except Exception as _ex:
                report["warnings"].append("Could not append Nowplaying par: " + str(_ex))

        except Exception as _ex:
            report["warnings"].append("Custom parameter setup failed: " + str(_ex))

        # Install a Parameter Execute DAT to handle Next/Prev/Go pulses.
        # UNVERIFIED: par.op / par.pars / par.custom / par.onpulse binding names
        # are the documented form from TD 2023+; probe on first live run if pulses
        # do not fire (check the par execute DAT's error indicator).
        _go_on_beat = bool(_p.get("go_on_beat", False))
        _target_path = _p["target"]
        _cb = _nav.op("nav_engine") or _nav.create(td.parameterexecuteDAT, "nav_engine")
        _engine_text = r"""import td

def onPulse(par):
    nav = par.owner
    tbl = nav.op("scenes")
    if tbl is None:
        return
    row_count = tbl.numRows
    if row_count == 0:
        return
    try:
        idx = int(nav.par.Index.eval())
    except Exception:
        idx = 0
    if par.name == "Next":
        idx = (idx + 1) % row_count
        nav.par.Index = idx
        _update_now_playing(nav, tbl, idx)
    elif par.name == "Prev":
        idx = (idx - 1) % row_count
        nav.par.Index = idx
        _update_now_playing(nav, tbl, idx)
    elif par.name == "Go":
        _fire_cue(nav, tbl, idx)
    return

def _update_now_playing(nav, tbl, idx):
    cell = tbl[idx, 0] if tbl.numRows > idx else None
    name = cell.val if cell else ""
    try:
        nav.par.Nowplaying = name
    except Exception:
        pass
    st = nav.op("now_playing")
    if st:
        st.text = name
    return

def _fire_cue(nav, tbl, idx):
    cell = tbl[idx, 0] if tbl.numRows > idx else None
    if not cell:
        return
    cue_name = cell.val
    target_path = nav.fetch("tdmcp_nav_target", None)
    if not target_path:
        return
    target = op(target_path)
    if target is None:
        return
    go_on_beat = bool(nav.fetch("tdmcp_nav_go_on_beat", False))
    quant = "beat" if go_on_beat else "off"
    _store = dict(target.fetch("tdmcp_cues", {}))
    if cue_name not in _store:
        return
    _to = _store[cue_name]
    _delay = 0.0
    if go_on_beat:
        try:
            _t = op("/").time
            _tempo = float(getattr(_t, "tempo", 0.0) or 0.0)
            if _tempo > 0.0:
                _spb = 60.0 / _tempo
                _beat = getattr(_t, "beat", None)
                if _beat is None:
                    _secs = float(getattr(_t, "seconds", 0.0) or 0.0)
                    _beat = _secs / _spb
                _beat = float(_beat)
                _phase = _beat % 1.0
                _remaining = 1.0 - _phase
                if _remaining <= 1e-6:
                    _remaining = 1.0
                _delay = _remaining * _spb
        except Exception:
            _delay = 0.0
    if _delay <= 0.0:
        # Immediate recall: snap params now.
        for _k, _v in _to.items():
            _pr = getattr(target.par, _k, None)
            if _pr is None or _pr.readOnly:
                continue
            try:
                _pr.val = _v
            except Exception:
                pass
    else:
        # Quantized: schedule via the cue_morph engine.
        _from = {}
        for _k in _to.keys():
            _pr = getattr(target.par, _k, None)
            if _pr is not None:
                try:
                    _from[_k] = _pr.eval()
                except Exception:
                    pass
        target.store("tdmcp_cue_transition", {
            "active": True, "from": _from, "to": _to,
            "start": td.absTime.seconds + _delay, "duration": 0.0001
        })
        _hook = target.op("cue_morph")
        if _hook is not None:
            _hook.par.active = True

def onValueChange(par, prev):
    return
"""
        try:
            _cb.par.op = _nav.path
            _cb.par.pars = "*"
            _cb.par.custom = True
            _cb.par.builtin = False
            _cb.par.onpulse = True
            _cb.par.valuechange = True
            _cb.par.active = True
        except Exception as _ex:
            report["warnings"].append("nav_engine par wiring failed (UNVERIFIED): " + str(_ex))
        try:
            _cb.text = _engine_text
        except Exception as _ex:
            report["warnings"].append("nav_engine text set failed: " + str(_ex))

        # Store runtime config in the navigator's storage so the callback can read it.
        try:
            _nav.store("tdmcp_nav_target", _target_path)
            _nav.store("tdmcp_nav_go_on_beat", _go_on_beat)
        except Exception as _ex:
            report["warnings"].append("Could not store nav config: " + str(_ex))

        report["engine"] = _cb.path if _cb else None
        report["go_on_beat"] = _go_on_beat
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface NavSetupReport {
  container: string;
  target: string;
  navigator?: string;
  scene_table?: string;
  engine?: string;
  scenes: string[];
  go_on_beat: boolean;
  warnings: string[];
  fatal?: string;
}

function buildNavSetupScript(payload: object): string {
  return buildPayloadScript(NAV_SETUP_SCRIPT, payload);
}

export async function createSetNavigatorImpl(
  ctx: ToolContext,
  args: CreateSetNavigatorArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  if (!args.target) {
    return errorResult(
      "'target' is required: specify the COMP whose cues this navigator steps through.",
    );
  }

  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    // Run the main setup: create table, custom pars, engine DAT.
    const setupReport = await guardTd(
      async () => {
        const script = buildNavSetupScript({
          container: builder.containerPath,
          target: args.target,
          scenes: args.scenes,
          go_on_beat: args.go_on_beat,
        });
        const exec = await ctx.client.executePythonScript(script, true);
        return parsePythonReport<NavSetupReport>(exec.stdout);
      },
      (report) => {
        if (report.fatal) {
          return errorResult(`Set navigator setup failed: ${report.fatal}`, report);
        }
        return jsonResult("ok", report);
      },
    );

    // If setup itself fatally failed, return early without finalize overhead.
    if (setupReport.isError) {
      return setupReport;
    }

    // Pull the parsed report out of the jsonResult content text.
    const setupText = setupReport.content.find((c) => c.type === "text") as
      | { text: string }
      | undefined;
    let parsedSetup: NavSetupReport | undefined;
    try {
      const fence = setupText?.text.slice(setupText.text.indexOf("{"));
      if (fence) parsedSetup = JSON.parse(fence) as NavSetupReport;
    } catch {
      // best-effort; we proceed with finalize using builder.warnings
    }

    if (parsedSetup?.warnings) {
      for (const w of parsedSetup.warnings) {
        builder.warnings.push(w);
      }
    }

    const scenes = parsedSetup?.scenes ?? args.scenes;
    const sceneCount = scenes.length;

    // Controls exposed on the system container (standard finalize path).
    // Index + NowPlaying are read-only refs; pulses need no bind_to.
    const controls: ControlSpec[] = [
      {
        name: "Index",
        type: "int",
        default: 0,
        min: 0,
        max: Math.max(0, sceneCount - 1),
        bind_to: [],
      },
      { name: "Next", type: "pulse", bind_to: [] },
      { name: "Prev", type: "pulse", bind_to: [] },
      { name: "Go", type: "pulse", bind_to: [] },
    ];

    const goOnBeatNote = args.go_on_beat
      ? " GO is quantized to the next beat (needs a live tempo source)."
      : "";

    const summary =
      `Built set navigator '${args.name}' (${sceneCount} scene(s)) stepping through cues on '${args.target}'.` +
      ` Controls: Prev / Next to step the scene list, Go to recall the current cue, Index to jump directly.${goOnBeatNote}` +
      " UNVERIFIED (TD offline): pulse-callback wiring and cue-recall cross-COMP path require live validation.";

    return finalize(ctx, {
      summary,
      builder,
      // No visual output: this is a control surface, not a visual generator.
      capturePreviewImage: false,
      controls,
      extra: {
        target: args.target,
        scenes,
        go_on_beat: args.go_on_beat,
        scene_count: sceneCount,
        unverified: [
          "Pulse-callback wiring (par.op / par.pars / par.onpulse) — probe par names on first live run.",
          "Cross-COMP cue recall from navigator to target — requires target COMP to exist with stored cues.",
          "go_on_beat quantize — reads op('/').time.tempo; needs a live tempo source.",
        ],
      },
    });
  });
}

export const registerCreateSetNavigator: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_set_navigator",
    {
      title: "Create set navigator",
      description:
        "Build a hands-light stage navigator (the QLab model) for stepping through an ordered scene/cue list: Next / Prev to move the pointer, Go to fire the current scene's cue on the target COMP, and an Index knob to jump directly. Optionally quantizes GO to the next beat. The navigator drives `manage_cue` recall on the target so cue morphs and beat-quantized changes all work. Use after building a control panel with `manage_cue` cues stored; then perform the show by hitting Next + Go instead of recalling by name.",
      inputSchema: createSetNavigatorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSetNavigatorImpl(ctx, args),
  );
};
