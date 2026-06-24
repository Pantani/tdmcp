import json

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


callback_code = r'''
try:
    import numpy as np
except Exception:
    np = None

WIDTH = 1280
HEIGHT = 720

def _rect(img, x0, y0, x1, y1, color):
    h, w, _ = img.shape
    x0 = max(0, min(w, int(x0)))
    x1 = max(0, min(w, int(x1)))
    y0 = max(0, min(h, int(y0)))
    y1 = max(0, min(h, int(y1)))
    img[y0:y1, x0:x1, 0:3] = color
    img[y0:y1, x0:x1, 3] = 1.0

def onCook(scriptOp):
    if np is None:
        return
    img = np.ones((HEIGHT, WIDTH, 4), dtype=np.float32)
    img[:, :, 3] = 1.0
    black = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    # Outer border.
    thickness = 12
    _rect(img, 0, 0, WIDTH, thickness, black)
    _rect(img, 0, HEIGHT - thickness, WIDTH, HEIGHT, black)
    _rect(img, 0, 0, thickness, HEIGHT, black)
    _rect(img, WIDTH - thickness, 0, WIDTH, HEIGHT, black)
    # Checker/grid lines. Big cells are easier for the Kinect RGB camera to see
    # on a projected wall than a dense calibration chart.
    cols = 8
    rows = 5
    line = 6
    for i in range(1, cols):
        x = int(i * WIDTH / cols)
        _rect(img, x - line // 2, 0, x + line // 2 + 1, HEIGHT, black)
    for j in range(1, rows):
        y = int(j * HEIGHT / rows)
        _rect(img, 0, y - line // 2, WIDTH, y + line // 2 + 1, black)
    # Corner fiducials. These are deliberately large, saturated, and inset so
    # keystone/overscan does not clip them.
    size = 92
    inset = 42
    # TouchDesigner Script TOP numpy colors display as BGR on this build.
    _rect(img, inset, inset, inset + size, inset + size, np.array([0.0, 0.0, 1.0], dtype=np.float32))
    _rect(img, WIDTH - inset - size, inset, WIDTH - inset, inset + size, np.array([0.0, 0.85, 0.0], dtype=np.float32))
    _rect(img, inset, HEIGHT - inset - size, inset + size, HEIGHT - inset, np.array([1.0, 0.0, 0.0], dtype=np.float32))
    _rect(img, WIDTH - inset - size, HEIGHT - inset - size, WIDTH - inset, HEIGHT - inset, np.array([0.0, 0.82, 1.0], dtype=np.float32))
    # Center cross.
    c = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    _rect(img, WIDTH // 2 - 4, HEIGHT // 2 - 52, WIDTH // 2 + 4, HEIGHT // 2 + 52, c)
    _rect(img, WIDTH // 2 - 52, HEIGHT // 2 - 4, WIDTH // 2 + 52, HEIGHT // 2 + 4, c)
    scriptOp.copyNumpyArray(img)
    return
'''

project = op("/project1")
if project is None:
    raise RuntimeError("/project1 not found")

comp = project.op("kinect_projection_calibration_pattern")
_safe_destroy(comp)
comp = project.create(baseCOMP, "kinect_projection_calibration_pattern")
comp.nodeX = 950
comp.nodeY = -620

callbacks = _create(comp, textDAT, "pattern_callbacks", -260, -140)
callbacks.text = callback_code

pattern = _create(comp, scriptTOP, "pattern", -260, 40)
try:
    pattern.par.outputresolution = "custom"
except Exception:
    pass
try:
    pattern.par.resolutionw = WIDTH
    pattern.par.resolutionh = HEIGHT
    pattern.par.callbacks = callbacks
except Exception:
    pass

out1 = _create(comp, nullTOP, "out1", 40, 40)
try:
    out1.inputConnectors[0].connect(pattern)
except Exception:
    pass
try:
    out1.par.outputresolution = "input"
except Exception:
    pass

notes = _create(comp, textDAT, "notes", -260, -300)
notes.text = """Projection calibration pattern.

red: top-left
green: top-right
blue: bottom-left
yellow: bottom-right

The external Kinect environment diagnostic helper detects the bright projection
area and these saturated corner markers in the RGB frame.
"""

win = project.op("projector_window")
if win is not None:
    try:
        win.par.winop = out1.path
        if hasattr(win.par, "winopen"):
            win.par.winopen.pulse()
    except Exception:
        pass

report = {
    "container": comp.path,
    "pattern": pattern.path,
    "out1": out1.path,
    "projector_winop": win.par.winop.eval().path if win is not None and hasattr(win.par.winop.eval(), "path") else None,
}
print(json.dumps(report))
