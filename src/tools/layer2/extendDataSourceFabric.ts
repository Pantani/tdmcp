import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const extendDataSourceFabricSchema = z.object({
  transport: z
    .enum(["mqtt", "ws-binary", "midi-mmc"])
    .describe(
      "Which transport branch to build. 'mqtt' subscribes to a broker, 'ws-binary' streams binary frames over a WebSocket, 'midi-mmc' listens for MIDI Machine Control transport bytes.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to build the sub-network inside."),
  name: z.string().optional().describe("Base name for the created sub-network."),
  host: z
    .string()
    .default("127.0.0.1")
    .describe("(mqtt/ws-binary) Broker or WebSocket host. Ignored by midi-mmc."),
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("(mqtt/ws-binary) TCP port. Defaults: mqtt=1883, ws-binary=9001."),
  topic: z
    .string()
    .optional()
    .describe(
      "(mqtt) Subscription topic(s), comma-separated. (ws-binary) URL path, e.g. '/stream'.",
    ),
  username: z.string().optional().describe("(mqtt) Broker auth user."),
  password: z.string().optional().describe("(mqtt) Broker auth password."),
  tls: z.boolean().default(false).describe("(mqtt/ws-binary) Use TLS — flips mqtts:// or wss://."),
  device: z
    .string()
    .optional()
    .describe("(midi-mmc) MIDI input device name. Omit to use the first device."),
  frame_format: z
    .enum(["float32-le", "int16-le", "uint8"])
    .default("float32-le")
    .describe("(ws-binary) How each frame's bytes decode into numeric samples."),
  channels: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(4)
    .describe("(ws-binary) Number of numeric channels per frame to expose on the Null CHOP."),
  fields: z
    .array(z.string())
    .default(["value"])
    .describe(
      "(mqtt) JSON keys to extract from each message into the sample table → Null CHOP channels.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Surface an 'Active' toggle (and a 'Reconnect' pulse for mqtt/ws-binary)."),
});
type ExtendDataSourceFabricArgs = z.infer<typeof extendDataSourceFabricSchema>;

interface ExtendReport {
  transport: string;
  container?: string;
  source?: string;
  source_type?: string;
  null_chop?: string;
  null_dat?: string;
  channels?: string[];
  fields?: string[];
  controls?: string[];
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass builds a self-contained sub-network per transport. Mirrors createDataSource's
// downstream shape — Null DAT 'raw' + Null CHOP 'out' fed via a DAT-to-CHOP whose 'dat' parameter
// (not input wire — that's a CHOP-input gotcha) points at a 'sample' tableDAT seeded with the
// expected channel header so binders find named channels even before any sender appears. Operator
// type names are UNVERIFIED in the KB for some of these transports; the script attempts the
// documented type first and falls back to a Script/Web Client DAT alternative on failure, logging
// the substitution as a warning rather than aborting the whole build.
const EXTEND_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"transport": _p["transport"], "warnings": []}
try:
    _t = _p["transport"]; _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _base = _p.get("name") or ("data_source_" + _t.replace("-", "_"))
        _c = _parent.create(baseCOMP, _base)
        report["container"] = _c.path
        def _setpar(node, parname, val):
            if val is None:
                return
            pr = getattr(node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, node.type)); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s' on %s" % (parname, node.type))
        def _connect(src, dst):
            try:
                dst.inputConnectors[0].connect(src); return True
            except Exception:
                report["warnings"].append("Could not connect %s -> %s" % (src.name, dst.name)); return False
        def _try_create(types, label):
            for tname in types:
                try:
                    _tt = globals().get(tname)
                    if _tt is None:
                        continue
                    _node = _c.create(_tt, "src")
                    return _node
                except Exception:
                    report["warnings"].append("Operator type '%s' not creatable; trying fallback." % tname)
            report["warnings"].append("No source operator could be created for %s." % label)
            return None
        _controls = []
        _fields = [str(f) for f in (_p.get("fields") or ["value"])] or ["value"]
        _raw_dat = None; _null_chop = None; _src = None
        _scheme = "secure" if _p.get("tls") else "plain"
        if _t == "mqtt":
            _src = _try_create(["mqttclientDAT"], "mqtt")
            if _src is not None:
                report["source"] = _src.path; report["source_type"] = _src.type
                _setpar(_src, "address", _p.get("host"))
                _setpar(_src, "port", _p.get("port") or 1883)
                _setpar(_src, "username", _p.get("username"))
                _setpar(_src, "password", _p.get("password"))
                _setpar(_src, "protocol", "mqtts" if _p.get("tls") else "mqtt")
                _setpar(_src, "subscribe", _p.get("topic") or "tdmcp/#")
                _setpar(_src, "topic", _p.get("topic") or "tdmcp/#")
                _setpar(_src, "active", 1)
            _headers = _fields
            _sample = _c.create(tableDAT, "sample")
            _sample.clear()
            _sample.appendRow(_headers)
            _sample.appendRow(["0"] * len(_headers))
            _fields_lit = repr(_fields)
            _cb = _c.create(textDAT, "parse")
            _cb.text = (
                "import json\\n"
                "def onReceive(dat, topic, payload, qos, retained):\\n"
                "\\tfields = %s\\n"
                "\\tsample = dat.parent().op('sample')\\n"
                "\\tif sample is None:\\n"
                "\\t\\treturn\\n"
                "\\ttry:\\n"
                "\\t\\tif isinstance(payload, (bytes, bytearray)):\\n"
                "\\t\\t\\tpayload = payload.decode('utf-8', 'replace')\\n"
                "\\t\\tdata = json.loads(payload)\\n"
                "\\texcept Exception:\\n"
                "\\t\\treturn\\n"
                "\\tif not isinstance(data, dict):\\n"
                "\\t\\treturn\\n"
                "\\tsample.clear()\\n"
                "\\tsample.appendRow(fields)\\n"
                "\\tsample.appendRow([('%%.6f' %% float(data[f])) if f in data else '0' for f in fields])\\n"
                "\\treturn\\n"
            ) % _fields_lit
            if _src is not None:
                _setpar(_src, "callbacks", _cb.name)
        elif _t == "ws-binary":
            _src = _try_create(["websocketDAT", "webclientDAT"], "ws-binary")
            if _src is not None:
                report["source"] = _src.path; report["source_type"] = _src.type
                _setpar(_src, "netaddress", _p.get("host"))
                _setpar(_src, "address", _p.get("host"))
                _setpar(_src, "port", _p.get("port") or 9001)
                _setpar(_src, "path", _p.get("topic") or "/stream")
                _setpar(_src, "protocol", "wss" if _p.get("tls") else "ws")
                _setpar(_src, "mode", "websocket")
                _setpar(_src, "active", 1)
            _channels = int(_p.get("channels") or 4)
            _headers = ["ch%d" % i for i in range(_channels)]
            _sample = _c.create(tableDAT, "sample")
            _sample.clear()
            _sample.appendRow(_headers)
            _sample.appendRow(["0"] * _channels)
            _fmt = _p.get("frame_format") or "float32-le"
            _cb = _c.create(textDAT, "parse")
            _cb.text = (
                "import struct, base64\\n"
                "_FMT = %r\\n"
                "_CH = %d\\n"
                "def _decode(data):\\n"
                "\\tif data is None:\\n"
                "\\t\\treturn []\\n"
                "\\tif isinstance(data, str):\\n"
                "\\t\\ttry:\\n"
                "\\t\\t\\tdata = base64.b64decode(data)\\n"
                "\\t\\texcept Exception:\\n"
                "\\t\\t\\treturn []\\n"
                "\\tif _FMT == 'float32-le':\\n"
                "\\t\\tn = min(_CH, len(data)//4)\\n"
                "\\t\\treturn list(struct.unpack('<%%df' %% n, data[:4*n])) if n else []\\n"
                "\\tif _FMT == 'int16-le':\\n"
                "\\t\\tn = min(_CH, len(data)//2)\\n"
                "\\t\\tvals = struct.unpack('<%%dh' %% n, data[:2*n]) if n else ()\\n"
                "\\t\\treturn [v/32768.0 for v in vals]\\n"
                "\\tn = min(_CH, len(data))\\n"
                "\\treturn [b/255.0 for b in data[:n]]\\n"
                "def _write(dat, vals):\\n"
                "\\tsample = dat.parent().op('sample')\\n"
                "\\tif sample is None:\\n"
                "\\t\\treturn\\n"
                "\\theaders = ['ch%%d' %% i for i in range(_CH)]\\n"
                "\\tsample.clear()\\n"
                "\\tsample.appendRow(headers)\\n"
                "\\trow = [('%%.6f' %% vals[i]) if i < len(vals) else '0' for i in range(_CH)]\\n"
                "\\tsample.appendRow(row)\\n"
                "def onReceiveBytes(dat, data):\\n"
                "\\t_write(dat, _decode(data))\\n"
                "\\treturn\\n"
                "def onReceiveText(dat, data):\\n"
                "\\t_write(dat, _decode(data))\\n"
                "\\treturn\\n"
            ) % (_fmt, _channels)
            if _src is not None:
                _setpar(_src, "callbacks", _cb.name)
            _fields = _headers
        else:  # midi-mmc
            _src = _try_create(["midiinDAT"], "midi-mmc")
            if _src is not None:
                report["source"] = _src.path; report["source_type"] = _src.type
                _setpar(_src, "device", _p.get("device"))
                _setpar(_src, "format", "mmc")
                _setpar(_src, "sysex", 1)
                _setpar(_src, "active", 1)
            _headers = ["play", "stop", "record", "locate"]
            _sample = _c.create(tableDAT, "sample")
            _sample.clear()
            _sample.appendRow(_headers)
            _sample.appendRow(["0", "0", "0", "0"])
            _cb = _c.create(textDAT, "parse")
            _cb.text = (
                "def _pulse(sample, col):\\n"
                "\\theaders = ['play', 'stop', 'record', 'locate']\\n"
                "\\tsample.clear()\\n"
                "\\tsample.appendRow(headers)\\n"
                "\\tvals = ['0','0','0','0']\\n"
                "\\tif 0 <= col < 4:\\n"
                "\\t\\tvals[col] = '1'\\n"
                "\\tsample.appendRow(vals)\\n"
                "def _locate(sample, seconds):\\n"
                "\\theaders = ['play', 'stop', 'record', 'locate']\\n"
                "\\tsample.clear()\\n"
                "\\tsample.appendRow(headers)\\n"
                "\\tsample.appendRow(['0','0','0', '%.6f' % seconds])\\n"
                "def _handle_mmc(dat, payload):\\n"
                "\\tsample = dat.parent().op('sample')\\n"
                "\\tif sample is None or not payload:\\n"
                "\\t\\treturn\\n"
                "\\tsub = payload[0] if isinstance(payload, (bytes, bytearray, list)) else None\\n"
                "\\tif sub == 0x01:\\n"
                "\\t\\t_pulse(sample, 1)\\n"
                "\\telif sub == 0x02:\\n"
                "\\t\\t_pulse(sample, 0)\\n"
                "\\telif sub == 0x06:\\n"
                "\\t\\t_pulse(sample, 2)\\n"
                "\\telif sub == 0x44 and len(payload) >= 6:\\n"
                "\\t\\thh, mm, ss, ff = payload[2], payload[3], payload[4], payload[5]\\n"
                "\\t\\tseconds = hh*3600 + mm*60 + ss + ff/30.0\\n"
                "\\t\\t_locate(sample, seconds)\\n"
                "def onReceiveSysex(dat, data):\\n"
                "\\tif not data:\\n"
                "\\t\\treturn\\n"
                "\\tpayload = data[2:-1] if data[0] == 0xF0 and data[-1] == 0xF7 else data\\n"
                "\\t_handle_mmc(dat, payload[2:] if len(payload) >= 2 else payload)\\n"
                "\\treturn\\n"
                "def onReceive(dat, rowIndex, message, channel, index, value, input, bytes):\\n"
                "\\tif bytes:\\n"
                "\\t\\t_handle_mmc(dat, bytes)\\n"
                "\\treturn\\n"
            )
            if _src is not None:
                _setpar(_src, "callbacks", _cb.name)
            _fields = _headers
        if _src is not None:
            _raw_dat = _c.create(nullDAT, "raw"); _connect(_src, _raw_dat)
        _datto = _c.create(dattoCHOP, "datto")
        _setpar(_datto, "firstrow", "names")
        _setpar(_datto, "firstcolumn", "values")
        _setpar(_datto, "output", "chanpercol")
        # DAT-to-CHOP reads its source from the 'dat' parameter, not an input connector.
        _setpar(_datto, "dat", "sample")
        _null_chop = _c.create(nullCHOP, "out"); _connect(_datto, _null_chop)
        if _p.get("expose_controls") and _src is not None:
            try:
                _pg = _c.appendCustomPage("Controls")
                _ap = _pg.appendToggle("Active")[0]
                _ap.default = True; _ap.val = True
                _tp = getattr(_src.par, "active", None)
                if _tp is not None:
                    _tp.expr = "op(%r).par.Active" % _c.path
                    _tp.mode = type(_tp.mode).EXPRESSION
                _controls.append("Active")
                if _t in ("mqtt", "ws-binary"):
                    _rp = _pg.appendPulse("Reconnect")[0]
                    _rec = getattr(_src.par, "reconnect", None)
                    if _rec is not None:
                        # Note: pulse cross-binding is best-effort; fallback is manual toggle of active.
                        pass
                    _controls.append("Reconnect")
            except Exception:
                report["warnings"].append("Could not create the Controls page.")
        if _raw_dat is not None:
            report["null_dat"] = _raw_dat.path
        if _null_chop is not None:
            report["null_chop"] = _null_chop.path
            report["channels"] = [c.name for c in _null_chop.chans()]
        report["fields"] = _fields
        report["controls"] = _controls
        report["errors"] = [str(e) for e in _c.errors()][:3]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildExtendDataSourceFabricScript(payload: object): string {
  return buildPayloadScript(EXTEND_SCRIPT, payload);
}

export async function extendDataSourceFabricImpl(
  ctx: ToolContext,
  args: ExtendDataSourceFabricArgs,
) {
  return guardTd(
    async () => {
      const script = buildExtendDataSourceFabricScript({
        transport: args.transport,
        parent: args.parent_path,
        name: args.name ?? null,
        host: args.transport === "midi-mmc" ? null : args.host,
        port:
          args.transport === "midi-mmc"
            ? null
            : (args.port ?? (args.transport === "mqtt" ? 1883 : 9001)),
        topic: args.transport === "midi-mmc" ? null : (args.topic ?? null),
        username: args.transport === "mqtt" ? (args.username ?? null) : null,
        password: args.transport === "mqtt" ? (args.password ?? null) : null,
        tls: args.transport === "midi-mmc" ? false : args.tls,
        device: args.transport === "midi-mmc" ? (args.device ?? null) : null,
        frame_format: args.transport === "ws-binary" ? args.frame_format : null,
        channels: args.transport === "ws-binary" ? args.channels : null,
        fields: args.transport === "mqtt" ? args.fields : null,
        expose_controls: args.expose_controls,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ExtendReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(
          `Could not extend the data-source fabric for ${report.transport}: ${report.fatal}`,
          report,
        );
      }
      const chans = report.channels?.length ?? 0;
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const where = report.null_chop ? ` Bind to the Null CHOP at ${report.null_chop}.` : "";
      return jsonResult(
        `Extended the data-source fabric with a ${report.transport} branch at ${report.container} carrying ${chans} channel(s)${errs}${warns}.${where}`,
        report,
      );
    },
  );
}

export const registerExtendDataSourceFabric: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "extend_data_source_fabric",
    {
      title: "Extend data source fabric",
      description:
        "Adds extra transports to the data-source fabric beyond create_data_source: 'mqtt' subscribes to a broker, 'ws-binary' streams binary frames over a WebSocket, 'midi-mmc' listens for MIDI Machine Control transport bytes (play/stop/record/locate). Same downstream shape as create_data_source — a Null DAT for the raw text/bytes and a Null CHOP whose channels are ready for bind_to_channel / create_data_visualization.",
      inputSchema: extendDataSourceFabricSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => extendDataSourceFabricImpl(ctx, args),
  );
};
