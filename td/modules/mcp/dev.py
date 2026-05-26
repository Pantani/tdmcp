"""Developer helper: hot-reload the bridge's Python in a running TouchDesigner.

Editing files under ``td/`` does NOT reload the modules already imported by a running
TouchDesigner, so the bridge keeps serving the stale code it loaded at project open.
After editing the bridge, call :func:`reload_bridge` -- from the Textport
(``from mcp import dev; dev.reload_bridge()``) or via the ``execute_python_script``
tool -- to pick up the changes without reopening the project.
"""

import importlib
import sys


def reload_bridge():
    """Reimport every loaded ``mcp.*`` / ``utils.*`` module, deepest first.

    Controllers import service modules as module objects (``from mcp.services import x``),
    so reloading the modules in place propagates the new functions to their callers.
    Modules are reloaded deepest-first so packages re-bind to freshly reloaded submodules.

    Returns the list of reloaded module names.
    """
    targets = [
        name
        for name in sys.modules
        if name in ("mcp", "utils") or name.startswith("mcp.") or name.startswith("utils.")
    ]
    targets.sort(key=lambda name: name.count("."), reverse=True)
    reloaded = []
    for name in targets:
        module = sys.modules.get(name)
        if module is None:
            continue
        try:
            importlib.reload(module)
            reloaded.append(name)
        except Exception:
            # A module that fails to reload (e.g. caught mid-edit) must not abort the rest.
            pass
    return reloaded
