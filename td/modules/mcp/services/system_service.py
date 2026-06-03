"""System info — first-class endpoint for `inspect_gpu_and_displays`.

Returns the combined ``{gpu, monitors, performMode}`` snapshot in a single
round-trip so the Node-side tool collapses three legacy exec reads into one
REST call. Pure functions; reach TD globals via ``import td`` INSIDE the
function so the module imports cleanly off-TD (mirrors
``mcp/services/transport_service.py``).

Best-effort by section: if `td.gpu`, `app.monitors`, or `project.performMode`
isn't available on this TD build, that section degrades to ``{"error": "..."}``
(monitors/gpu) or ``None`` (performMode) rather than failing the whole endpoint.

NOT gated by ``TDMCP_BRIDGE_ALLOW_EXEC`` — read-only inspection, must survive
the hardened config the same way ``transport_service`` does.
"""


def _read_gpu(td):
    """Snapshot host GPU info. Returns dict or {'error': ...}."""
    try:
        gpu = getattr(td, "gpu", None)
        name = getattr(gpu, "name", None) if gpu else None
        if name is None:
            # Fallback to app.gpuName on builds where td.gpu is absent.
            app = getattr(td, "app", None)
            name = getattr(app, "gpuName", None) if app is not None else None
        return {
            "name": name,
            "driver": getattr(gpu, "driver", None) if gpu else None,
            "memory": getattr(gpu, "memory", None) if gpu else None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def _read_monitors(td):
    """Snapshot the monitor topology. Returns list or {'error': ...}."""
    try:
        app = getattr(td, "app", None)
        monitors = getattr(app, "monitors", None) if app is not None else None
        if monitors is None:
            return {"error": "app.monitors unavailable on this TD build"}
        out = []
        for i, mon in enumerate(monitors):
            out.append(
                {
                    "index": i,
                    "width": getattr(mon, "width", None),
                    "height": getattr(mon, "height", None),
                    "refreshRate": getattr(mon, "refreshRate", None),
                    "isPrimary": getattr(mon, "isPrimary", None),
                    "left": getattr(mon, "left", None),
                    "top": getattr(mon, "top", None),
                }
            )
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def _read_perform_mode(td):
    """Snapshot Perform Mode flag. Returns bool or None on failure."""
    try:
        project = getattr(td, "project", None)
        if project is None:
            return None
        return bool(project.performMode)
    except Exception:  # noqa: BLE001
        return None


def set_perform_mode(enabled):
    """Toggle perform-mode advisory flag + best-effort native ui/project knobs.

    Promotes the legacy ``/api/exec`` payload of ``set_perform_mode`` to a
    first-class REST handler so the tool survives ``TDMCP_BRIDGE_ALLOW_EXEC=0``.
    Returns a report that is a SUPERSET of the legacy ``PerformModeReport``
    (adds ``project_perform_mode_set``) so the Node tool produces an
    identical artist-visible summary regardless of which path served it.
    """
    import td

    flag = bool(enabled)
    report = {
        "enabled": flag,
        "was": False,
        "stored": False,
        "ui_perform_mode_set": False,
        "project_perform_mode_set": False,
        "warnings": [],
    }

    op_fn = getattr(td, "op", None)
    if op_fn is None:
        report["warnings"].append("td.op unavailable; advisory flag not stored.")
    else:
        try:
            root = op_fn("/")
            report["was"] = bool(root.fetch("tdmcp_perform_mode", False))
            root.store("tdmcp_perform_mode", flag)
            report["stored"] = root.fetch("tdmcp_perform_mode", None) is flag
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("store failed: %s" % exc)

    ui = getattr(td, "ui", None)
    if ui is not None and hasattr(ui, "performMode"):
        try:
            ui.performMode = flag
            report["ui_perform_mode_set"] = True
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("ui.performMode write failed: %s" % exc)
    else:
        report["warnings"].append(
            "ui.performMode not found on this TD build — flag stored but no native knob adjusted."
        )

    project = getattr(td, "project", None)
    if project is not None and hasattr(project, "performMode"):
        try:
            project.performMode = flag
            report["project_perform_mode_set"] = True
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("project.performMode write failed: %s" % exc)

    return report


def get_system_info(include=None):
    """Combined system snapshot for the inspect_gpu_and_displays tool.

    ``include`` — optional iterable of section names ("gpu", "monitors",
    "performMode"); when omitted, all three sections are returned. Unknown
    section names are ignored (forward-compat with newer Node clients).
    """
    import td

    want = set(include) if include else {"gpu", "monitors", "performMode"}
    out = {}
    if "gpu" in want:
        out["gpu"] = _read_gpu(td)
    if "monitors" in want:
        out["monitors"] = _read_monitors(td)
    if "performMode" in want:
        out["performMode"] = _read_perform_mode(td)
    return out
