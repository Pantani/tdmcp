"""Structured TouchDesigner project save primitives.

This service deliberately exposes only ``project.save``.  It never opens a
native file dialog, loads/quits a project, or evaluates arbitrary Python, so it
continues to work with ``TDMCP_BRIDGE_ALLOW_EXEC=0``.

An overwrite claim is an internal controller/service boundary object.  The HTTP
router must construct it only after consuming a matching resolved broker ticket;
it must never copy a client-supplied object into ``overwrite_approval``.
"""

import os
import re

_MAX_PATH_LENGTH = 4096
_UNSAVED_PLACEHOLDER_RE = re.compile(r"^NewProject\.\d+\.toe$", re.IGNORECASE)


def _normalize_toe_path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("project save: path must be a non-empty string")
    path = value.strip()
    if len(path) > _MAX_PATH_LENGTH:
        raise ValueError("project save: path exceeds %d characters" % _MAX_PATH_LENGTH)
    if "\x00" in path or "\n" in path or "\r" in path:
        raise ValueError("project save: path contains forbidden control characters")
    if not os.path.isabs(path):
        raise ValueError("project save: Save As path must be absolute")
    path = os.path.normpath(path)
    if os.path.splitext(path)[1].lower() != ".toe":
        raise ValueError("project save: Save As path must end in .toe")
    return path


def normalize_project_path(value):
    """Public controller boundary for the exact Save As path normalization."""
    return _normalize_toe_path(value)


def _current_project_path(project):
    """Return the current saved ``.toe`` path, or ``None`` for an untitled project."""
    name = getattr(project, "name", None)
    folder = getattr(project, "folder", None)
    if not isinstance(name, str) or not name.lower().endswith(".toe"):
        return None
    # TD 2025 labels an unsaved session ``NewProject.<n>.toe`` and may point its
    # folder at the desktop. A stale, unrelated file can therefore exist at the
    # inferred path. The Project API exposes no reliable saved/untitled flag on
    # this build, so treat the native placeholder as ambiguous and require an
    # explicit Save As path even when a same-named file happens to exist.
    if _UNSAVED_PLACEHOLDER_RE.fullmatch(name):
        return None
    if not isinstance(folder, str) or not folder.strip():
        return None
    candidate = os.path.normpath(os.path.join(folder, name))
    # TD 2025 can expose an unsaved placeholder such as ``NewProject.1.toe``
    # through name/folder. Calling project.save() in that state opens the native
    # Save As dialog and blocks the Web Server callback. Disk presence is the
    # conservative saved-state proof: without it, require an explicit path.
    return candidate if os.path.isfile(candidate) else None


def _approval_matches(approval, target_path):
    """Validate the narrow claim emitted after broker ticket consumption."""
    if not isinstance(approval, dict):
        return False
    try:
        approved_path = _normalize_toe_path(approval.get("target_path"))
    except ValueError:
        return False
    return (
        approval.get("kind") == "save_overwrite"
        and approval.get("state") == "resolved"
        and approval.get("choice") == "Overwrite"
        and approved_path == target_path
    )


def _project_metadata(td, final_path):
    project = td.project
    app = getattr(td, "app", None)
    return {
        "name": getattr(project, "name", None),
        "folder": getattr(project, "folder", None),
        "save_version": getattr(project, "saveVersion", None),
        "save_build": getattr(project, "saveBuild", None),
        "final_path": final_path,
        "td_build": getattr(app, "build", None) if app is not None else None,
        "td_version": getattr(app, "version", None) if app is not None else None,
    }


def _resolve_save_target(project, path, overwrite_approval):
    current_path = _current_project_path(project)
    requested_path = None if path is None else _normalize_toe_path(path)
    if requested_path is None:
        if current_path is None:
            raise ValueError("project save: untitled project requires an explicit Save As path")
        return requested_path, current_path, "save"
    if current_path is not None and requested_path == current_path:
        return requested_path, requested_path, "save"
    if not os.path.isfile(requested_path):
        return requested_path, requested_path, "save_as"
    if not _approval_matches(overwrite_approval, requested_path):
        raise PermissionError(
            "project save: existing Save As target requires resolved Overwrite approval"
        )
    return requested_path, requested_path, "overwrite"


def _perform_save(project, target_path, decision):
    try:
        if decision == "save":
            project.save()
        else:
            project.save(target_path)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("project save: project.save failed: %s" % exc)


def _verified_final_path(project, target_path, decision):
    final_path = target_path
    if decision == "save":
        final_path = _current_project_path(project) or target_path
    if not os.path.isfile(final_path):
        raise IOError("project save: file was not present after project.save: %s" % final_path)
    return final_path


def save_project(path=None, overwrite_approval=None):
    """Save the current project, optionally to an explicit absolute ``.toe`` path.

    Existing Save As targets fail closed unless ``overwrite_approval`` is a
    matching internal resolved broker claim.  The claim is intentionally more
    specific than a boolean so an approval for one path cannot authorize another.
    A save is successful only after the resulting file is visible on disk.
    """
    import td

    project = getattr(td, "project", None)
    if project is None or not hasattr(project, "save"):
        raise RuntimeError("project save: TouchDesigner project.save is unavailable")

    requested_path, target_path, decision = _resolve_save_target(
        project, path, overwrite_approval
    )
    _perform_save(project, target_path, decision)
    final_path = _verified_final_path(project, target_path, decision)

    return {
        "requested_path": requested_path,
        "final_path": final_path,
        "decision": decision,
        "verified_exists": True,
        "project": _project_metadata(td, final_path),
    }
