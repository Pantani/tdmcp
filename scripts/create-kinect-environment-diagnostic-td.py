import json

RAW_PATH = "/tmp/kinect_environment_diagnostic.rgba"
JSON_PATH = "/tmp/kinect_environment_diagnostic.json"
WIDTH = 1280
HEIGHT = 720


def _safe_destroy(node):
    if node is not None:
        try:
            node.destroy()
        except Exception:
            pass


def _create(parent, op_type, name, x, y):
    existing = parent.op(name)
    _safe_destroy(existing)
    node = parent.create(op_type, name)
    node.nodeX = x
    node.nodeY = y
    return node


def _set_par(node, name, value):
    try:
        getattr(node.par, name).val = value
    except Exception:
        try:
            setattr(node.par, name, value)
        except Exception:
            pass


callback_code = r'''
import json
import os
try:
    import numpy as np
except Exception:
    np = None

RAW_PATH = "/tmp/kinect_environment_diagnostic.rgba"
JSON_PATH = "/tmp/kinect_environment_diagnostic.json"
WIDTH = 1280
HEIGHT = 720
EXPECTED = WIDTH * HEIGHT * 4

def _bbox_text(status, key):
    box = status.get(key) or {}
    return "%.3f,%.3f -> %.3f,%.3f" % (
        float(box.get("x0", 0.0)),
        float(box.get("y0", 0.0)),
        float(box.get("x1", 0.0)),
        float(box.get("y1", 0.0)),
    )

def _format_status(status, raw_ok):
    if not status:
        return "Kinect Environment Diagnostic\nwaiting for external helper\nraw_ok=%s" % raw_ok
    lines = [
        "Kinect Environment Diagnostic",
        "serial: %s" % status.get("serial", ""),
        "frame: %s  background_ready: %s  background_frames: %s" % (
            status.get("frame", ""),
            status.get("background_ready", False),
            status.get("background_frames", ""),
        ),
        "rgb: %sx%s  depth/ir: %sx%s" % (
            status.get("color_width", ""),
            status.get("color_height", ""),
            status.get("depth_width", ""),
            status.get("depth_height", ""),
        ),
        "valid_depth_ratio: %.3f  median_wall_mm: %.1f" % (
            float(status.get("valid_depth_ratio", 0.0)),
            float(status.get("median_wall_mm", 0.0)),
        ),
        "foreground_samples: %s  candidate_samples: %s  max_delta_mm: %.1f" % (
            status.get("foreground_samples", ""),
            status.get("candidate_samples", ""),
            float(status.get("max_delta_mm", 0.0)),
        ),
        "projection RGB: %s  bright: %.3f  bbox: %s" % (
            status.get("projection_present", False),
            float(status.get("projection_bright_ratio", 0.0)),
            _bbox_text(status, "projection_bbox"),
        ),
        "projection DEPTH: %s  bright: %.3f  bbox: %s" % (
            status.get("registered_projection_present", False),
            float(status.get("registered_projection_bright_ratio", 0.0)),
            _bbox_text(status, "registered_projection_bbox"),
        ),
        "candidate_in_projection: %s  pos: %.3f, %.3f" % (
            status.get("candidate_samples_in_projection", ""),
            float(status.get("candidate_projection_x", 0.0)),
            float(status.get("candidate_projection_y", 0.0)),
        ),
        "touch band: %.1f..%.1f mm" % (
            float(status.get("near_min_mm", 0.0)),
            float(status.get("near_max_mm", 0.0)),
        ),
        "raw_ok: %s" % raw_ok,
    ]
    return "\n".join(lines)

def _draw_placeholder(img):
    img[:, :, 0:3] = 0.96
    img[:, :, 3] = 1.0
    img[0:12, :, 0] = 1.0
    img[0:12, :, 1] = 0.55
    img[0:12, :, 2] = 0.0

def onCook(scriptOp):
    if np is None:
        return
    img = np.zeros((HEIGHT, WIDTH, 4), dtype=np.float32)
    raw_ok = False
    try:
        if os.path.exists(RAW_PATH) and os.path.getsize(RAW_PATH) == EXPECTED:
            raw = np.fromfile(RAW_PATH, dtype=np.uint8)
            img = raw.reshape((HEIGHT, WIDTH, 4)).astype(np.float32) / 255.0
            raw_ok = True
        else:
            _draw_placeholder(img)
    except Exception:
        _draw_placeholder(img)
    status = {}
    try:
        with open(JSON_PATH, "r", encoding="utf-8") as handle:
            status = json.load(handle)
    except Exception:
        status = {}
    try:
        parent().op("status").text = _format_status(status, raw_ok)
    except Exception:
        pass
    scriptOp.copyNumpyArray(img)
    return
'''

project = op("/project1")
if project is None:
    raise RuntimeError("/project1 not found")

comp = project.op("kinect_environment_diagnostic")
_safe_destroy(comp)
comp = project.create(baseCOMP, "kinect_environment_diagnostic")
comp.nodeX = 950
comp.nodeY = -260

status = _create(comp, textDAT, "status", -500, -160)
status.text = "Kinect Environment Diagnostic\nwaiting for external helper"

notes = _create(comp, textDAT, "notes", -500, -300)
notes.text = """Panels:
top-left: Kinect RGB
top-right: Kinect depth heatmap
bottom-left: Kinect IR
bottom-right: foreground / candidate mask

External files:
%s
%s
""" % (RAW_PATH, JSON_PATH)

callbacks = _create(comp, textDAT, "diagnostic_view_callbacks", -240, -160)
callbacks.text = callback_code

view = _create(comp, scriptTOP, "diagnostic_view", -240, 40)
_set_par(view, "resolutionw", WIDTH)
_set_par(view, "resolutionh", HEIGHT)
try:
    view.par.callbacks = callbacks
except Exception:
    pass
auto_callbacks = comp.op("diagnostic_view_callbacks1")
if auto_callbacks is not None and auto_callbacks != callbacks:
    _safe_destroy(auto_callbacks)

out1 = _create(comp, nullTOP, "out1", 40, 40)
try:
    out1.inputConnectors[0].connect(view)
except Exception:
    pass

win = project.op("projector_window")

report = {
    "container": comp.path,
    "status": status.path,
    "view": view.path,
    "out1": out1.path,
    "raw_path": RAW_PATH,
    "json_path": JSON_PATH,
    "projector_winop": win.par.winop.eval().path if win is not None and hasattr(win.par.winop.eval(), "path") else None,
    "note": "diagnostic comp created; projector_window left unchanged",
}
print(json.dumps(report))
