import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createDetectionReactiveSchema = z.object({
  name: z.string().default("detection").describe("Base name for the container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the detection container in (default '/project1')."),
  source: z
    .enum(["websocket", "onnx"])
    .default("websocket")
    .describe(
      "Detector backend. 'websocket' subscribes to an external detector process that streams JSON detections (no CUDA needed, runs anywhere). 'onnx' scaffolds a Script CHOP that runs an ONNX model via onnxruntime on the CPU inside TouchDesigner — you fill in the model path + inference.",
    ),
  url: z
    .string()
    .default("ws://127.0.0.1:8765")
    .describe(
      '(websocket) URL of the external detector\'s WebSocket. It should send JSON objects like {"count": N, "objects": [{"x":..,"y":..,"w":..,"h":..,"score":..}]}.',
    ),
  model_path: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "(onnx) Filesystem path to the .onnx model to load in the Script CHOP (CPU inference).",
    ),
  input_top: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "(onnx) Absolute path of the TOP to read frames from for inference. Pulled via a Select TOP.",
    ),
  max_objects: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .describe("Number of detected objects (bboxes) to expose as channels (obj1_x, obj1_y, …)."),
  reconnect_seconds: z.coerce
    .number()
    .min(0.1)
    .max(60)
    .default(2)
    .describe("(websocket) Auto-reconnect interval if the detector connection drops."),
});

export type CreateDetectionReactiveArgs = z.infer<typeof createDetectionReactiveSchema>;

interface DetectionReactiveReport {
  container: string;
  source: string;
  source_type: string;
  channels_null: string;
  channels: string[];
  select?: string;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass. Builds a container whose output is a Null CHOP carrying detection
// channels: presence (0/1), count, and per-object bbox (objN_x/y/w/h/score) in normalized
// coords. Two source backends:
//   websocket -> a websocketDAT feeds a callbacks DAT that parses JSON and stores it; a
//                Script CHOP reads the store each cook and emits the channels. No CUDA.
//   onnx      -> a Script CHOP scaffold that (once you add the model + inference) reads an
//                input TOP via numpy and writes the same channels; onnxruntime CPU only.
// Fail-forward: any step failure becomes a warning, not a fatal.
const DETECTION_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": "", "source": "", "source_type": "", "channels_null": "", "channels": [], "errors": [], "warnings": []}

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

# Position a node in the network editor (nodeX/nodeY are attributes, not params) so the
# generated network reads left->right instead of stacking at the default drop point.
def _place(_op, _x, _y):
    if _op is None:
        return
    try:
        _op.nodeX = _x
        _op.nodeY = _y
    except Exception:
        pass

# Script CHOP/SOP/TOP cook code lives in a companion callbacks DAT, resolved via the op's
# 'callbacks' par (with a name-based fallback). Set THAT DAT's text, never the op's.
def _set_script_cook(_op, _text):
    _cb = None
    try:
        _cb = _op.par.callbacks.eval()
    except Exception:
        _cb = None
    if _cb is None:
        try:
            _cb = _op.parent().op(_op.name + '_callbacks')
        except Exception:
            _cb = None
    if _cb is None:
        # Create a Text DAT and wire it as the callbacks source.
        _cb = _try("callbacks dat", lambda: _op.parent().create(textDAT, _op.name + '_callbacks'))
        if _cb is not None:
            _try("callbacks par", lambda: setattr(_op.par, "callbacks", _cb.name))
    if _cb is None:
        report["warnings"].append("Could not resolve callbacks DAT for " + _op.path)
        return
    _try("callbacks text", lambda: setattr(_cb, "text", _text))

_max = int(_p["max_objects"])
_chan_names = ["presence", "count"]
for _i in range(1, _max + 1):
    _chan_names += ["obj%d_x" % _i, "obj%d_y" % _i, "obj%d_w" % _i, "obj%d_h" % _i, "obj%d_score" % _i]
report["channels"] = _chan_names

# Body of the Script CHOP's onCook — reads the stored detection JSON (websocket) and emits
# normalized channels. The onnx variant keeps the same output contract but with a TODO.
_WS_COOK = '''# tdmcp detection_reactive (websocket) — emits detection channels from stored JSON.
MAXO = %d
NAMES = %s
def onCook(scriptOp):
    scriptOp.clear()
    p = scriptOp.parent()
    data = p.fetch('tdmcp_det', {}) if hasattr(p, 'fetch') else {}
    objs = data.get('objects', []) if isinstance(data, dict) else []
    count = int(data.get('count', len(objs))) if isinstance(data, dict) else 0
    vals = {'presence': 1.0 if count > 0 else 0.0, 'count': float(count)}
    for i in range(1, MAXO + 1):
        o = objs[i - 1] if i - 1 < len(objs) else {}
        vals['obj%%d_x' %% i] = float(o.get('x', 0.0))
        vals['obj%%d_y' %% i] = float(o.get('y', 0.0))
        vals['obj%%d_w' %% i] = float(o.get('w', 0.0))
        vals['obj%%d_h' %% i] = float(o.get('h', 0.0))
        vals['obj%%d_score' %% i] = float(o.get('score', 0.0))
    for n in NAMES:
        c = scriptOp.appendChan(n)
        c[0] = vals.get(n, 0.0)
    return
'''

_ONNX_COOK = '''# tdmcp detection_reactive (onnx) — CPU inference scaffold.
# Requires: onnxruntime installed in TouchDesigner's Python. Model: %s
# Reads frames from the 'frames' Select TOP (op('frames').numpyArray()) and must emit the
# same channels as the websocket path. Fill in the inference + post-processing below.
MAXO = %d
NAMES = %s
_sess = None
def _load():
    global _sess
    if _sess is not None:
        return _sess
    try:
        import onnxruntime as ort
        _sess = ort.InferenceSession(%r, providers=['CPUExecutionProvider'])
    except Exception as e:
        _sess = False
    return _sess
def onCook(scriptOp):
    scriptOp.clear()
    # TODO: sess = _load(); frames = op('frames').numpyArray(); run inference; parse boxes.
    # For now emit a zeroed contract so downstream binds resolve cleanly.
    vals = {'presence': 0.0, 'count': 0.0}
    for i in range(1, MAXO + 1):
        for suf in ('x', 'y', 'w', 'h', 'score'):
            vals['obj%%d_%%s' %% (i, suf)] = 0.0
    for n in NAMES:
        c = scriptOp.appendChan(n)
        c[0] = vals.get(n, 0.0)
    return
'''

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _c = _parent.create(baseCOMP, _p["name"])
        report["container"] = _c.path
        # detect (scriptCHOP) sits in the middle column; the source feeds it from the left
        # and the detections null exits to the right.
        _script = _try("script chop", lambda: _c.create(scriptCHOP, "detect"))
        _place(_script, 200, 0)

        if _p["source"] == "websocket":
            _ws = _try("ws dat", lambda: _c.create(websocketDAT, "detector_ws"))
            if _ws is not None:
                _place(_ws, 0, 0)
                report["source"] = _ws.path; report["source_type"] = _ws.type
                # websocketDAT uses netaddress + port (parsed from the ws:// URL in TS).
                if _p.get("ws_host"):
                    _try("ws netaddress", lambda: setattr(_ws.par, "netaddress", _p["ws_host"]))
                if _p.get("ws_port"):
                    _try("ws port", lambda: setattr(_ws.par, "port", int(_p["ws_port"])))
                _try("ws active", lambda: setattr(_ws.par, "active", 1))
                # Auto-reconnect: par names vary by TD build, so probe fail-forward.
                if hasattr(_ws.par, "reconnect"):
                    _try("ws reconnect", lambda: setattr(_ws.par, "reconnect", 1))
                if hasattr(_ws.par, "reconnectinterval"):
                    _try("ws reconnectinterval", lambda: setattr(_ws.par, "reconnectinterval", float(_p.get("reconnect_seconds", 2))))
                _cb = _try("ws callbacks dat", lambda: _c.create(textDAT, "detector_cb"))
                if _cb is not None:
                    _place(_cb, 0, -140)
                    _cb_text = (
                        "import json\\n"
                        "def onReceiveText(websocketDAT, rowIndex, message):\\n"
                        "    c = websocketDAT.parent()\\n"
                        "    try:\\n"
                        "        c.store('tdmcp_det', json.loads(message))\\n"
                        "    except Exception:\\n"
                        "        pass\\n"
                        "def onConnect(websocketDAT):\\n"
                        "    websocketDAT.parent().store('tdmcp_ws_status', 'connected')\\n"
                        "def onDisconnect(websocketDAT):\\n"
                        "    websocketDAT.parent().store('tdmcp_ws_status', 'disconnected')\\n"
                    )
                    _try("cb text", lambda: setattr(_cb, "text", _cb_text))
                    _try("ws callbacks par", lambda: setattr(_ws.par, "callbacks", _cb.name))
            if _script is not None:
                _cook = _WS_COOK % (_max, repr(_chan_names))
                _set_script_cook(_script, _cook)
        else:
            # onnx
            if _p.get("input_top"):
                _sel = _try("select top", lambda: _c.create(selectTOP, "frames"))
                if _sel is not None:
                    _place(_sel, 0, 0)
                    _try("select top par", lambda: setattr(_sel.par, "top", _p["input_top"]))
                    report["select"] = _sel.path
            report["source"] = _script.path if _script is not None else ""
            report["source_type"] = "scriptCHOP(onnx)"
            if _script is not None:
                _mp = _p.get("model_path") or "<set model_path>"
                _cook = _ONNX_COOK % (_mp, _max, repr(_chan_names), _p.get("model_path") or "")
                _set_script_cook(_script, _cook)

        _null = _try("null chop", lambda: _c.create(nullCHOP, "detections"))
        if _null is not None:
            _place(_null, 400, 0)
            if _script is not None:
                _try("null connect", lambda: _null.inputConnectors[0].connect(_script))
                report["channels_null"] = _null.path
        try:
            if _script is not None:
                report["errors"] = [str(e) for e in _script.errors()][:3]
        except Exception:
            pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDetectionReactiveScript(payload: object): string {
  return buildPayloadScript(DETECTION_SCRIPT, payload);
}

/** Parse a ws://host:port URL into a bare host + numeric port for the websocketDAT. */
export function parseWsUrl(url: string): { host: string; port: number } {
  const stripped = url.replace(/^wss?:\/\//i, "").replace(/\/.*$/, "");
  const [host, portStr] = stripped.split(":");
  const port = Number.parseInt(portStr ?? "", 10);
  return { host: host || "127.0.0.1", port: Number.isFinite(port) ? port : 80 };
}

export async function createDetectionReactiveImpl(
  ctx: ToolContext,
  args: CreateDetectionReactiveArgs,
) {
  // websocketDAT wants a bare host + port, not a ws:// URL. Parse leniently.
  const { host: wsHost, port: wsPort } = parseWsUrl(args.url);
  return guardTd(
    async () => {
      const script = buildDetectionReactiveScript({
        parent_path: args.parent_path,
        name: args.name,
        source: args.source,
        url: args.url,
        ws_host: wsHost,
        ws_port: wsPort,
        model_path: args.model_path,
        input_top: args.input_top,
        max_objects: args.max_objects,
        reconnect_seconds: args.reconnect_seconds,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DetectionReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Detection-reactive build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const backend =
        report.source_type.includes("onnx") || report.source_type.includes("script")
          ? "ONNX (CPU)"
          : "external WebSocket detector";
      const summary = `Built a detection-reactive network (${backend}) → ${report.channels_null || "detections"} exposing ${report.channels.length} channels (presence, count, obj*_x/y/w/h/score)${warnNote}. Bind params to op('${report.channels_null}')['presence'] / ['count'] / ['obj1_x'] etc. with bind_to_channel.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateDetectionReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_detection_reactive",
    {
      title: "Create object/person detection → parameters",
      description:
        "Turn object/person detection into TouchDesigner control channels — with NO CUDA requirement. Two backends: 'websocket' subscribes to an external detector process that streams JSON detections over a WebSocket (runs on any machine/GPU, or none), and 'onnx' scaffolds a CPU Script CHOP that runs an .onnx model via onnxruntime inside TD. Either way the output is a Null CHOP carrying a stable contract — presence (0/1), count, and per-object normalized bboxes (obj1_x, obj1_y, obj1_w, obj1_h, obj1_score, …) — ready for bind_to_channel. (Detection idea inspired by TDYolo, MIT-licensed; no code copied.)",
      inputSchema: createDetectionReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDetectionReactiveImpl(ctx, args),
  );
};
