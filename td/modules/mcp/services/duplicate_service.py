"""First-class node/subtree duplicate — survives TDMCP_BRIDGE_ALLOW_EXEC=0.

Promotes ``parent.copy(src[, name])`` (used by ``duplicate_network``) off
``/api/exec`` to ``POST /api/duplicate``. ``COMP.copy`` deep-copies the source
INCLUDING its internal children, wires, and parameter values, so a whole built
network clones faithfully.

Pure functions; reach TD globals via ``import td`` INSIDE the function so the
module imports cleanly off-TD (mirrors ``mcp/services/connect_service.py``). Raise
``ValueError``/``LookupError`` on hard failure; the router turns them into the
standard 400 ``{ok:false,error:{message}}`` envelope.

Probed live on TD 2025.32820: ``parent.copy(src, name=...)`` returns the new op,
whose ``.path`` is the created copy. Omitting ``name`` lets TD auto-number.
"""


def _resolve_duplicate_targets(op, source_path, parent_path):
    """Resolve the (src, parent) pair for a duplicate. Raises on a missing target."""
    src = op(source_path)
    if src is None:
        raise LookupError("duplicate: source not found: %s" % source_path)

    if parent_path:
        parent = op(parent_path)
        if parent is None:
            raise LookupError("duplicate: parent not found: %s" % parent_path)
        return src, parent

    parent = src.parent()
    if parent is None:
        raise ValueError("duplicate: source %s has no parent" % source_path)
    return src, parent


def duplicate(source_path, name=None, parent_path=None):
    """Duplicate ``op(source_path)`` into ``parent_path`` (default: source's parent).

    Returns ``{source, copy, parent}``. Raises ``LookupError`` when the source or
    an explicit parent is missing and ``ValueError`` when the copy fails.
    """
    import td

    src, parent = _resolve_duplicate_targets(td.op, source_path, parent_path)

    try:
        new = parent.copy(src, name=name) if name else parent.copy(src)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("duplicate: copy of %s failed: %s" % (source_path, exc))

    if new is None:
        raise ValueError("duplicate: copy of %s returned no node" % source_path)

    return {"source": src.path, "copy": new.path, "parent": parent.path}
