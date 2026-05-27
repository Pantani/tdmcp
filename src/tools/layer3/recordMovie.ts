import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const recordMovieSchema = z.object({
  action: z
    .enum(["start", "stop"])
    .default("start")
    .describe("start recording the TOP to a file, or stop the current recording."),
  node_path: z.string().describe("Path of the TOP to record."),
  file: z
    .string()
    .optional()
    .describe(
      "(start) Output movie path on the TD machine, with a .mov or .mp4 extension. Absolute path recommended.",
    ),
  fps: z.coerce.number().positive().default(30).describe("(start) Frames per second."),
  seconds: z.coerce
    .number()
    .positive()
    .optional()
    .describe(
      "(start) If set, auto-stop after this many seconds (records a fixed-length loop); otherwise record until you call stop.",
    ),
});
type RecordMovieArgs = z.infer<typeof recordMovieSchema>;

interface RecordReport {
  action: string;
  recording?: string;
  stopped?: string;
  auto_stop_seconds?: number;
  warnings: string[];
  fatal?: string;
}

// Execute DAT that turns recording off once `seconds` have elapsed (records a fixed-length loop).
const REC_HOOK = `import td

def onFrameStart(frame):
    comp = me.parent()
    cfg = comp.fetch('tdmcp_record_cfg', None)
    if not cfg or not cfg.get('active'):
        return
    if td.absTime.seconds - cfg.get('start', 0) >= cfg.get('seconds', 0):
        mov = comp.op('tdmcp_record')
        if mov is not None:
            try:
                mov.par.record = False
            except Exception:
                pass
        cfg['active'] = False
        comp.store('tdmcp_record_cfg', cfg)
    return
`;

// One Python pass: a Movie File Out TOP named tdmcp_record is created in the source's parent and
// wired to it; record toggles on (start) / off (stop). With `seconds`, a small Execute DAT turns
// it off after the duration so you capture a fixed-length loop in one call.
const REC_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "warnings": []}
try:
    _src = op(_p["node"])
    if _src is None:
        report["fatal"] = "Source TOP not found: " + _p["node"]
    else:
        _parent = _src.parent()
        if _p["action"] == "stop":
            _mov = _parent.op("tdmcp_record")
            if _mov is None:
                report["warnings"].append("No active recording (tdmcp_record) found.")
            else:
                _mov.par.record = False
                report["stopped"] = _mov.par.file.eval()
                # Recording is finished (the file is written); remove the recorder + auto-stop
                # hook so they don't linger in the project.
                _mov.destroy()
                _hook = _parent.op("tdmcp_record_stop")
                if _hook is not None:
                    _hook.destroy()
        else:
            if not _p.get("file"):
                report["fatal"] = "A file path is required to start recording."
            else:
                _mov = _parent.op("tdmcp_record") or _parent.create(td.moviefileoutTOP, "tdmcp_record")
                _mov.par.file = _p["file"]
                try:
                    _mov.par.fps = _p["fps"]
                except Exception:
                    pass
                try:
                    _mov.inputConnectors[0].connect(_src)
                except Exception:
                    report["warnings"].append("Could not wire the source TOP.")
                _mov.par.record = True
                report["recording"] = _p["file"]
                _secs = _p.get("seconds")
                if _secs and _secs > 0:
                    _parent.store("tdmcp_record_cfg", {"active": True, "start": td.absTime.seconds, "seconds": _secs})
                    _hook = _parent.op("tdmcp_record_stop") or _parent.create(td.executeDAT, "tdmcp_record_stop")
                    _hook.text = _p["hook"]
                    if hasattr(_hook.par, "framestart"):
                        _hook.par.framestart = True
                    _hook.par.active = True
                    report["auto_stop_seconds"] = _secs
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildRecordScript(payload: object): string {
  return buildPayloadScript(REC_SCRIPT, payload);
}

export async function recordMovieImpl(ctx: ToolContext, args: RecordMovieArgs) {
  return guardTd(
    async () => {
      const script = buildRecordScript({
        action: args.action,
        node: args.node_path,
        file: args.file ?? null,
        fps: args.fps,
        seconds: args.seconds ?? null,
        hook: REC_HOOK,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RecordReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal)
        return jsonResult(`Record ${report.action} failed: ${report.fatal}`, report);
      if (report.action === "stop") {
        return jsonResult(
          `Stopped recording${report.stopped ? ` → ${report.stopped}` : ""}.`,
          report,
        );
      }
      const auto = report.auto_stop_seconds
        ? ` (auto-stops after ${report.auto_stop_seconds}s)`
        : " (call stop to finish)";
      return jsonResult(`Recording ${args.node_path} → ${report.recording}${auto}.`, report);
    },
  );
}

export const registerRecordMovie: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "record_movie",
    {
      title: "Record movie / sequence",
      description:
        "Record a TOP to a movie file (.mov/.mp4) via a Movie File Out TOP — for exporting a clip or a loop, where render_output only saves a single frame. start begins recording (pass file, fps); pass `seconds` to auto-stop after a fixed length, or call stop to finish (stop also cleans up the recorder node). The file is written by TouchDesigner on the TD machine. For individual numbered frames, use render_output per frame.",
      inputSchema: recordMovieSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => recordMovieImpl(ctx, args),
  );
};
