import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const rowSchema = z.object({
  source: z
    .string()
    .describe(
      "Path of an existing TOP to switch to (e.g. '/project1/moviefilein1') OR a logical " +
        "name resolved against `sources_map`. Required.",
    ),
  duration_seconds: z.coerce
    .number()
    .positive()
    .default(30)
    .describe("Wall-clock seconds this row plays before auto-advancing (must be > 0)."),
  transition_seconds: z.coerce
    .number()
    .min(0)
    .optional()
    .describe(
      "Crossfade duration to the NEXT row at the boundary; 0 = hard cut via Switch TOP. " +
        "Defaults to `default_transition` when omitted.",
    ),
  label: z
    .string()
    .optional()
    .describe("Display name in the HUD. Defaults to the source basename."),
});

export const createSetlistRunnerSchema = z.object({
  rows: z
    .array(rowSchema)
    .min(1)
    .describe("Ordered setlist rows. Each row: { source, duration_seconds, transition_seconds }."),
  sources_map: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Optional `{ logical → TOP path }` to allow human-readable row sources like 'actA' " +
        "instead of an absolute path.",
    ),
  default_transition: z.coerce
    .number()
    .min(0)
    .default(0.5)
    .describe("Fallback `transition_seconds` (in seconds) for rows that omit it."),
  loop: z
    .boolean()
    .default(true)
    .describe("When the last row ends: wrap to row 0 (true) or stop (false)."),
  autostart: z.boolean().default(true).describe("Start playing immediately on build."),
  show_hud: z
    .boolean()
    .default(true)
    .describe("Build the NOW/NEXT/remaining Text TOP HUD as a child output."),
  name: z.string().default("setlist").describe("Engine container name."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the engine COMP is created (e.g. '/project1')."),
});

export type CreateSetlistRunnerArgs = z.infer<typeof createSetlistRunnerSchema>;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface SetlistRunnerReport {
  comp: string;
  switch: string;
  timer: string;
  engine: string;
  out_top: string;
  hud?: string;
  rows: Array<{
    source: string;
    duration_seconds: number;
    transition_seconds: number;
    label: string;
  }>;
  controls: string[];
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Engine callback DAT source (run inside TD; placeholders substituted)
// ---------------------------------------------------------------------------

const ENGINE_CALLBACK = `
# Setlist runner engine — advances Switch TOP through rows[] based on Timer CHOP "fraction".
def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != "fraction":
        return
    me_par = me.parent()
    if me_par is None:
        return
    rows = me.fetch("tdmcp_setlist_rows", [])
    idx = me.fetch("tdmcp_setlist_index", 0)
    if not rows:
        return
    if val >= 0.999 and (prev is None or prev < 0.999):
        loop = bool(me_par.par.Loop.eval()) if hasattr(me_par.par, "Loop") else __LOOP__
        nxt = idx + 1
        if nxt >= len(rows):
            if loop:
                nxt = 0
            else:
                return
        me.store("tdmcp_setlist_index", nxt)
        sw = me_par.op("switch")
        if sw is not None:
            try:
                sw.par.index = nxt
            except Exception:
                pass
        tm = me_par.op("timer")
        if tm is not None:
            try:
                tm.par.length = float(rows[nxt].get("duration_seconds", 30.0))
                tm.par.start.pulse()
            except Exception:
                pass
    # HUD update
    if __SHOW_HUD__:
        hud = me_par.op("hud")
        if hud is not None:
            try:
                cur = rows[idx]
                nxt_row = rows[(idx + 1) % len(rows)] if rows else None
                remaining = max(0.0, float(cur.get("duration_seconds", 0.0)) * (1.0 - float(val)))
                lines = []
                lines.append("NOW  " + str(idx).zfill(2) + "  " + str(cur.get("label","")))
                if nxt_row is not None:
                    lines.append("NEXT " + str((idx+1) % len(rows)).zfill(2) + "  " +
                                 str(nxt_row.get("label","")))
                lines.append("REMAINING " + ("%.1f" % remaining) + "s")
                hud.par.text = "\\n".join(lines)
            except Exception:
                pass

def onOffToOn(channel, sampleIndex, val, prev):
    return

def onOnToOff(channel, sampleIndex, val, prev):
    return
`;

// ---------------------------------------------------------------------------
// Python bridge script
// ---------------------------------------------------------------------------

const SETLIST_RUNNER_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": "",
    "switch": "",
    "timer": "",
    "engine": "",
    "out_top": "",
    "rows": _p["rows"],
    "controls": [],
    "warnings": [],
}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        # Reuse-or-create container
        _existing = _parent.op(_p["name"])
        if _existing is not None:
            try:
                _existing.destroy()
            except Exception as _e:
                report["warnings"].append("destroy existing container failed: " + str(_e))
        try:
            _cont = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _cont = None

        if _cont is not None:
            report["comp"] = _cont.path
            try:
                _cont.tags.add("tdmcp_role:setlist_runner")
            except Exception:
                pass

            # --- Select TOPs (one per row) ---
            _selects = []
            for i, row in enumerate(_p["rows"]):
                _sel = None
                try:
                    _sel = _cont.create(selectTOP, "src_" + str(i))
                except Exception as _e:
                    report["warnings"].append("selectTOP[" + str(i) + "] create failed: " + str(_e))
                if _sel is not None:
                    try:
                        _sel.par.top = row["source"]
                    except Exception as _e:
                        report["warnings"].append(
                            "selectTOP[" + str(i) + "].par.top failed: " + str(_e)
                        )
                    _selects.append(_sel)

            # --- Switch TOP ---
            _switch = None
            try:
                _switch = _cont.create(switchTOP, "switch")
            except Exception as _e:
                report["fatal"] = "Could not create switchTOP: " + str(_e)
            if _switch is not None:
                report["switch"] = _switch.path
                for i, _sel in enumerate(_selects):
                    try:
                        _switch.inputConnectors[i].connect(_sel)
                    except Exception as _e:
                        report["warnings"].append(
                            "switch.connect(src_" + str(i) + ") failed: " + str(_e)
                        )
                try:
                    _switch.par.index = 0
                except Exception as _e:
                    report["warnings"].append("switch.par.index failed: " + str(_e))

            # --- Previous-frame snapshot via Select TOP for crossfade in0 ---
            _prev_snap = None
            try:
                _prev_snap = _cont.create(selectTOP, "switch_prev")
                if _switch is not None:
                    try:
                        _prev_snap.par.top = _switch.name
                    except Exception as _e:
                        report["warnings"].append("switch_prev.par.top failed: " + str(_e))
            except Exception as _e:
                report["warnings"].append("switch_prev create failed: " + str(_e))

            # --- Cross TOP (crossfade) ---
            _cross = None
            try:
                _cross = _cont.create(crossTOP, "cross")
            except Exception as _e:
                report["warnings"].append("crossTOP create failed: " + str(_e))
            if _cross is not None and _switch is not None:
                try:
                    _cross.inputConnectors[0].connect(_prev_snap if _prev_snap is not None else _switch)
                except Exception as _e:
                    report["warnings"].append("cross.in0 connect failed: " + str(_e))
                try:
                    _cross.inputConnectors[1].connect(_switch)
                except Exception as _e:
                    report["warnings"].append("cross.in1 connect failed: " + str(_e))
                try:
                    _cross.par.cross = 1.0
                except Exception as _e:
                    report["warnings"].append("cross.par.cross failed: " + str(_e))

            # --- Optional HUD Text TOP ---
            _hud = None
            if _p["show_hud"]:
                try:
                    _hud = _cont.create(textTOP, "hud")
                    try:
                        _hud.par.text = "NOW  00  --"
                    except Exception:
                        pass
                    report["hud"] = _hud.path
                except Exception as _e:
                    report["warnings"].append("textTOP hud create failed: " + str(_e))

            # --- Composite (program + HUD) → Null ---
            _program = _cross if _cross is not None else _switch
            _final = _program
            if _hud is not None and _program is not None:
                try:
                    _comp = _cont.create(compositeTOP, "compose")
                    _comp.inputConnectors[0].connect(_program)
                    _comp.inputConnectors[1].connect(_hud)
                    try:
                        _comp.par.operand = "over"
                    except Exception as _e:
                        report["warnings"].append("compositeTOP.par.operand failed: " + str(_e))
                    _final = _comp
                except Exception as _e:
                    report["warnings"].append("compositeTOP create failed: " + str(_e))

            _null = None
            try:
                _null = _cont.create(nullTOP, "out")
                if _final is not None:
                    _null.inputConnectors[0].connect(_final)
                report["out_top"] = _null.path
            except Exception as _e:
                report["warnings"].append("nullTOP create failed: " + str(_e))

            # --- Row index Null CHOP (downstream bindable) ---
            try:
                _idx_const = _cont.create(constantCHOP, "row_index")
                try:
                    _idx_const.par.name0 = "row_index"
                    _idx_const.par.value0 = 0
                except Exception:
                    pass
            except Exception as _e:
                report["warnings"].append("row_index CHOP create failed: " + str(_e))

            # --- Timer CHOP ---
            _timer = None
            try:
                _timer = _cont.create(timerCHOP, "timer")
            except Exception as _e:
                report["fatal"] = "Could not create timerCHOP: " + str(_e)
            if _timer is not None:
                report["timer"] = _timer.path
                _first_len = float(_p["rows"][0].get("duration_seconds", 30.0)) if _p["rows"] else 30.0
                for _pname, _pval in [
                    ("lengthunits", "seconds"),
                    ("length", _first_len),
                    ("cycle", False),
                    ("outfraction", True),
                    ("outtimercount", True),
                    ("play", bool(_p["autostart"])),
                ]:
                    try:
                        setattr(_timer.par, _pname, _pval)
                    except Exception as _e:
                        report["warnings"].append(
                            "timer.par." + _pname + " failed: " + str(_e)
                        )

            # --- Engine: CHOP Execute DAT ---
            _engine = None
            try:
                _engine = _cont.create(chopexecuteDAT, "engine")
            except Exception as _e:
                report["fatal"] = "Could not create chopexecuteDAT: " + str(_e)
            if _engine is not None:
                report["engine"] = _engine.path
                try:
                    if _timer is not None:
                        _engine.par.chop = _timer.name
                except Exception as _e:
                    report["warnings"].append("engine.par.chop failed: " + str(_e))
                try:
                    _engine.par.channels = "fraction"
                except Exception as _e:
                    report["warnings"].append("engine.par.channels failed: " + str(_e))
                try:
                    _engine.par.valuechange = True
                except Exception as _e:
                    report["warnings"].append("engine.par.valuechange failed: " + str(_e))
                try:
                    _engine.text = _p["engine_source"]
                except Exception as _e:
                    report["warnings"].append("engine.text failed: " + str(_e))
                try:
                    _engine.store("tdmcp_setlist_rows", _p["rows"])
                    _engine.store("tdmcp_setlist_index", 0)
                except Exception as _e:
                    report["warnings"].append("engine.store rows failed: " + str(_e))

            # --- Custom params on container ---
            try:
                _page = _cont.appendCustomPage("Setlist")
                _p_play = _page.appendToggle("Play", label="Play")[0]
                _p_play.default = bool(_p["autostart"])
                _p_play.val = bool(_p["autostart"])
                report["controls"].append("Play")

                _p_row = _page.appendInt("Row", label="Row")[0]
                _p_row.default = 0
                _p_row.normMin = 0
                _p_row.normMax = max(0, len(_p["rows"]) - 1)
                report["controls"].append("Row")

                _p_skip = _page.appendPulse("Skip", label="Skip")[0]
                report["controls"].append("Skip")

                _p_prev = _page.appendPulse("Prev", label="Prev")[0]
                report["controls"].append("Prev")

                _p_loop = _page.appendToggle("Loop", label="Loop")[0]
                _p_loop.default = bool(_p["loop"])
                _p_loop.val = bool(_p["loop"])
                report["controls"].append("Loop")

                _p_dtx = _page.appendFloat("Defaulttransition", label="Default Transition")[0]
                _p_dtx.default = float(_p["default_transition"])
                _p_dtx.val = float(_p["default_transition"])
                report["controls"].append("Defaulttransition")
            except Exception as _e:
                report["warnings"].append("custom params failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSetlistRunnerScript(payload: object): string {
  return buildPayloadScript(SETLIST_RUNNER_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function resolveRows(args: CreateSetlistRunnerArgs): Array<{
  source: string;
  duration_seconds: number;
  transition_seconds: number;
  label: string;
}> {
  const map = args.sources_map;
  return args.rows.map((r) => {
    const src = map[r.source] ?? r.source;
    return {
      source: src,
      duration_seconds: r.duration_seconds,
      transition_seconds:
        r.transition_seconds === undefined ? args.default_transition : r.transition_seconds,
      label: r.label ?? basename(src),
    };
  });
}

function buildEngineSource(args: CreateSetlistRunnerArgs): string {
  return ENGINE_CALLBACK.replace(/__LOOP__/g, args.loop ? "True" : "False").replace(
    /__SHOW_HUD__/g,
    args.show_hud ? "True" : "False",
  );
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createSetlistRunnerImpl(
  ctx: ToolContext,
  args: CreateSetlistRunnerArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  const rows = resolveRows(args);
  const engineSource = buildEngineSource(args);
  return guardTd(
    async () => {
      const script = buildSetlistRunnerScript({
        parent_path: args.parent_path,
        name: args.name,
        rows,
        loop: args.loop,
        autostart: args.autostart,
        show_hud: args.show_hud,
        default_transition: args.default_transition,
        engine_source: engineSource,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SetlistRunnerReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Setlist runner build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const loopNote = args.loop ? ", loop" : "";
      const summary = `Built setlist runner with ${rows.length} rows${loopNote} → ${report.out_top}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateSetlistRunner: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_setlist_runner",
    {
      title: "Create setlist runner",
      description:
        "Layer-1 wall-clock setlist player for rehearsed VJ shows. Pass `rows[]` of " +
        "(source TOP, duration_seconds, transition_seconds) and the tool builds a baseCOMP " +
        "containing N Select TOPs (one per row), a Switch TOP, a Cross TOP for crossfaded " +
        "boundaries (hard cut when transition_seconds=0), an optional NOW/NEXT/remaining " +
        "Text TOP HUD composited over the program, a Timer CHOP + CHOP Execute engine that " +
        "auto-advances rows on wall-clock time, and live custom params Play/Row/Skip/Prev/" +
        "Loop/Defaulttransition for stage overrides. Output is a Null TOP at " +
        "`<parent>/<name>/out`. Fills the gap between create_clip_launcher (manual grid) and " +
        "create_cue_sequencer (musical bars).",
      inputSchema: createSetlistRunnerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSetlistRunnerImpl(ctx, args),
  );
};
