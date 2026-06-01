import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createChopRecorderSchema = z.object({
  name: z.string().min(1).describe("Container name, e.g. 'chop_rec_hand'"),
  parent: z.string().optional().describe("Parent COMP path, defaults to '/'"),
  sourceChop: z.string().min(1).describe("Path to source CHOP, e.g. '/project1/null_audio'"),
  lengthSeconds: z
    .number()
    .min(0.25)
    .max(120)
    .default(8)
    .describe("Trail window + take duration in seconds (0.25–120)"),
  takeName: z.string().min(1).default("take1").describe("Storage key for persisted take"),
  loop: z
    .boolean()
    .default(true)
    .describe("When true, timer cycles; when false, plays once then holds"),
  recordOnCreate: z
    .boolean()
    .default(false)
    .describe("If true, sets Record=1 on creation so the trail begins filling immediately"),
  autoBind: z
    .string()
    .optional()
    .describe("Optional 'opPath:parName' to auto-bind the Null CHOP output channel"),
});

export type CreateChopRecorderArgs = z.infer<typeof createChopRecorderSchema>;

interface ChopRecorderReport {
  container?: string;
  source?: string;
  lengthSeconds?: number;
  takeName?: string;
  loop?: boolean;
  recording?: boolean;
  reactiveChannel?: string;
  hasTake?: boolean;
  takeSamples?: number;
  warnings: string[];
  fatal?: string;
  exists?: boolean;
}

const CHOP_RECORDER_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    _parent_path = _p.get("parent", "/")
    _name = _p["name"]
    _source_chop = _p["sourceChop"]
    _length = _p["lengthSeconds"]
    _take_name = _p["takeName"]
    _loop = _p["loop"]
    _record_on_create = _p["recordOnCreate"]
    _auto_bind = _p.get("autoBind")

    _parent = op(_parent_path)
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_parent_path)
    else:
        _comp_path = (_parent_path.rstrip("/") + "/" + _name) if _parent_path != "/" else ("/" + _name)
        _existing = op(_comp_path)
        _exists = _existing is not None
        report["exists"] = _exists

        if _exists:
            _comp = _existing
            # Re-entrant: update controls only
            try:
                _stored = _comp.fetch("tdmcp_chop_recorder", {})
                _stored["lengthSeconds"] = _length
                _stored["takeName"] = _take_name
                _stored["loop"] = _loop
                _comp.store("tdmcp_chop_recorder", _stored)
            except Exception as e:
                report["warnings"].append("re-entrant storage update: " + str(e))
            # Flip loop on timer
            _timer = _comp.op("timer1")
            if _timer is not None:
                try:
                    _timer.par.cycle = 1 if _loop else 0
                except Exception as e:
                    report["warnings"].append("timer1 cycle re-entrant: " + str(e))
                try:
                    _timer.par.length = _length
                except Exception as e:
                    report["warnings"].append("timer1 length re-entrant: " + str(e))
            _trail = _comp.op("trail1")
            if _trail is not None:
                try:
                    _trail.par.wlength = _length
                except Exception as e:
                    report["warnings"].append("trail1 wlength re-entrant: " + str(e))
            # Rehydrate table_take from storage if a take exists
            _take_data = _stored.get("take")
            if _take_data:
                _table = _comp.op("table_take")
                if _table is not None:
                    try:
                        _table.clear()
                        _rows = _take_data.get("rows", [])
                        _nchan = _take_data.get("nchan", 0)
                        _table.appendRow([f"chan{i}" for i in range(_nchan)])
                        for _row in _rows:
                            _table.appendRow(_row)
                    except Exception as e:
                        report["warnings"].append("table_take rehydrate: " + str(e))
        else:
            _comp = _parent.create(td.baseCOMP, _name)

            # select_source CHOP — bridges the external source CHOP into the container
            _sel = _comp.create(td.selectCHOP, "select_source")
            _src_op = op(_source_chop)
            if _src_op is None:
                report["warnings"].append("Source CHOP not found at build time: " + _source_chop)
            else:
                try:
                    _sel.par.chop = _source_chop
                except Exception as e:
                    report["warnings"].append("select_source chop: " + str(e))

            # trail1 CHOP — captures the source over the window
            _trail = _comp.create(td.trailCHOP, "trail1")
            try:
                _trail.inputConnectors[0].connect(_sel)
            except Exception as e:
                report["warnings"].append("trail1 connect: " + str(e))
            try:
                _trail.par.wlength = _length
            except Exception as e:
                report["warnings"].append("trail1 wlength: " + str(e))
            try:
                if hasattr(_trail.par, "units"):
                    _trail.par.units = "seconds"
            except Exception as e:
                report["warnings"].append("trail1 units: " + str(e))
            try:
                _trail.par.capture = 1 if _record_on_create else 0
            except Exception as e:
                report["warnings"].append("trail1 capture: " + str(e))

            # script_snapshot CHOP — placeholder for snapshot logic (callbacks DAT does work)
            _script_snap = _comp.create(td.scriptCHOP, "script_snapshot")

            # table_take DAT — stores the captured snapshot rows
            _table = _comp.create(td.tableDAT, "table_take")

            # datto1 CHOP — plays back the table DAT as CHOP channels
            _datto = _comp.create(td.dattoCHOP, "datto1")
            try:
                _datto.par.dat = _table.path
            except Exception as e:
                report["warnings"].append("datto1 dat par: " + str(e))

            # timer1 CHOP — drives playback fraction 0..1
            _timer = _comp.create(td.timerCHOP, "timer1")
            try:
                _timer.par.length = _length
            except Exception as e:
                report["warnings"].append("timer1 length: " + str(e))
            try:
                _timer.par.cycle = 1 if _loop else 0
            except Exception as e:
                report["warnings"].append("timer1 cycle: " + str(e))
            try:
                if hasattr(_timer.par, "outfraction"):
                    _timer.par.outfraction = 1
            except Exception as e:
                report["warnings"].append("timer1 outfraction: " + str(e))

            # lookup1 CHOP — maps timer fraction to datto rows
            _lookup = _comp.create(td.lookupCHOP, "lookup1")
            try:
                _lookup.inputConnectors[0].connect(_timer)
            except Exception as e:
                report["warnings"].append("lookup1 in0 connect: " + str(e))
            try:
                _lookup.inputConnectors[1].connect(_datto)
            except Exception as e:
                report["warnings"].append("lookup1 in1 connect: " + str(e))
            try:
                if hasattr(_lookup.par, "extend"):
                    _lookup.par.extend = "cycle" if _loop else "hold"
            except Exception as e:
                report["warnings"].append("lookup1 extend: " + str(e))

            # null_out CHOP — bind_to_channel target
            _null_out = _comp.create(td.nullCHOP, "null_out")
            try:
                _null_out.inputConnectors[0].connect(_lookup)
            except Exception as e:
                report["warnings"].append("null_out connect: " + str(e))

            # callbacks DAT — onPulse for Record/Stop/Play
            _callbacks = _comp.create(td.textDAT, "callbacks_dat")
            _callbacks.text = """# tdmcp CHOP Recorder callbacks
def onPulse(par):
    comp = par.owner
    state = comp.fetch('tdmcp_chop_recorder', {})
    trail = comp.op('trail1')
    table = comp.op('table_take')
    if par.name == 'Record':
        if table is not None:
            table.clear()
        if trail is not None:
            trail.par.capture = 1
        state['recording'] = True
    elif par.name == 'Stop':
        if trail is not None:
            trail.par.capture = 0
        if table is not None and trail is not None:
            nchan = trail.numChans
            ns = trail.numSamples
            table.clear()
            table.appendRow([f'chan{i}' for i in range(nchan)])
            for s in range(ns):
                table.appendRow([trail[c][s] for c in range(nchan)])
            state['recording'] = False
            large = nchan * ns > 250000
            if large:
                import os
                save_path = project.folder + '/tdmcp_take_' + comp.par.Takename.eval() + '.tsv'
                try:
                    table.save(save_path)
                    state['take'] = {'name': comp.par.Takename.eval(), 'nchan': nchan, 'samples': ns, 'filepath': save_path}
                except Exception as e:
                    state['take'] = {'name': comp.par.Takename.eval(), 'nchan': nchan, 'samples': ns}
            else:
                state['take'] = {
                    'name': comp.par.Takename.eval(),
                    'nchan': nchan,
                    'samples': ns,
                    'rows': [[trail[c][s] for c in range(nchan)] for s in range(ns)],
                }
    elif par.name == 'Play':
        timer = comp.op('timer1')
        if timer is not None:
            timer.par.start.pulse()
    comp.store('tdmcp_chop_recorder', state)
"""

            # param_exec DAT — routes pulse/value-change events from the container's
            # custom parameters to the onPulse/onValueChange handlers in callbacks_dat
            _param_exec = _comp.create(td.parameterexecuteDAT, "param_exec")
            try:
                _param_exec.par.op = _comp.path
            except Exception as e:
                report["warnings"].append("param_exec op: " + str(e))
            try:
                _param_exec.par.pars = "Record Stop Play Loop Scrub Length Takename"
            except Exception as e:
                report["warnings"].append("param_exec pars: " + str(e))
            try:
                _param_exec.par.custom = True
            except Exception as e:
                report["warnings"].append("param_exec custom: " + str(e))
            try:
                _param_exec.par.builtin = False
            except Exception as e:
                report["warnings"].append("param_exec builtin: " + str(e))
            try:
                _param_exec.par.valuechange = True
            except Exception as e:
                report["warnings"].append("param_exec valuechange: " + str(e))
            try:
                _param_exec.par.onpulse = True
            except Exception as e:
                report["warnings"].append("param_exec onpulse: " + str(e))
            try:
                _param_exec.par.active = True
            except Exception as e:
                report["warnings"].append("param_exec active: " + str(e))
            # Write the callback functions directly into the parameterexecuteDAT
            # so pressing Record/Stop/Play on the custom page actually fires
            _param_exec.text = _callbacks.text

            # state DAT — human-readable state
            _state_dat = _comp.create(td.textDAT, "state_dat")
            _state_dat.text = "state: idle"

            # Custom parameters on container (Recorder page)
            try:
                _pg = _comp.appendCustomPage("Recorder")
                _pg.appendPulse("Record", label="Record")
                _pg.appendPulse("Stop", label="Stop")
                _pg.appendPulse("Play", label="Play")
                _pg.appendToggle("Loop", label="Loop")
                _pg.appendFloat("Scrub", label="Scrub")
                _pg.appendFloat("Length", label="Length (s)")
                _pg.appendStr("Takename", label="Take Name")
                try:
                    _comp.par.Loop = 1 if _loop else 0
                except Exception:
                    pass
                try:
                    _comp.par.Length = _length
                except Exception:
                    pass
                try:
                    _comp.par.Takename = _take_name
                except Exception:
                    pass
                try:
                    _scrub_par = getattr(_comp.par, "Scrub", None)
                    if _scrub_par is not None:
                        _scrub_par.min = 0.0
                        _scrub_par.max = 1.0
                except Exception:
                    pass
                try:
                    _length_par = getattr(_comp.par, "Length", None)
                    if _length_par is not None:
                        _length_par.min = 0.25
                        _length_par.max = 120.0
                except Exception:
                    pass
            except Exception as e:
                report["warnings"].append("custom params: " + str(e))

            # Initialize storage
            _comp.store("tdmcp_chop_recorder", {
                "lengthSeconds": _length,
                "takeName": _take_name,
                "loop": _loop,
                "recording": _record_on_create,
            })

            if _record_on_create:
                try:
                    _trail.par.capture = 1
                except Exception as e:
                    report["warnings"].append("recordOnCreate capture: " + str(e))

        # Auto-bind null_out channel
        if _auto_bind:
            try:
                _ab_parts = _auto_bind.split(":", 1)
                if len(_ab_parts) == 2:
                    _ab_op = op(_ab_parts[0])
                    if _ab_op is not None:
                        _ab_par = getattr(_ab_op.par, _ab_parts[1], None)
                        if _ab_par is not None:
                            _null_out_path = _comp.path + "/null_out"
                            _ab_par.bindExpr = "op('" + _null_out_path + "')['chan1']"
                            _ab_par.bindMode = 1
                        else:
                            report["warnings"].append("autoBind par not found: " + _ab_parts[1])
                    else:
                        report["warnings"].append("autoBind op not found: " + _ab_parts[0])
                else:
                    report["warnings"].append("autoBind format invalid (expected op:par): " + _auto_bind)
            except Exception as e:
                report["warnings"].append("autoBind: " + str(e))

        report["container"] = _comp.path
        report["source"] = _source_chop
        report["lengthSeconds"] = _length
        report["takeName"] = _take_name
        report["loop"] = _loop
        report["recording"] = _record_on_create
        report["reactiveChannel"] = _comp.path + "/null_out"
        _stored2 = _comp.fetch("tdmcp_chop_recorder", {})
        _take2 = _stored2.get("take")
        report["hasTake"] = _take2 is not None
        report["takeSamples"] = _take2.get("samples") if _take2 else 0

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildChopRecorderScript(payload: object): string {
  return buildPayloadScript(CHOP_RECORDER_SCRIPT, payload);
}

export async function createChopRecorderImpl(ctx: ToolContext, args: CreateChopRecorderArgs) {
  const parent = args.parent ?? "/";

  return guardTd(
    async () => {
      const script = buildChopRecorderScript({
        name: args.name,
        parent,
        sourceChop: args.sourceChop,
        lengthSeconds: args.lengthSeconds,
        takeName: args.takeName,
        loop: args.loop,
        recordOnCreate: args.recordOnCreate,
        autoBind: args.autoBind,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ChopRecorderReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create CHOP recorder: ${report.fatal}`, report);
      }
      const loopStr = report.loop ? "loop" : "one-shot";
      const takeStr = report.hasTake
        ? `, take '${report.takeName}' (${report.takeSamples ?? 0} samples)`
        : "";
      const warnStr =
        (report.warnings?.length ?? 0) > 0
          ? `, ${report.warnings.length} warning(s): ${report.warnings.join("; ")}`
          : "";
      const summary =
        `CHOP recorder '${args.name}' at ${report.container ?? args.name} — ` +
        `source: ${report.source ?? args.sourceChop}, ${report.lengthSeconds ?? args.lengthSeconds}s window, ${loopStr}` +
        `${takeStr}${warnStr}. ` +
        `Reactive output: ${report.reactiveChannel ?? "—"}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateChopRecorder: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_chop_recorder",
    {
      title: "Create CHOP recorder",
      description:
        "Build a CHOP recorder/player container that captures a source CHOP's channels over a fixed " +
        "window using a Trail CHOP, snapshots the trail into a Table DAT on Stop, and plays the take " +
        "back via a Datto CHOP indexed by a Timer CHOP–driven Lookup CHOP, terminating on a Null CHOP ready for " +
        "bind_to_channel. Re-entrant: re-running with the same name updates controls without rebuilding. " +
        "The last take is persisted in comp.store so it survives a .toe reload. Large takes (nchan × samples " +
        "> 250k) are saved to disk instead of stored in the .toe. Note: time-dependent playback reads 0 when " +
        "the TD timeline is paused — that is expected behavior.",
      inputSchema: createChopRecorderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createChopRecorderImpl(ctx, args),
  );
};
