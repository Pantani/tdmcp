"""First-class node save — survives TDMCP_BRIDGE_ALLOW_EXEC=0.

Promotes ``op.save(file)`` (used by ``render_output`` and component export) off
``/api/exec`` to ``POST /api/nodes/<path…>/save``. A COMP saves to a ``.tox``
component file; a TOP saves to an image (``.png/.jpg/.exr/.tiff`` by extension).

Pure functions; reach TD globals via ``import td`` INSIDE each function so the
module imports cleanly off-TD (mirrors ``mcp/services/api_service.py``). Raise
``ValueError``/``LookupError`` on hard failure; the router turns them into the
standard 400 ``{ok:false,error:{message}}`` envelope.

Probed live on TD 2025.32820:
  - ``COMP.save(path, createFolders=True)`` returns the saved path as a ``str``.
  - ``TOP.save(path, createFolders=True)`` returns a ``td.FileSaveStatus`` object
    (NOT a str), so the return is normalized with ``str(...)`` and the requested
    file is reported as the canonical ``saved`` path.
  - Only image operators (TOPs) expose ``.width``/``.height``; a COMP does not,
    so dimensions are reported only when present.
"""


def _has_dimensions(node):
    return hasattr(node, "width") and hasattr(node, "height")


def _saved_path(returned, fallback):
    """Normalize op.save's return to a path string.

    COMP.save returns the path str; TOP.save returns a FileSaveStatus object.
    Fall back to the requested file when the return is falsy/None.
    """
    if returned is None:
        return fallback
    text = str(returned).strip()
    # A FileSaveStatus repr isn't a usable path; only trust a return that looks
    # like the target (COMP.save). Otherwise report the requested file.
    if text and text == fallback:
        return text
    return fallback


def save_node(path, file, create_folders=True):
    """Save ``op(path)`` to ``file`` (``.tox`` for a COMP, image for a TOP).

    Returns ``{path, saved, has_dimensions, width?, height?}``. Raises
    ``LookupError`` when the node is missing and ``ValueError`` when it has no
    ``save`` method or the write fails.
    """
    import td

    op = td.op

    if not isinstance(file, str) or not file.strip():
        raise ValueError("save: 'file' must be a non-empty path string.")
    file = file.strip()

    node = op(path)
    if node is None:
        raise LookupError("save: node not found: %s" % path)
    if not hasattr(node, "save"):
        raise ValueError("save: %s cannot be saved (no .save method)." % path)

    try:
        returned = node.save(file, createFolders=bool(create_folders))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("save: %s failed to save to %s: %s" % (path, file, exc))

    report = {
        "path": node.path,
        "saved": _saved_path(returned, file),
        "has_dimensions": False,
    }
    if _has_dimensions(node):
        try:
            report["width"] = int(node.width)
            report["height"] = int(node.height)
            report["has_dimensions"] = True
        except Exception:  # noqa: BLE001
            report["has_dimensions"] = False
    return report
