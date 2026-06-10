import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const bindSchema = z.object({
  channel: z
    .string()
    .describe(
      "Channel name produced by the input (e.g. an OSC address tail 'fader1', or a MIDI channel name).",
    ),
  target: z.string().describe("Parameter to drive, written as 'nodePath.parName'."),
});

export const createExternalIoSchema = z.object({
  kind: z
    .enum([
      "osc_in",
      "midi_in",
      "keyboard_in",
      "gamepad_in",
      "mouse_in",
      "osc_out",
      "midi_out",
      "dmx_out",
      "artnet_out",
      "rtmp_out",
      "video_device_out",
      "ndi_in",
      "syphon_spout_in",
      "ndi_out",
      "syphon_spout_out",
    ])
    .describe(
      "What to bridge: OSC/MIDI/keyboard/gamepad/mouse input (a control surface — bind channels to parameters), OSC/MIDI output (send a CHOP's channels back out for bidirectional feedback — pass source_path), DMX/Art-Net output for lighting (dmx_out is the general DMX desk; artnet_out is a network-only Art-Net/sACN preset for pixel-mapping LED strips & stage fixtures — both send a CHOP's 0-255 channels and need source_path), RTMP output to live-stream a TOP to Twitch/YouTube/OBS-ingest (rtmp_out — pass source_path = the TOP to stream and url; needs an NVIDIA GPU on Windows), NDI / Syphon-Spout video input, or NDI / Syphon-Spout video output (ndi_out / syphon_spout_out — pass source_path = the TOP to send and an optional source_name for the NDI source / Spout sender name; flip active to start immediately). On Windows, Spout needs an NVIDIA or AMD GPU (no Intel).",
    ),
  parent_path: z.string().default("/project1").describe("COMP to create the I/O operator in."),
  name: z.string().optional().describe("Name for the I/O operator; auto-generated when omitted."),
  port: z.coerce
    .number()
    .int()
    .optional()
    .describe("(osc_in) UDP port to listen on / (osc_out) port to send to. Defaults to 7000."),
  normalize: z
    .enum(["off", "0to1", "-1to1", "onoff"])
    .default("0to1")
    .describe("(midi_in) How to scale incoming MIDI values."),
  bind_to: z
    .array(bindSchema)
    .optional()
    .describe(
      "(osc_in/midi_in) Map incoming channels to parameters. Each binding tolerates a channel that hasn't arrived yet (falls back to 0 instead of erroring).",
    ),
  source_path: z
    .string()
    .optional()
    .describe(
      "(dmx_out/artnet_out/osc_out/midi_out) CHOP whose channel values are sent out, or (rtmp_out / video_device_out / ndi_out / syphon_spout_out) the TOP to send. Should live in the same COMP as parent_path so the wire/source connects.",
    ),
  interface: z
    .enum(["artnet", "sacn", "enttecusbpro", "enttecusbpromk2", "serial", "kinet"])
    .default("artnet")
    .describe("(dmx_out) DMX transport. (artnet_out forces a network protocol via `net`.)"),
  net: z
    .enum(["artnet", "sacn"])
    .optional()
    .describe(
      "(artnet_out) Network DMX protocol: Art-Net or sACN (streaming ACN). Defaults to Art-Net.",
    ),
  universe: z.coerce.number().int().default(1).describe("(dmx_out/artnet_out) DMX universe."),
  net_address: z
    .string()
    .optional()
    .describe("(dmx_out/artnet_out) Target IP address for Art-Net / sACN."),
  url: z
    .string()
    .optional()
    .describe(
      "(rtmp_out) Full RTMP destination as {service url}/{stream key}, e.g. 'rtmp://live.twitch.tv/app/live_xxx'. If omitted but stream_key is given, prefix with rtmp_base.",
    ),
  rtmp_base: z
    .string()
    .optional()
    .describe(
      "(rtmp_out) Ingest base URL to combine with stream_key when url is not given (defaults to YouTube's primary ingest).",
    ),
  stream_key: z
    .string()
    .optional()
    .describe("(rtmp_out) Stream key, appended to rtmp_base as '{rtmp_base}/{stream_key}'."),
  fps: z.coerce.number().optional().describe("(rtmp_out) Frame rate to stream at. Defaults to 30."),
  active: z
    .boolean()
    .optional()
    .describe(
      "(rtmp_out/ndi_out/syphon_spout_out) Start sending immediately. Defaults off so the artist can confirm the destination/sender name first.",
    ),
  source_name: z
    .string()
    .optional()
    .describe(
      "(ndi_in/syphon_spout_in/ndi_out/syphon_spout_out) Name of the NDI source or Spout sender to receive or send, or (video_device_out) the SDI/capture-card output device name. For outputs, defaults to the operator name when omitted.",
    ),
});
type CreateExternalIoArgs = z.infer<typeof createExternalIoSchema>;

interface IoReport {
  kind: string;
  node?: string;
  type?: string;
  source?: string;
  bound?: Array<{ channel: string; target: string }>;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass creates and configures the right operator per kind. Control-surface
// inputs (OSC/MIDI) bind channels to parameters with a guard so a channel that hasn't
// arrived yet evaluates to 0 instead of leaving the target in an error state. The
// expression-mode enum is derived from a live parameter (`ParMode` is not in scope here).
const IO_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"kind": _p["kind"], "warnings": []}
_TYPEMAP = {"osc_in": oscinCHOP, "midi_in": midiinCHOP, "keyboard_in": keyboardinCHOP, "gamepad_in": joystickCHOP, "mouse_in": mouseinCHOP, "osc_out": oscoutCHOP, "midi_out": midioutCHOP, "dmx_out": dmxoutCHOP, "artnet_out": dmxoutCHOP, "rtmp_out": videostreamoutTOP, "video_device_out": videodeviceoutTOP, "ndi_in": ndiinTOP, "syphon_spout_in": syphonspoutinTOP, "ndi_out": ndioutTOP, "syphon_spout_out": syphonspoutoutTOP}
try:
    _kind = _p["kind"]; _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _name = _p.get("name")
        _node = _parent.create(_TYPEMAP[_kind], _name) if _name else _parent.create(_TYPEMAP[_kind])
        report["node"] = _node.path; report["type"] = _node.type
        def _setpar(parname, val):
            if val is None:
                return
            pr = getattr(_node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, _node.type)); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s'" % parname)
        def _connect_source():
            _src = _p.get("source")
            _what = "the TOP to send" if _kind in ("rtmp_out", "ndi_out", "syphon_spout_out", "video_device_out") else "the CHOP whose channels to send"
            if not _src:
                report["warnings"].append("This kind needs a source_path (%s)." % _what); return
            _s = op(_src)
            if _s is None:
                report["warnings"].append("Source operator not found: " + _src); return
            try:
                _node.inputConnectors[0].connect(_s); report["source"] = _s.path
            except Exception:
                report["warnings"].append("Could not connect source " + _src)
        if _kind == "osc_in":
            _setpar("port", _p.get("port"))
        elif _kind == "midi_in":
            _setpar("norm", _p.get("normalize"))
        elif _kind == "osc_out":
            _setpar("netaddress", _p.get("net_address") or "127.0.0.1"); _setpar("port", _p.get("port"))
            _connect_source()
        elif _kind == "midi_out":
            _connect_source()
        elif _kind == "dmx_out":
            _setpar("interface", _p.get("interface")); _setpar("universe", _p.get("universe")); _setpar("netaddress", _p.get("net_address"))
            _connect_source()
        elif _kind == "artnet_out":
            _setpar("interface", _p.get("net")); _setpar("universe", _p.get("universe")); _setpar("netaddress", _p.get("net_address"))
            _connect_source()
        elif _kind == "rtmp_out":
            _setpar("mode", "rtmpsender"); _setpar("url", _p.get("url")); _setpar("fps", _p.get("fps"))
            _connect_source()
            _setpar("active", _p.get("active"))
        elif _kind == "video_device_out":
            _connect_source()
            # The device-selector par name varies by build/driver — probe a few spellings.
            _dev = _p.get("source_name")
            if _dev:
                for _dpn in ["device", "outputdevice", "devicename"]:
                    pr = getattr(_node.par, _dpn, None)
                    if pr is not None:
                        try:
                            pr.val = _dev
                            break
                        except Exception:
                            pass
                else:
                    report["warnings"].append("Could not set output device (tried device/outputdevice/devicename) — driver/build-dependent.")
        elif _kind == "ndi_in":
            _setpar("name", _p.get("source_name"))
        elif _kind == "syphon_spout_in":
            _setpar("sendername", _p.get("source_name"))
        elif _kind == "ndi_out":
            _connect_source()
            # KB: NDI Out TOP par "name" (Source Name). Default = node name if not given.
            _setpar("name", _p.get("source_name") or _node.name)
            _setpar("active", _p.get("active"))
        elif _kind == "syphon_spout_out":
            _connect_source()
            # KB: Syphon Spout Out TOP par "sendername" (Sender Name). Default = node name.
            _setpar("sendername", _p.get("source_name") or _node.name)
            _setpar("active", _p.get("active"))
        _bound = []
        if _kind in ("osc_in", "midi_in", "keyboard_in", "gamepad_in", "mouse_in"):
            for _b in (_p.get("bind_to") or []):
                try:
                    _ch = _b["channel"]; _t = _b["target"]; _dot = _t.rfind(".")
                    if _dot <= 0:
                        report["warnings"].append("Invalid bind target '%s' (expected 'nodePath.parName')." % _t); continue
                    _np = _t[:_dot]; _pn = _t[_dot + 1:]; _tn = op(_np)
                    if _tn is None:
                        report["warnings"].append("Bind target node not found: " + _np); continue
                    _tp = getattr(_tn.par, _pn, None)
                    if _tp is None:
                        report["warnings"].append("Bind target parameter not found: %s.%s" % (_np, _pn)); continue
                    _expr = "op(%r)[%r] if %r in [c.name for c in op(%r).chans()] else 0" % (_node.path, _ch, _ch, _node.path)
                    _PM = type(_tp.mode); _tp.expr = _expr; _tp.mode = _PM.EXPRESSION
                    _bound.append({"channel": _ch, "target": _np + "." + _pn})
                except Exception:
                    report["warnings"].append("Bind failed: " + traceback.format_exc().splitlines()[-1])
        report["bound"] = _bound
        report["errors"] = [str(e) for e in _node.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildIoScript(payload: object): string {
  return buildPayloadScript(IO_SCRIPT, payload);
}

export async function createExternalIoImpl(ctx: ToolContext, args: CreateExternalIoArgs) {
  return guardTd(
    async () => {
      // Compose the RTMP destination: an explicit url wins, otherwise stitch the
      // ingest base to the stream key (the Video Stream Out TOP wants one combined URL).
      const rtmpUrl =
        args.kind === "rtmp_out"
          ? (args.url ??
            (args.stream_key
              ? `${args.rtmp_base ?? "rtmp://a.rtmp.youtube.com/live2"}/${args.stream_key}`
              : null))
          : null;
      const script = buildIoScript({
        kind: args.kind,
        parent: args.parent_path,
        name: args.name ?? null,
        port: args.kind === "osc_in" || args.kind === "osc_out" ? (args.port ?? 7000) : null,
        normalize: args.normalize,
        bind_to: args.bind_to ?? null,
        source: args.source_path ?? null,
        interface: args.interface,
        net: args.net ?? "artnet",
        universe: args.universe,
        net_address: args.net_address ?? null,
        url: rtmpUrl,
        fps: args.kind === "rtmp_out" ? (args.fps ?? 30) : null,
        active:
          args.kind === "rtmp_out" || args.kind === "ndi_out" || args.kind === "syphon_spout_out"
            ? (args.active ?? false)
            : null,
        source_name: args.source_name ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<IoReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create ${report.kind}: ${report.fatal}`, report);
      }
      const bound = report.bound?.length ? `, ${report.bound.length} binding(s)` : "";
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      return jsonResult(
        `Created ${report.kind} (${report.type}) at ${report.node}${bound}${errs}${warns}.`,
        report,
      );
    },
  );
}

export const registerCreateExternalIo: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_external_io",
    {
      title: "Create external I/O",
      description:
        "Bridge TouchDesigner to the outside world: OSC/MIDI input (a control surface — bind incoming channels straight to parameters), OSC/MIDI output (send a CHOP's channels back out for bidirectional feedback to lighting desks, other apps or hardware — pass source_path), DMX/Art-Net output for lighting (dmx_out for any DMX desk; artnet_out for network Art-Net/sACN pixel-mapping of LED strips & stage fixtures), RTMP output to live-stream a TOP to Twitch/YouTube/OBS (rtmp_out — NVIDIA GPU on Windows only), or NDI / Syphon-Spout video input. To discover which channel a control sends (a 'MIDI learn'), wiggle it and read the input CHOP with get_td_nodes, then bind_to that channel. Validate live where possible, but real signal needs the hardware/sender present.",
      inputSchema: createExternalIoSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createExternalIoImpl(ctx, args),
  );
};
