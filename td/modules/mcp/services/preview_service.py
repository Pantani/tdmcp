"""Capture a TOP as a base64-encoded PNG."""

import base64


def capture(path, width=640, height=360):
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if getattr(node, "family", None) != "TOP":
        raise ValueError("Preview is only supported for TOPs, got %s" % path)

    data = None
    try:
        data = node.saveByteArray(".png")
    except Exception:  # noqa: BLE001
        data = None

    if data is None:
        # Fallback: save to a temp file and read it back.
        import os
        import tempfile

        tmp = os.path.join(tempfile.gettempdir(), "tdmcp_preview.png")
        node.save(tmp)
        with open(tmp, "rb") as handle:
            data = handle.read()

    encoded = base64.b64encode(bytes(data)).decode("ascii")
    return {
        "path": node.path,
        "width": int(getattr(node, "width", width) or width),
        "height": int(getattr(node, "height", height) or height),
        "format": "png",
        "base64": encoded,
    }
