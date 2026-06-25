"""Timeline transport — first-class endpoint that survives TDMCP_BRIDGE_ALLOW_EXEC=0.

Pure functions; reach TD globals via ``import td`` INSIDE each function so the
module imports cleanly off-TD (mirrors ``mcp/services/api_service.py``). Raise
``ValueError`` on bad input; the router turns it into the standard 400
``{ok:false,error:{message}}`` envelope.

Verbs (exhaustive, matches the Node-side tool schema):
  - ``play``  -> ``project.play = True``
  - ``pause`` -> ``project.play = False``
  - ``seek``  -> ``me.time.frame = clamp(frame, [startFrame, endFrame])``
  - ``cue``   -> ``project.cue(name)`` (rejected if the cue is unknown)
  - ``rate``  -> ``project.rate = float(rate)``

Returns the §3.x timeline-state dict the Node tool already emits — same shape as
the legacy exec path, so the rewired tool can collapse both branches into one
result handler.
"""


def _state(td):
    """Snapshot the live timeline state in the documented shape."""
    project = td.project
    return {
        "play": bool(project.play),
        "frame": int(td.me.time.frame)
        if hasattr(td, "me")
        else int(project.startFrame),
        "rate": float(project.rate),
        "startFrame": int(project.startFrame),
        "endFrame": int(project.endFrame),
        "fps": float(getattr(project, "cookRate", 60.0)),
    }


def _play(td, _frame, _rate, _cue_name):
    td.project.play = True


def _pause(td, _frame, _rate, _cue_name):
    td.project.play = False


def _seek(td, frame, _rate, _cue_name):
    if frame is None:
        raise ValueError("seek requires `frame`.")
    project = td.project
    target = max(int(project.startFrame), min(int(frame), int(project.endFrame)))
    # ``me.time.frame`` is the documented way to scrub; project.frame is read-only
    # on some builds. The router does not have ``me`` in scope, so reach via ``td``.
    td.me.time.frame = target


def _cue(td, _frame, _rate, cue_name):
    if not cue_name:
        raise ValueError("cue requires `cueName`.")
    try:
        td.project.cue(cue_name)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("cue %r not found" % cue_name) from exc


def _rate(td, _frame, rate, _cue_name):
    if rate is None:
        raise ValueError("rate requires `rate`.")
    td.project.rate = float(rate)


_ACTIONS = {
    "play": _play,
    "pause": _pause,
    "seek": _seek,
    "cue": _cue,
    "rate": _rate,
}


def control(action, frame=None, rate=None, cue_name=None):
    """Drive the project timeline. Returns ``{action, ...state}``.

    Raises ``ValueError`` on missing/invalid args or an unknown cue, mirroring
    the exec script's cross-field validation. The router maps that to HTTP 400.
    """
    import td

    handler = _ACTIONS.get(action)
    if handler is None:
        raise ValueError("Unsupported transport action: %r" % action)
    handler(td, frame, rate, cue_name)

    state = _state(td)
    state["action"] = action
    return state
