"""Compact, best-effort TouchDesigner editor context.

The result grounds deictic requests ("this node", "the selected node", "put it
here") without returning project topology.  UI-only fields are explicitly null
or empty when TouchDesigner is headless, in Perform Mode, or does not expose an
active pane API on the running build.
"""

_MAX_PANES = 32
_MAX_SELECTED = 64


def _path(value):
    try:
        path = value.path
        return str(path) if path else None
    except Exception:  # noqa: BLE001
        return None


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "")
    except Exception:  # noqa: BLE001
        return None


def _is_network_editor(pane):
    pane_type = _pane_type(pane)
    return (
        pane_type is not None and pane_type.upper().replace("_", "") == "NETWORKEDITOR"
    )


def _pane_summary(pane, active):
    out = {"type": _pane_type(pane), "active": bool(active)}
    try:
        name = pane.name
        if name is not None:
            out["name"] = str(name)
    except Exception:  # noqa: BLE001
        pass
    try:
        owner_path = _path(pane.owner)
        if owner_path is not None:
            out["owner"] = owner_path
    except Exception:  # noqa: BLE001
        pass
    return out


def _active_pane(panes):
    """Use only an explicit active/current pane property; never guess by order."""
    for attr in ("current", "currentPane"):
        try:
            pane = getattr(panes, attr)
        except Exception:  # noqa: BLE001
            continue
        if pane is not None:
            return pane
    return None


def _selected_paths(owner, warnings):
    try:
        selected = list(owner.selectedChildren or [])
    except Exception:  # noqa: BLE001
        warnings.append("Active Network Editor selection was unavailable.")
        return []
    if len(selected) > _MAX_SELECTED:
        warnings.append(
            "Active selection was truncated to %d operators." % _MAX_SELECTED
        )
    return [path for path in (_path(node) for node in selected[:_MAX_SELECTED]) if path]


def _rollover_parameter(ui):
    try:
        par = ui.rolloverPar
    except Exception:  # noqa: BLE001
        return None
    if par is None:
        return None
    try:
        name = str(par.name)
    except Exception:  # noqa: BLE001
        return None
    owner = _path(getattr(par, "owner", None))
    out = {"name": name}
    if owner is not None:
        out["owner"] = owner
    return out


def _network_editor_selection(pane, warnings):
    try:
        owner = pane.owner
    except Exception:  # noqa: BLE001
        owner = None
        warnings.append("Active Network Editor owner was unavailable.")

    current = None
    selected = []
    if owner is not None:
        try:
            current = _path(owner.currentChild)
        except Exception:  # noqa: BLE001
            warnings.append("Active Network Editor current operator was unavailable.")
        selected = _selected_paths(owner, warnings)

    return owner, current, selected


def _network_editor_viewport(pane, warnings):
    viewport = {}
    for name in ("x", "y", "zoom"):
        try:
            value = getattr(pane, name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                viewport[name] = value
        except Exception:  # noqa: BLE001
            pass
    if len(viewport) != 3:
        warnings.append("Active Network Editor viewport was partially unavailable.")
    return viewport or None


def _network_editor_context(pane, ui, warnings):
    owner, current, selected = _network_editor_selection(pane, warnings)
    viewport = _network_editor_viewport(pane, warnings)

    try:
        rollover_op = _path(ui.rolloverOp)
    except Exception:  # noqa: BLE001
        rollover_op = None

    return {
        "pane": _pane_summary(pane, True),
        "owner": _path(owner),
        "current": current,
        "selected": selected,
        "rollover_operator": rollover_op,
        "rollover_parameter": _rollover_parameter(ui),
        "viewport": viewport,
    }


def _safe_attr(source, name):
    return getattr(source, name, None) if source is not None else None


def _context_perform_mode(ui, project):
    for source in (ui, project):
        if source is None:
            continue
        try:
            return bool(getattr(source, "performMode"))
        except Exception:  # noqa: BLE001
            pass
    return None


def _project_context(td):
    project = getattr(td, "project", None)
    app = getattr(td, "app", None)
    ui = getattr(td, "ui", None)
    project_out = {
        "name": _safe_attr(project, "name"),
        "folder": _safe_attr(project, "folder"),
        "save_version": _safe_attr(project, "saveVersion"),
        "save_build": _safe_attr(project, "saveBuild"),
    }
    build_out = {
        "build": _safe_attr(app, "build"),
        "version": _safe_attr(app, "version"),
    }
    return project_out, build_out, _context_perform_mode(ui, project)


def get_editor_context():
    """Return project/build and bounded active-editor context without topology."""
    import td

    project_out, build_out, perform_mode = _project_context(td)
    report = {
        "project": project_out,
        "touchdesigner": build_out,
        "perform_mode": perform_mode,
        "ui_available": False,
        "panes": [],
        "active_network_editor": None,
        "warnings": [],
    }
    if perform_mode is True:
        report["warnings"].append(
            "TouchDesigner is in Perform Mode; editor panes and rollover context are intentionally unavailable."
        )
        return report
    ui = getattr(td, "ui", None)
    if ui is None:
        report["warnings"].append(
            "TouchDesigner UI is unavailable (headless or Perform Mode)."
        )
        return report

    panes_obj = getattr(ui, "panes", None)
    if panes_obj is None:
        report["warnings"].append("TouchDesigner UI pane collection is unavailable.")
        return report

    report["ui_available"] = True
    try:
        panes = list(panes_obj)
    except Exception:  # noqa: BLE001
        report["warnings"].append("TouchDesigner UI panes could not be enumerated.")
        return report

    active = _active_pane(panes_obj)
    if active is None:
        report["warnings"].append(
            "TouchDesigner did not expose an explicit active pane."
        )
    if len(panes) > _MAX_PANES:
        report["warnings"].append("Pane list was truncated to %d entries." % _MAX_PANES)
    report["panes"] = [
        _pane_summary(pane, pane is active) for pane in panes[:_MAX_PANES]
    ]

    if active is not None and _is_network_editor(active):
        report["active_network_editor"] = _network_editor_context(
            active, ui, report["warnings"]
        )
    elif active is not None:
        report["warnings"].append("The active pane is not a Network Editor.")
    return report
