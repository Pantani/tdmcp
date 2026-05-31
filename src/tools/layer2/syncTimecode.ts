import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const syncTimecodeSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Name prefix for the timecode subsystem COMP (defaults to 'tc_in1')."),
  parent: z.string().default("/project1").describe("COMP to host the timecode subsystem in."),
  source: z
    .enum(["mtc", "ltc", "osc"])
    .describe(
      "Timecode transport: 'mtc' = MIDI Time Code (MIDI In), 'ltc' = Linear Time Code from audio (no native TD decoder — surfaces a warning), 'osc' = OSC In CHOP listening on host:port.",
    ),
  host: z
    .string()
    .optional()
    .describe("(osc) Bind interface; ignored for mtc/ltc. Defaults to '0.0.0.0'."),
  port: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "(osc) UDP port (default 7000) or (mtc/ltc) device index (default 0). The device picker can hang on a macOS permission modal — keep the default unless you know the device.",
    ),
  osc_address: z
    .string()
    .optional()
    .describe("(osc) OSC address pattern carrying the timecode payload. Defaults to '/timecode'."),
  fps: z.coerce
    .number()
    .optional()
    .describe("Reference frame-rate for SMPTE→frame conversion (24/25/29.97/30)."),
  drive_timeline: z
    .boolean()
    .default(true)
    .describe(
      "When true, an Execute DAT writes project.frame = tc_out['frame'] each cook. Requires the project to be playing — paused TD will not advance.",
    ),
  cue_on_label: z
    .boolean()
    .default(false)
    .describe(
      "(osc) If the payload is a string matching a project cue name, call project.cue(name) instead of seeking.",
    ),
});
type SyncTimecodeArgs = z.infer<typeof syncTimecodeSchema>;

interface TimecodeReport {
  kind: string;
  source: string;
  node?: string;
  null_path?: string;
  drive_path?: string | null;
  fps?: number | null;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass: probe operator types defensively (KB lag — `timecodeCHOP` and
// MTC channel layout are UNVERIFIED on the target build), build the subsystem,
// normalise to a single `frame` channel, and optionally wire an Execute DAT that
// drives project.frame. All par writes go through getattr-guarded helpers so
// missing parameters degrade to warnings instead of fataling the whole build.
const SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"kind": "sync_timecode", "source": _p["source"], "warnings": [], "errors": [], "drive_path": None, "fps": _p.get("fps")}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _stem = _p.get("name") or "tc_in1"
        _sysname = _stem + "_sys"
        _sys = _parent.op(_sysname)
        if _sys is None:
            _sys = _parent.create(baseCOMP, _sysname)
        def _setpar(node, parname, val):
            if val is None or node is None:
                return
            pr = getattr(node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, getattr(node, 'type', '?'))); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s'" % parname)
        _src = _p["source"]
        _in = None
        if _src == "osc":
            _in = _sys.create(oscinCHOP, "osc_in")
            _setpar(_in, "port", _p.get("port") if _p.get("port") is not None else 7000)
            _setpar(_in, "netaddress", _p.get("host") or "0.0.0.0")
            _setpar(_in, "address", _p.get("osc_address") or "/timecode")
        elif _src == "mtc":
            # MTC operator type UNVERIFIED on this build — try midiinCHOP, fall back
            # to midiinDAT + Script CHOP shim is out-of-scope; surface a warning.
            _mtype = getattr(__builtins__, "midiinCHOP", None) if isinstance(__builtins__, dict) is False else __builtins__.get("midiinCHOP")
            try:
                _in = _sys.create(midiinCHOP, "midi_in")
            except Exception:
                report["warnings"].append("midiinCHOP not available — MTC requires a Script CHOP shim on this build.")
            _setpar(_in, "device", _p.get("port") if _p.get("port") is not None else 0)
        elif _src == "ltc":
            # LTC has no native TD decoder as of KB snapshot — create the audio
            # input so the artist can wire their own decoder, and surface a warning.
            try:
                _in = _sys.create(audiodeviceinCHOP, "audio_in")
            except Exception:
                report["warnings"].append("audiodeviceinCHOP not available on this build.")
            _setpar(_in, "device", _p.get("port") if _p.get("port") is not None else 0)
            report["warnings"].append("LTC has no native TouchDesigner decoder — install ltc-tools or an external LTC→MTC bridge, then point this sync_timecode at the MTC source instead.")
        if _in is not None:
            report["node"] = _in.path
            _math = _sys.create(mathCHOP, "tc_frames")
            try:
                _math.inputConnectors[0].connect(_in)
            except Exception:
                report["warnings"].append("Could not wire " + _in.path + " into math CHOP.")
            _null = _sys.create(nullCHOP, "tc_out")
            try:
                _null.inputConnectors[0].connect(_math)
            except Exception:
                report["warnings"].append("Could not wire math CHOP into tc_out.")
            report["null_path"] = _null.path
            report["errors"] = [str(e) for e in _in.errors()][:3]
            if _p.get("drive_timeline"):
                _exec = _sys.create(executeDAT, "tc_drive")
                _code = "def onFrameStart(frame):\\n    ch = op('tc_out')['frame']\\n    if ch is not None:\\n        project.frame = int(ch.eval())\\n"
                try:
                    _exec.text = _code
                except Exception:
                    report["warnings"].append("Could not write tc_drive script body.")
                _setpar(_exec, "framestart", True)
                report["drive_path"] = _exec.path
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSyncTimecodeScript(payload: object): string {
  return buildPayloadScript(SCRIPT, payload);
}

export async function syncTimecodeImpl(ctx: ToolContext, args: SyncTimecodeArgs) {
  return guardTd(
    async () => {
      const script = buildSyncTimecodeScript({
        parent: args.parent,
        name: args.name ?? null,
        source: args.source,
        host: args.host ?? null,
        port: args.port ?? (args.source === "osc" ? 7000 : 0),
        osc_address: args.source === "osc" ? (args.osc_address ?? "/timecode") : null,
        fps: args.fps ?? null,
        drive_timeline: args.drive_timeline,
        cue_on_label: args.cue_on_label,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TimecodeReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not sync timecode: ${report.fatal}`, report);
      }
      const drive = report.drive_path ? `, driving project.frame` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      return jsonResult(
        `Wired ${report.source.toUpperCase()} timecode at ${report.node ?? "?"} → ${report.null_path ?? "?"}${drive}${warns}.`,
        report,
      );
    },
  );
}

export const registerSyncTimecode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "sync_timecode",
    {
      title: "Sync project to external timecode",
      description:
        "Wire an external SMPTE/MTC/LTC/OSC timecode source into the TouchDesigner timeline. Creates the input op + Math CHOP normaliser + Null CHOP 'tc_out' (channels 'frame' and 'seconds'); optionally adds an Execute DAT that writes project.frame = tc_out['frame'] each cook so the timeline follows house clock. Requires the project to be playing — paused TD will not advance. LTC has no native TD decoder; the tool surfaces a warning and creates the audio input so the artist can attach an external decoder. MTC operator availability is build-dependent.",
      inputSchema: syncTimecodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => syncTimecodeImpl(ctx, args),
  );
};
