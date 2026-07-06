"""Opt-in parameter-change watches — survives TDMCP_BRIDGE_ALLOW_EXEC=0.

A small in-process subscription registry that tracks which operator paths (and,
optionally, which parameter names on them) an event consumer wants change
notifications for, plus a per-frame **poller** that detects changes and emits
``param.changed`` payloads ``{path, par, prev, value, frame}``.

Why poll instead of a Parameter Execute DAT callback: TouchDesigner's Parameter
Execute DAT ``onValueChange`` only fires for INTERACTIVE (UI) parameter edits — it
does NOT fire for scripted ``par.x = value`` assignments or expression/export
re-evaluations (confirmed live on TD 099 build 2025.32820). Polling the watched
parameters at ``onFrameEnd`` catches EVERY change source (UI, script, expression,
CHOP export) uniformly, and reuses the bridge's existing ``events_hook`` Execute
DAT + ``events.broadcast`` — no separate DAT.

Design notes:
  - Pure module-level state. The REST handler (register/unregister/list) and the
    ``onFrameEnd`` poller import THIS module inside the one TD Python interpreter,
    so they share ``_WATCHES`` / ``_SNAPSHOT`` / ``_LAST_EMIT`` directly.
  - Reach TD globals via ``import td`` INSIDE each function so the module imports
    cleanly off-TD (mirrors ``connect_service`` / ``system_service``). The tests
    exercise the registry + poll + coalescing logic with a faked ``op()``.
  - NOT gated by ``TDMCP_BRIDGE_ALLOW_EXEC`` — registering a watch is structured,
    not arbitrary Python; it must survive the hardened config.

High-frequency guard: ``poll`` emits at most one ``param.changed`` per (path, par)
per ``_COALESCE_MS`` window (default 50 ms), and the Node ``eventStream`` also
treats ``param.changed`` as a high-frequency event (dropped unless the operator
opts into TDMCP_EVENTS high-frequency mode). Together these keep a dragged slider
from swamping clients while still delivering the final resting value.
"""

import time

# path -> { "pars": set[str] | None }   (None means "all parameters on this op")
_WATCHES = {}
# (path, par) -> last SEEN value, so the poller can detect a delta each frame.
_SNAPSHOT = {}
# (path, par) -> last-emit monotonic seconds, for coalescing bursts.
_LAST_EMIT = {}

# Minimum spacing between two param.changed emits for the SAME (path, par). A
# dragged slider changes value every frame; coalescing to one emit per window
# caps the WebSocket traffic without dropping the final resting value (the next
# distinct change after the window still emits).
_COALESCE_MS = 50.0


def _normalize_pars(pars):
    """Normalize a requested par filter to a set of names, or None for 'all'.

    Accepts None / [] (watch every parameter), a single string, or a list of
    strings. Blank entries are dropped. An empty resulting set collapses to None
    (watch-all) so ``{"pars": []}`` never silently watches nothing.
    """
    if pars is None:
        return None
    if isinstance(pars, str):
        pars = [pars]
    names = {str(p).strip() for p in pars if str(p).strip()}
    return names or None


def register(path, pars=None):
    """Add or extend a watch on ``path``. Returns the watch's normalized state.

    Re-registering the same path MERGES par filters: a watch-all (None) stays
    watch-all; otherwise the new names union with the existing set. Registering
    is idempotent in the sense that watching the same names twice is a no-op.
    """
    import td

    node = td.op(path)
    if node is None:
        raise LookupError(path)
    resolved = node.path  # canonical path (handles relative inputs)
    new_pars = _normalize_pars(pars)
    existing = _WATCHES.get(resolved)
    if existing is None:
        _WATCHES[resolved] = {"pars": new_pars}
    else:
        merged = _merge_pars(existing.get("pars"), new_pars)
        _WATCHES[resolved] = {"pars": merged}
    return {
        "path": resolved,
        "pars": _pars_list(_WATCHES[resolved]["pars"]),
        "watching": True,
    }


def _merge_pars(current, incoming):
    """Union two par filters, where None means 'all' and absorbs any set."""
    if current is None or incoming is None:
        return None
    return set(current) | set(incoming)


def _pars_list(pars):
    """Serialize a par filter for JSON: sorted list, or None for watch-all."""
    return None if pars is None else sorted(pars)


def unregister(path, pars=None):
    """Remove a watch (or specific par names) from ``path``.

    With no ``pars`` (or watch-all), removes the whole watch. With specific
    names, removes only those from an existing name filter; if that empties the
    filter, or the watch was watch-all, the whole watch is removed. Returns the
    remaining state. Unregistering an unknown path is a no-op (``watching`` false).
    """
    import td

    node = td.op(path)
    resolved = node.path if node is not None else path
    existing = _WATCHES.get(resolved)
    if existing is None:
        return {"path": resolved, "pars": None, "watching": False}
    remove = _normalize_pars(pars)
    if remove is None or existing.get("pars") is None:
        _WATCHES.pop(resolved, None)
        _clear_emit_state(resolved)
        return {"path": resolved, "pars": None, "watching": False}
    remaining = set(existing["pars"]) - remove
    if not remaining:
        _WATCHES.pop(resolved, None)
        _clear_emit_state(resolved)
        return {"path": resolved, "pars": None, "watching": False}
    _WATCHES[resolved] = {"pars": remaining}
    return {"path": resolved, "pars": _pars_list(remaining), "watching": True}


def _clear_emit_state(path):
    for key in [k for k in _LAST_EMIT if k[0] == path]:
        _LAST_EMIT.pop(key, None)
    for key in [k for k in _SNAPSHOT if k[0] == path]:
        _SNAPSHOT.pop(key, None)


def list_watches():
    """Snapshot every active watch as a JSON-friendly report."""
    return {
        "watches": [
            {"path": p, "pars": _pars_list(state.get("pars"))}
            for p, state in sorted(_WATCHES.items())
        ],
        "count": len(_WATCHES),
    }


def clear():
    """Drop every watch + snapshot + emit state. Used by tests and a full unwatch."""
    _WATCHES.clear()
    _SNAPSHOT.clear()
    _LAST_EMIT.clear()


def is_watched(path, par_name):
    """Whether ``par_name`` on ``path`` should emit, per the registry filters."""
    state = _WATCHES.get(path)
    if state is None:
        return False
    pars = state.get("pars")
    return pars is None or par_name in pars


def _coalesced(path, par_name, now_s):
    """True when this (path, par) emitted within the coalesce window (drop it)."""
    key = (path, par_name)
    last = _LAST_EMIT.get(key)
    if last is not None and (now_s - last) * 1000.0 < _COALESCE_MS:
        return True
    _LAST_EMIT[key] = now_s
    return False


def poll(op_resolver=None, frame=None, now_s=None):
    """Detect value changes across all watched pars; return `param.changed` payloads.

    Called once per frame from the bridge's `events_hook` `onFrameEnd`. Walks every
    active watch, reads the current value of each watched parameter, and — when it
    differs from the last-seen snapshot AND passes the per-(path,par) coalescing
    guard — yields a `{path, par, prev, value, frame}` payload. The FIRST poll of a
    par only seeds the snapshot (no spurious change event). ``op_resolver`` defaults
    to ``td.op``; ``frame``/``now_s`` default to the live timeline/clock (injectable
    for tests). Returns a list (possibly empty). Never raises: a par that can't be
    read is skipped.
    """
    resolve = op_resolver or _default_op
    now = time.monotonic() if now_s is None else now_s
    frame_no = _current_frame() if frame is None else frame
    payloads = []
    for path, state in list(_WATCHES.items()):
        node = _safe_resolve(resolve, path)
        if node is None:
            continue
        for par in _watched_pars(node, state.get("pars")):
            payload = _diff_par(path, par, now, frame_no)
            if payload is not None:
                payloads.append(payload)
    return payloads


def _default_op(path):
    import td

    return td.op(path)


def _safe_resolve(resolve, path):
    try:
        return resolve(path)
    except Exception:  # noqa: BLE001
        return None


def _watched_pars(node, pars):
    """The Par objects to check on ``node`` for the given filter (None = all)."""
    try:
        if pars is None:
            return list(node.pars())
        result = []
        for name in pars:
            par = getattr(node.par, name, None)
            if par is not None:
                result.append(par)
        return result
    except Exception:  # noqa: BLE001
        return []


def _diff_par(path, par, now_s, frame_no):
    """Emit a payload if this par's value changed since the last EMITTED snapshot.

    The snapshot only advances when a change is actually delivered (or on first
    sight / no change). Coalesced changes deliberately leave the snapshot on the
    old value so the next poll after the coalesce window still sees a delta and
    emits the resting value — a burst that settles at a new value (0.1 → 0.2
    within one window, then stops) always eventually emits the final 0.2 instead
    of leaving subscribers stuck on the stale 0.1.
    """
    name = getattr(par, "name", None)
    if name is None:
        return None
    try:
        value = par.eval()
    except Exception:  # noqa: BLE001
        return None
    key = (path, name)
    prev = _SNAPSHOT.get(key, _UNSET)
    if prev is _UNSET or prev == value:
        _SNAPSHOT[key] = value  # first sight (seed only) or no change
        return None
    if _coalesced(path, name, now_s):
        return None  # keep the old snapshot; the settled value emits next window
    _SNAPSHOT[key] = value  # advance only on delivery
    return {
        "path": path,
        "par": name,
        "prev": _coerce(prev),
        "value": _coerce(value),
        "frame": frame_no,
    }


_UNSET = object()


def _coerce(value):
    """Reduce a TD par value to a JSON-safe scalar (str/number/bool/None)."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def _current_frame():
    """The current timeline frame as an int, or None off-TD."""
    try:
        import td

        return int(getattr(td, "absTime").frame)
    except Exception:  # noqa: BLE001
        return None
