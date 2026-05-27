"""Capture a TOP as a base64-encoded PNG.

The TOP is composited over a checkerboard first, so transparent regions read as a
checker pattern instead of solid white when a viewer flattens the PNG's alpha over a
white page. Opaque TOPs are unaffected (the checker stays fully hidden). If the
composite path errors for any reason, we fall back to saving the TOP directly.
"""

import base64

import td

op = td.op  # TD globals are not available inside imported modules; reach via td

# Mid-gray checkerboard (16x9 cells). Self-contained fragment shader, no inputs/uniforms.
_CHECKER_FRAG = """out vec4 fragColor;
void main(){
    vec2 cell = floor(vUV.st * vec2(16.0, 9.0));
    float k = mod(cell.x + cell.y, 2.0);
    fragColor = vec4(mix(vec3(0.16), vec3(0.30), k), 1.0);
}
"""


def _save_png(node):
    """Return the node's PNG bytes, via saveByteArray with a temp-file fallback."""
    data = None
    try:
        data = node.saveByteArray(".png")
    except Exception:  # noqa: BLE001
        data = None

    if data is None:
        import os
        import tempfile

        tmp = os.path.join(tempfile.gettempdir(), "tdmcp_preview.png")
        node.save(tmp)
        with open(tmp, "rb") as handle:
            data = handle.read()

    return bytes(data)


def _checkerboard_png(node, width, height):
    """Composite `node` over a checkerboard and return the flattened PNG bytes.

    Creates a few temporary nodes in the node's parent and destroys them afterwards
    (even on error). Returns None if the composite could not be produced, so callers
    can fall back to a direct save.
    """
    parent = node.parent()
    if parent is None:
        return None

    temps = []
    try:
        frag = parent.create("textDAT", "__tdmcp_pv_frag")
        temps.append(frag)
        frag.text = _CHECKER_FRAG

        bg = parent.create("glslTOP", "__tdmcp_pv_bg")
        temps.append(bg)
        bg.par.pixeldat = frag.name
        bg.par.outputresolution = "custom"
        bg.par.resolutionw = width
        bg.par.resolutionh = height

        comp = parent.create("compositeTOP", "__tdmcp_pv_comp")
        temps.append(comp)
        comp.par.operand = "over"
        comp.par.outputresolution = "custom"
        comp.par.resolutionw = width
        comp.par.resolutionh = height
        comp.inputConnectors[0].connect(node)  # foreground (over)
        comp.inputConnectors[1].connect(bg)  # background (under)
        comp.cook(force=True)

        if comp.errors():
            return None
        return _save_png(comp)
    except Exception:  # noqa: BLE001
        return None
    finally:
        for t in reversed(temps):
            try:
                t.destroy()
            except Exception:  # noqa: BLE001
                pass


def capture(path, width=640, height=360):
    node = op(path)
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if getattr(node, "family", None) != "TOP":
        raise ValueError("Preview is only supported for TOPs, got %s" % path)

    w = int(getattr(node, "width", width) or width)
    h = int(getattr(node, "height", height) or height)
    # Clamp to a sane preview ceiling so a hostile/huge request (or a TOP with an
    # extreme resolution) can't allocate a multi-gigapixel GPU texture and exhaust
    # VRAM / hang TD. A preview is a thumbnail; 4096 on a side is plenty.
    w = max(1, min(w, 4096))
    h = max(1, min(h, 4096))

    data = _checkerboard_png(node, w, h)
    if data is None:
        data = _save_png(node)

    encoded = base64.b64encode(data).decode("ascii")
    return {
        "path": node.path,
        "width": w,
        "height": h,
        "format": "png",
        "base64": encoded,
    }
