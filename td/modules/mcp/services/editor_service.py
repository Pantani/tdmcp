"""Network Editor navigation — pan/zoom the editor to follow what the agent builds.

A "follow system": after the agent creates or arranges a network, point the Network
Editor pane at it and home on the new operators (TD animates the pan/zoom), so the
artist sees the work appear instead of hunting for it. UI-only — it changes nothing
in the project graph.
"""

import td

op = td.op  # TD globals are not available inside imported modules; reach via td


def _get_ui():
    """The TouchDesigner `ui` global, or None off-TD / in a headless build."""
    return getattr(td, "ui", None)


def _network_editor_pane(ui):
    """First pane that can home on a selection — i.e. a Network Editor pane."""
    for pane in getattr(ui, "panes", None) or []:
        if hasattr(pane, "homeSelected"):
            return pane
    return None


def focus(paths, animate=True):
    """Frame the given operators in a Network Editor pane (TD animates the move).

    Points the pane at the operators' parent network, selects them, and homes on the
    selection with zoom. Raises when no target resolves or no Network Editor pane
    exists (e.g. a headless/perform-only session).
    """
    ops = [node for node in (op(path) for path in paths or []) if node is not None]
    if not ops:
        raise ValueError("No matching operators to focus: %r" % (paths,))
    ui = _get_ui()
    pane = _network_editor_pane(ui) if ui is not None else None
    if pane is None:
        raise RuntimeError(
            "No Network Editor pane available to focus (is TouchDesigner running with its UI?)."
        )
    parent = ops[0].parent()
    if parent is not None:
        pane.owner = parent
    for node in ops:
        node.selected = True
    pane.homeSelected(zoom=True)
    return {
        "focused": [node.path for node in ops],
        "pane": getattr(pane, "name", None),
        "animate": bool(animate),
    }
