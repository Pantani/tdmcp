"""Load a ``.toe``/``.tox`` artifact — first-class endpoint for the Project RAG
quarantine analyzer (``POST /api/project/load``).

SAFETY: this is meant to run ONLY inside a SEPARATE quarantine TouchDesigner
process (default port 9981), never the artist's main instance. The endpoint
itself just calls ``project.load(path)``; the Node side (``bridgeAnalyze.ts``)
hard-rejects the main port 9980 before ever calling here. ``project.load`` opens
the file via TD's own loader — it does NOT execute arbitrary Python the way
``/api/exec`` does — so this route is intentionally NOT behind
``TDMCP_BRIDGE_ALLOW_EXEC`` (a hardened quarantine bridge with exec disabled must
still be able to open the artifact it was spun up to inspect).

Mirrors ``transport_service`` / ``project_analysis_service``: pure functions that
reach TD globals via ``import td`` INSIDE the function so the module imports
cleanly off-TD (the unittest drives it against a fake ``td`` module). Raises
``ValueError`` on bad input; the router turns it into the standard 400 envelope.

Returned shape (every key always present except the optional preview)::

    {
      "root_path": str,        # the loaded project's root COMP path (e.g. /project1)
      "node_count": int,       # descendants of the root after load
      "errors": [              # post-load node errors (same shape as get_node_errors)
        {"path": str, "message": str, "level": str}, ...
      ],
      "preview_b64": str       # optional base64 PNG of the output TOP
    }
"""

import os


def _root_path(td):
    """Resolve the loaded project's root COMP path.

    ``project.load`` replaces the open project; its top-level COMP is the
    conventional ``/project1`` but TD exposes the live root as ``op('/')``'s
    sole child COMP, so prefer that and fall back to ``/project1``.
    """
    try:
        root = td.op("/")
        kids = list(root.children) if root is not None else []
        comps = [c for c in kids if bool(getattr(c, "isCOMP", False))]
        if comps:
            return comps[0].path
    except Exception:  # noqa: BLE001
        pass
    return "/project1"


def _node_count(td, root_path):
    try:
        root = td.op(root_path)
        if root is None or not hasattr(root, "findChildren"):
            return 0
        return len(list(root.findChildren(maxDepth=9999)))
    except Exception:  # noqa: BLE001
        return 0


def _level_name(err):
    try:
        level = getattr(err, "level", None)
        return getattr(level, "name", None) or str(level) if level is not None else "error"
    except Exception:  # noqa: BLE001
        return "error"


def _collect_errors(td, root_path):
    """Walk the loaded root for post-cook node errors (best-effort, never raises)."""
    out = []
    try:
        root = td.op(root_path)
        nodes = list(root.findChildren(maxDepth=9999)) if root is not None else []
    except Exception:  # noqa: BLE001
        nodes = []
    for node in nodes:
        try:
            errs = node.errors(recurse=False)
        except Exception:  # noqa: BLE001
            continue
        if not errs:
            continue
        for line in (errs.splitlines() if isinstance(errs, str) else [errs]):
            text = (line or "").strip() if isinstance(line, str) else str(line)
            if text:
                out.append({"path": node.path, "message": text, "level": _level_name(node)})
    return out


def _preview_b64(root_path):
    """Best-effort base64 PNG of the loaded project's output TOP. None on any failure."""
    try:
        from mcp.services import preview_service

        for candidate in (root_path.rstrip("/") + "/out1", "/project1/out1"):
            try:
                shot = preview_service.capture(candidate, 640, 360)
            except Exception:  # noqa: BLE001
                continue
            if isinstance(shot, dict):
                b64 = shot.get("pngBase64") or shot.get("base64")
                if isinstance(b64, str) and b64:
                    return b64
    except Exception:  # noqa: BLE001
        return None
    return None


def load(path, timeout_ms=None):
    """Load ``path`` (an absolute ``.toe``/``.tox``) and report the loaded tree.

    Raises ``ValueError`` for a missing / non-absolute / non-existent path or an
    unsupported extension — the router maps that to HTTP 400. ``timeout_ms`` is
    accepted for parity with the Node client contract; TD's ``project.load`` is
    synchronous, so it is currently advisory (the Node side enforces its own hard
    timeout around the whole call).
    """
    import td

    if not isinstance(path, str) or not path.strip():
        raise ValueError("Field 'path' must be a non-empty string.")
    path = path.strip()
    if not os.path.isabs(path):
        raise ValueError("Field 'path' must be an absolute path: %r." % path)
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".toe", ".tox"):
        raise ValueError("Field 'path' must be a .toe or .tox file (got %r)." % ext)
    if not os.path.exists(path):
        raise ValueError("File not found: %s." % path)

    td.project.load(path)

    root_path = _root_path(td)
    report = {
        "root_path": root_path,
        "node_count": _node_count(td, root_path),
        "errors": _collect_errors(td, root_path),
    }
    preview = _preview_b64(root_path)
    if preview is not None:
        report["preview_b64"] = preview
    return report
