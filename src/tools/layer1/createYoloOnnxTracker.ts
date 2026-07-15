import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const YOLO_BACKENDS = [
  "external_websocket",
  "onnx_script",
  "ndi_detections",
  "file_watch",
] as const;

export const createYoloOnnxTrackerSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP that will receive the YOLO/ONNX tracker container."),
  name: z
    .string()
    .default("yolo_onnx_tracker")
    .describe("Container name for the tracker scaffold under parent_path."),
  input_top_path: z
    .string()
    .optional()
    .describe("Optional source TOP path pulled into the container through a Select TOP."),
  backend: z
    .enum(YOLO_BACKENDS)
    .default("external_websocket")
    .describe("Detection transport or runtime scaffold to build."),
  server_url: z
    .string()
    .default("ws://127.0.0.1:8766")
    .describe("External WebSocket detector URL used by external_websocket mode."),
  model_path: z.string().optional().describe("ONNX model path documented by onnx_script mode."),
  class_filter: z
    .array(z.string())
    .default([])
    .describe("Optional class names the external detector or ONNX postprocess should keep."),
  max_objects: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16)
    .describe("Maximum tracked object slots exposed as stable CHOP channels."),
  confidence_threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe("Minimum detection confidence expected from the detector or postprocess."),
  active: z
    .boolean()
    .default(false)
    .describe("Start live receiver operators active. Default is off until validation."),
});

type CreateYoloOnnxTrackerArgs = z.infer<typeof createYoloOnnxTrackerSchema>;
type YoloBackend = CreateYoloOnnxTrackerArgs["backend"];

export interface YoloOnnxTrackerReport {
  container_path?: string;
  backend?: YoloBackend;
  server_url?: string;
  model_path?: string | null;
  input_top_path?: string | null;
  class_filter?: string[];
  max_objects?: number;
  confidence_threshold?: number;
  active?: boolean;
  output_paths?: {
    detections_dat: string;
    tracks_out: string;
    annotated_out: string;
  };
  nodes?: Record<string, string>;
  channels?: string[];
  warnings: string[];
  errors?: string[];
  fatal?: string;
}

const YOLO_ONNX_TRACKER_SCRIPT = `
import json, base64, traceback
from urllib.parse import urlparse

_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "errors": [], "nodes": {}, "channels": []}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, col, row):
    if node is None:
        return
    x = int(col * 260)
    y = int(row * -160)
    try:
        node.nodeX = x
        node.nodeY = y
    except Exception:
        pass
    _place_generated_callbacks(node, x + 120, y - 100)

def _place_abs(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass
    _place_generated_callbacks(node, float(x) + 120.0, float(y) - 100.0)

def _place_generated_callbacks(node, x, y):
    try:
        callback = node.parent().op(node.name + "_callbacks")
        if callback is not None and callback.path != node.path:
            callback.nodeX = float(x)
            callback.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0):
    try:
        occupied = set()
        for child in parent.children:
            try:
                if abs(float(child.nodeY) - float(y)) < 1.0:
                    occupied.add(round(float(child.nodeX) / step) * step)
            except Exception:
                continue
        x = float(start)
        while round(x / step) * step in occupied:
            x += step
        return x
    except Exception:
        return float(start)

def _or_create(parent, name, op_type):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(op_type, name)

def _setpar(node, par_name, value, warn=True):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        if warn:
            _warn("No parameter '%s' on %s" % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        if warn:
            _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _setpar_any(node, names, value):
    for name in names:
        if _setpar(node, name, value, warn=False):
            return True
    _warn(
        "Could not find any of parameters %s on %s"
        % (", ".join(names), getattr(node, "path", node))
    )
    return False

def _connect(src, dst, input_index=0):
    if src is None or dst is None:
        return False
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (src.name, dst.name, exc))
        return False

def _record(key, node):
    if node is not None:
        report["nodes"][key] = node.path

def _write_table(dat, rows):
    if dat is None:
        return
    try:
        dat.clear()
    except Exception:
        pass
    for row in rows:
        try:
            dat.appendRow(row)
        except Exception as exc:
            _warn("Could not append row to %s: %s" % (getattr(dat, "path", dat), exc))
            break

def _set_callbacks(node, callback_dat):
    if node is None or callback_dat is None:
        return
    if not _setpar(node, "callbacks", callback_dat.name, warn=False):
        _setpar(node, "callbacksdat", callback_dat.name, warn=False)

def _channels(max_objects):
    names = []
    for idx in range(max_objects):
        names.extend(
            [
                "obj%d_present" % idx,
                "obj%d_x" % idx,
                "obj%d_y" % idx,
                "obj%d_w" % idx,
                "obj%d_h" % idx,
                "obj%d_score" % idx,
            ]
        )
    return names

def _tracks_cook_text(channels, max_objects):
    return """# tdmcp YOLO/ONNX tracker stable channel contract.
CHANNELS = %r
MAX_OBJECTS = %d
def _num(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default
def onCook(scriptOp):
    scriptOp.clear()
    parent = scriptOp.parent()
    objects = parent.fetch('tdmcp_yolo_tracks', []) if hasattr(parent, 'fetch') else []
    if not isinstance(objects, list):
        objects = []
    values = {}
    for idx in range(MAX_OBJECTS):
        obj = objects[idx] if idx < len(objects) and isinstance(objects[idx], dict) else {}
        values['obj%%d_present' %% idx] = 1.0 if obj else 0.0
        values['obj%%d_x' %% idx] = _num(obj.get('x', 0.0))
        values['obj%%d_y' %% idx] = _num(obj.get('y', 0.0))
        values['obj%%d_w' %% idx] = _num(obj.get('w', 0.0))
        values['obj%%d_h' %% idx] = _num(obj.get('h', 0.0))
        values['obj%%d_score' %% idx] = _num(obj.get('score', obj.get('confidence', 0.0)))
    for name in CHANNELS:
        chan = scriptOp.appendChan(name)
        chan[0] = values.get(name, 0.0)
    return
""" % (channels, max_objects)

def _websocket_callbacks_text(max_objects, confidence, class_filter):
    return """# tdmcp YOLO tracker WebSocket callbacks.
import json
MAX_OBJECTS = %d
CONFIDENCE_THRESHOLD = %r
CLASS_FILTER = set(%r)
def _objects(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    return payload.get('objects') or payload.get('detections') or payload.get('boxes') or []
def _score(obj):
    try:
        return float(obj.get('score', obj.get('confidence', 0.0)))
    except Exception:
        return 0.0
def onReceiveText(websocketDAT, rowIndex, message):
    parent = websocketDAT.parent()
    raw = parent.op('detections_raw')
    if raw is not None:
        raw.text = message
    detections = parent.op('detections')
    try:
        payload = json.loads(message)
        rows = [['id', 'class', 'score', 'x', 'y', 'w', 'h']]
        kept = []
        for idx, obj in enumerate(_objects(payload)):
            if not isinstance(obj, dict):
                continue
            label = str(obj.get('class', obj.get('label', 'object')))
            score = _score(obj)
            if score < CONFIDENCE_THRESHOLD:
                continue
            if CLASS_FILTER and label not in CLASS_FILTER:
                continue
            kept.append(obj)
            rows.append([
                str(obj.get('id', idx)),
                label,
                str(score),
                str(obj.get('x', 0.0)),
                str(obj.get('y', 0.0)),
                str(obj.get('w', 0.0)),
                str(obj.get('h', 0.0)),
            ])
            if len(kept) >= MAX_OBJECTS:
                break
        if detections is not None:
            detections.clear()
            for row in rows:
                detections.appendRow(row)
        parent.store('tdmcp_yolo_tracks', kept)
    except Exception:
        parent.store('tdmcp_yolo_tracks', [])
def onConnect(websocketDAT):
    websocketDAT.parent().store('tdmcp_yolo_status', 'connected')
def onDisconnect(websocketDAT):
    websocketDAT.parent().store('tdmcp_yolo_status', 'disconnected')
""" % (max_objects, confidence, class_filter)

def _onnx_callbacks_text(channels, max_objects, model_path, confidence, class_filter):
    model_note = model_path or "<set model_path>"
    return """# tdmcp YOLO ONNX Script CHOP scaffold.
# Requires onnxruntime installed in TouchDesigner's Python environment.
# Model path: %s
# Expected postprocess contract: id,class,score,x,y,w,h in normalized coordinates.
CHANNELS = %r
MAX_OBJECTS = %d
MODEL_PATH = %r
CONFIDENCE_THRESHOLD = %r
CLASS_FILTER = %r
_session = None
def _load_session():
    global _session
    if _session is not None:
        return _session
    try:
        import onnxruntime as ort
        _session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    except Exception:
        _session = False
    return _session
def onCook(scriptOp):
    scriptOp.clear()
    # TODO: frames = op('source_in').numpyArray(); preprocess for the selected YOLO model;
    # run _load_session(); filter by CONFIDENCE_THRESHOLD and CLASS_FILTER; write rows to
    # op('detections') and parent.store('tdmcp_yolo_tracks', objects).
    for name in CHANNELS:
        chan = scriptOp.appendChan(name)
        chan[0] = 0.0
    return
""" % (model_note, channels, max_objects, model_path or "", confidence, class_filter)

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        name = _p.get("name") or "yolo_onnx_tracker"
        backend = _p.get("backend", "external_websocket")
        max_objects = int(_p.get("max_objects", 16))
        channels = _channels(max_objects)
        report["channels"] = channels

        comp = parent.op(name)
        if comp is None:
            comp = parent.create(baseCOMP, name)
        _place_abs(comp, _free_x(parent, -180), -180)
        report["container_path"] = comp.path
        _record("container", comp)

        report["backend"] = backend
        report["server_url"] = _p.get("server_url")
        report["model_path"] = _p.get("model_path")
        report["input_top_path"] = _p.get("input_top_path")
        report["class_filter"] = _p.get("class_filter") or []
        report["max_objects"] = max_objects
        report["confidence_threshold"] = float(_p.get("confidence_threshold", 0.35))
        report["active"] = bool(_p.get("active", False))

        source_path = _p.get("input_top_path")
        if source_path:
            source = _or_create(comp, "source_in", selectTOP)
            _setpar(source, "top", source_path)
        else:
            source = _or_create(comp, "source_in", noiseTOP)
            _setpar(source, "monochrome", 0, warn=False)
            _warn("No input_top_path provided; source_in is a Noise TOP scaffold.")
        _place(source, 0, 0)
        _record("source_in", source)

        detections = _or_create(comp, "detections", tableDAT)
        _place(detections, 2, 0)
        _write_table(detections, [["id", "class", "score", "x", "y", "w", "h"]])
        _record("detections_dat", detections)

        tracks = _or_create(comp, "tracks", tableDAT)
        _place(tracks, 2, 1)
        _write_table(tracks, [["channel", "value"]] + [[name, 0.0] for name in channels])
        _record("tracks", tracks)

        tracks_script = _or_create(comp, "tracks_script", scriptCHOP)
        _place(tracks_script, 3, 1)
        tracks_callbacks = _or_create(comp, "tracks_callbacks", textDAT)
        _place(tracks_callbacks, 3, 2)
        tracks_callbacks.text = _tracks_cook_text(channels, max_objects)
        _set_callbacks(tracks_script, tracks_callbacks)
        _record("tracks_script", tracks_script)
        _record("tracks_callbacks", tracks_callbacks)

        tracks_out = _or_create(comp, "tracks_out", nullCHOP)
        _place(tracks_out, 4, 1)
        _connect(tracks_script, tracks_out)
        _record("tracks_out", tracks_out)

        annotated_out = _or_create(comp, "annotated_out", nullTOP)
        _place(annotated_out, 4, 0)
        _connect(source, annotated_out)
        _record("annotated_out", annotated_out)

        if backend == "external_websocket":
            raw = _or_create(comp, "detections_raw", textDAT)
            _place(raw, 1, 1)
            raw.text = (
                "Waiting for YOLO JSON over WebSocket. Expected objects: "
                "id,class,score,x,y,w,h."
            )
            _record("detections_raw", raw)

            ws = _or_create(comp, "detector_ws", websocketDAT)
            _place(ws, 1, 0)
            parsed = urlparse(_p.get("server_url") or "ws://127.0.0.1:8766")
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or (443 if parsed.scheme == "wss" else 80)
            _setpar(ws, "netaddress", host)
            _setpar(ws, "port", int(port))
            _setpar(ws, "active", 1 if _p.get("active") else 0, warn=False)
            _record("detector_ws", ws)

            callbacks = _or_create(comp, "detector_callbacks", textDAT)
            _place(callbacks, 1, 2)
            callbacks.text = _websocket_callbacks_text(
                max_objects,
                float(_p.get("confidence_threshold", 0.35)),
                _p.get("class_filter") or [],
            )
            _set_callbacks(ws, callbacks)
            _record("detector_callbacks", callbacks)
            _warn(
                "external_websocket requires a separately running detector that streams "
                "YOLO-style JSON detections to the configured WebSocket URL."
            )
        elif backend == "onnx_script":
            runner = _or_create(comp, "onnx_runner", scriptCHOP)
            _place(runner, 1, 0)
            callbacks = _or_create(comp, "onnx_callbacks", textDAT)
            _place(callbacks, 1, 1)
            callbacks.text = _onnx_callbacks_text(
                channels,
                max_objects,
                _p.get("model_path"),
                float(_p.get("confidence_threshold", 0.35)),
                _p.get("class_filter") or [],
            )
            _set_callbacks(runner, callbacks)
            _record("onnx_runner", runner)
            _record("onnx_callbacks", callbacks)
            if not _p.get("model_path"):
                _warn("onnx_script selected without model_path; set it before live validation.")
            _warn(
                "onnx_script is a scaffold only; install onnxruntime in TouchDesigner Python "
                "and validate model preprocessing/postprocessing live."
            )
        elif backend == "ndi_detections":
            ndi = _or_create(comp, "ndi_detections_in", ndiinTOP)
            _place(ndi, 1, 0)
            _setpar_any(ndi, ("sourcename", "name"), "yolo_detections")
            _setpar(ndi, "active", 1 if _p.get("active") else 0, warn=False)
            _record("ndi_detections_in", ndi)

            notes = _or_create(comp, "ndi_detection_notes", textDAT)
            _place(notes, 1, 1)
            notes.text = (
                "NDI detections mode expects an external YOLO renderer or metadata feed. "
                "Use source_in for the local image stream and map external detections into "
                "the detections table + tdmcp_yolo_tracks store."
            )
            _record("ndi_detection_notes", notes)
            _warn("ndi_detections requires a validated external NDI overlay or metadata source.")
        elif backend == "file_watch":
            notes = _or_create(comp, "file_watch_notes", textDAT)
            _place(notes, 1, 0)
            notes.text = (
                "File-watch detections mode is a scaffold. Add a DAT Execute or timer that "
                "loads JSON rows with id,class,score,x,y,w,h, then updates detections and "
                "parent.store('tdmcp_yolo_tracks', objects)."
            )
            _record("file_watch_notes", notes)
            _warn("file_watch requires an external process writing detection files; no watcher is active yet.")
        else:
            report["fatal"] = "Unknown backend: " + str(backend)

        setup_notes = _or_create(comp, "setup_notes", textDAT)
        _place(setup_notes, 0, 3)
        setup_notes.text = "\\n".join(
            [
                "tdmcp YOLO/ONNX tracker scaffold",
                "Backend: " + str(backend),
                "Input TOP: " + str(_p.get("input_top_path") or "Noise TOP scaffold"),
                "WebSocket URL: " + str(_p.get("server_url")),
                "ONNX model: " + str(_p.get("model_path") or "(set model_path)"),
                "Class filter: " + ", ".join(_p.get("class_filter") or []) or "(none)",
                "Confidence threshold: " + str(_p.get("confidence_threshold", 0.35)),
                "Outputs: detections DAT, tracks_out CHOP, annotated_out TOP.",
                "Live detection is not validated by this scaffold.",
            ]
        )
        _record("setup_notes", setup_notes)

        if not report.get("fatal"):
            report["output_paths"] = {
                "detections_dat": detections.path,
                "tracks_out": tracks_out.path,
                "annotated_out": annotated_out.path,
            }
            _warn(
                "Live YOLO detection requires an external detector, an NDI/file bridge, or "
                "TouchDesigner Python with onnxruntime plus a validated model contract. "
                "This tool only builds the bridge scaffold."
            )

            try:
                errors = comp.errors()
                if isinstance(errors, str):
                    report["errors"] = [line.strip() for line in errors.splitlines() if line.strip()][:5]
                else:
                    report["errors"] = [str(err) for err in errors][:5]
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = json.dumps(report)
print(result)
`;

export function buildYoloOnnxTrackerScript(payload: object): string {
  return buildPayloadScript(YOLO_ONNX_TRACKER_SCRIPT, payload);
}

export async function createYoloOnnxTrackerImpl(ctx: ToolContext, args: CreateYoloOnnxTrackerArgs) {
  const containerName = args.name ?? "yolo_onnx_tracker";
  const script = buildYoloOnnxTrackerScript({
    parent_path: args.parent_path,
    name: containerName,
    input_top_path: args.input_top_path ?? null,
    backend: args.backend,
    server_url: args.server_url,
    model_path: args.model_path ?? null,
    class_filter: args.class_filter,
    max_objects: args.max_objects,
    confidence_threshold: args.confidence_threshold,
    active: args.active,
  });

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<YoloOnnxTrackerReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`YOLO/ONNX tracker scaffold failed: ${report.fatal}`, report);
      }

      const outputs = report.output_paths;
      const outputSummary = outputs
        ? `${outputs.detections_dat}, ${outputs.tracks_out}, ${outputs.annotated_out}`
        : `${args.parent_path}/${containerName}/detections, ${args.parent_path}/${containerName}/tracks_out, ${args.parent_path}/${containerName}/annotated_out`;
      const warningCount = report.warnings.length;
      const warningNote = warningCount > 0 ? ` ${warningCount} warning(s).` : "";
      return jsonResult(
        `YOLO/ONNX tracker scaffold created in ${
          report.container_path ?? `${args.parent_path}/${containerName}`
        }. Outputs: ${outputSummary}.${warningNote}`,
        report,
      );
    },
  );
}

export const registerCreateYoloOnnxTracker: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_yolo_onnx_tracker",
    {
      title: "Create YOLO ONNX tracker scaffold",
      description:
        "Build a deterministic TouchDesigner scaffold for YOLO-style object tracking. " +
        "Creates source input, backend receiver placeholder, detections DAT, stable " +
        "tracks_out CHOP channels, annotated_out TOP, and setup notes. Live detection " +
        "requires an external detector or validated TouchDesigner Python ONNX runtime.",
      inputSchema: createYoloOnnxTrackerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createYoloOnnxTrackerImpl(ctx, args),
  );
};
