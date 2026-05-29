"""One-call installer for the tdmcp bridge.

Once `td/modules` is on TouchDesigner's Python module path (Preferences ->
"Python 64-bit Module Path"), an artist can bring the whole bridge up with a
single line in the Textport:

    from mcp import install; install.run()

It creates a tidy `tdmcp_bridge` base COMP containing a Web Server DAT (port
9980) and its callbacks, then activates it. Idempotent: re-running reconfigures
the existing ops. Pass `export_tox="/path/mcp_webserver_base.tox"` to also save a
reusable component you can drag into any project.
"""


def _callbacks_source(modules_dir=None):
    header = ""
    if modules_dir:
        header = (
            "import sys\n"
            "if %r not in sys.path:\n"
            "    sys.path.insert(0, %r)\n\n" % (modules_dir, modules_dir)
        )
    return header + (
        "def onHTTPRequest(webServerDAT, request, response):\n"
        "    from mcp.controllers import api_controller  # per-request: hot-reloads after cache clear\n"
        "    return api_controller.handle(request, response, webServerDAT)\n\n"
        "def onWebSocketOpen(webServerDAT, client, uri): return\n"
        "def onWebSocketReceiveText(webServerDAT, client, data): return\n"
        "def onWebSocketReceiveBinary(webServerDAT, client, data): return\n"
        "def onWebSocketReceivePing(webServerDAT, client, data):\n"
        "    webServerDAT.webSocketSendPong(client, data=data)\n"
        "def onWebSocketReceivePong(webServerDAT, client, data): return\n"
        "def onServerStart(webServerDAT): return\n"
        "def onServerStop(webServerDAT): return\n"
    )


def _event_hooks_source(modules_dir=None):
    header = ""
    if modules_dir:
        header = (
            "import sys\n"
            "if %r not in sys.path:\n"
            "    sys.path.insert(0, %r)\n\n" % (modules_dir, modules_dir)
        )
    return header + (
        "def _broadcast(event, data):\n"
        "    try:\n"
        "        from mcp import events\n"
        "        events.broadcast(me.parent().op('webserver'), event, data)\n"
        "    except Exception:\n"
        "        pass\n\n"
        "def onFrameEnd(frame):\n"
        "    try:\n"
        "        f = int(frame)\n"
        "        if f % 30 == 0:\n"
        "            _broadcast('timeline.frame', {'frame': f, 'seconds': float(absTime.seconds)})\n"
        "        if f % 120 == 0:\n"
        "            scope = me.parent().parent()\n"
        "            if scope is not None:\n"
        "                emitted = 0\n"
        "                for child in scope.findChildren(depth=3):\n"
        "                    try:\n"
        "                        ct = float(getattr(child, 'cookTime', 0.0) or 0.0)\n"
        "                    except Exception:\n"
        "                        ct = 0.0\n"
        "                    if ct > 5.0:\n"
        "                        _broadcast('node.cook', {'path': child.path, 'cook_time_ms': ct})\n"
        "                        emitted += 1\n"
        "                        if emitted >= 10:\n"
        "                            break\n"
        "        # Edge-triggered cook.error / error.cleared from the bridge Error DAT.\n"
        "        # Broadcast only on a row-count delta (low-frequency, so it survives the\n"
        "        # event stream's high-frequency drop with no TDMCP_EVENTS opt-in).\n"
        "        _ed = me.parent().op('error_log')\n"
        "        if _ed is not None and _ed.numRows > 0:\n"
        "            _rows = _ed.numRows - 1   # minus header\n"
        "            _prev = getattr(me, '_tdmcp_err_rows', 0)\n"
        "            if _rows != _prev:\n"
        "                me._tdmcp_err_rows = _rows\n"
        "                if _rows > _prev:\n"
        "                    _r = _ed.numRows - 1   # newest error row\n"
        "                    _broadcast('cook.error', {\n"
        "                        'source': str(_ed[_r, 0]), 'message': str(_ed[_r, 1]),\n"
        "                        'severity': str(_ed[_r, 4]), 'type': str(_ed[_r, 5]), 'count': _rows,\n"
        "                    })\n"
        "                elif _rows == 0:\n"
        "                    _broadcast('error.cleared', {'count': 0})\n"
        "    except Exception:\n"
        "        pass\n\n"
        "def onProjectPostSave():\n"
        "    try:\n"
        "        _broadcast('project.saved', {'filename': project.name})\n"
        "    except Exception:\n"
        "        pass\n\n"
        "def onStart(): return\n"
        "def onCreate(): return\n"
    )


def run(
    port=9980,
    parent_path="/project1",
    container="tdmcp_bridge",
    modules_dir=None,
    export_tox=None,
    error_scope=None,
):
    import td  # TouchDesigner globals are only available via the td module here

    if modules_dir:
        import sys

        if modules_dir not in sys.path:
            sys.path.insert(0, modules_dir)

    root = td.op(parent_path) or td.op("/")
    comp = root.op(container) or root.create(td.baseCOMP, container)

    callbacks = comp.op("callbacks") or comp.create(td.textDAT, "callbacks")
    callbacks.text = _callbacks_source(modules_dir)

    server = comp.op("webserver") or comp.create(td.webserverDAT, "webserver")
    server.par.port = port
    server.par.callbacks = callbacks
    server.par.active = True

    # Execute DAT that emits project.saved / timeline.frame events over WebSocket.
    hooks = comp.op("events_hook") or comp.create(td.executeDAT, "events_hook")
    hooks.text = _event_hooks_source(modules_dir)
    hooks.par.active = True
    hooks.par.frameend = True
    hooks.par.projectpostsave = True

    # Error DAT: structured cook-error/warning capture for GET /api/logs + the
    # edge-triggered cook.error / error.cleared events. Idempotent like the rest.
    # The path /<container>/error_log must stay in sync with log_service.get_logs'
    # error_dat_path default and getBridgeLogs' fallback assumption.
    err = comp.op("error_log") or comp.create(td.errorDAT, "error_log")
    err.par.active = True
    err.par.maxlines = 200  # default 10 is too small for a show
    err.par.clamp = True  # keep newest within maxlines
    err.par.severity = "*"  # capture errors AND warnings
    err.par.source = "*"
    try:
        # Watch the artist's whole network by default (not just the bridge container).
        scope = error_scope or parent_path
        err.par.fromop.expr = repr(scope)
    except Exception:
        pass

    if export_tox:
        comp.save(export_tox)

    print("[tdmcp] bridge running on port %d (%s)" % (port, comp.path))
    print(
        "[tdmcp] SECURITY: the Web Server DAT listens on ALL network interfaces and, by "
        "default, executes arbitrary Python (the /api/exec and node-method endpoints) with "
        "no authentication. On a shared/untrusted network, harden it: (1) set the "
        "TDMCP_BRIDGE_TOKEN env var (same value on the Node server) to require a bearer "
        "token; (2) set TDMCP_BRIDGE_ALLOW_EXEC=0 to refuse the arbitrary-code endpoints; "
        "and/or firewall port %d to localhost." % port
    )
    return comp


def export(path, modules_dir=None, port=9980, parent_path="/project1", container="tdmcp_bridge"):
    """Build the bridge and save it as a reusable .tox you can drag into any project.

    Run this once in your own TouchDesigner, commit the resulting .tox, and from
    then on the bridge install is just drag-and-drop. Pass `modules_dir` (the
    absolute path to `td/modules`) to bake the import path into the .tox so it
    keeps working in projects that don't have that folder on the Preferences
    "Python 64-bit Module Path"; otherwise the target machine still needs it set.

        from mcp import install
        install.export("/path/to/mcp_webserver_base.tox")
    """
    return run(
        port=port,
        parent_path=parent_path,
        container=container,
        modules_dir=modules_dir,
        export_tox=path,
    )


def uninstall(parent_path="/project1", container="tdmcp_bridge"):
    import td

    root = td.op(parent_path) or td.op("/")
    comp = root.op(container)
    if comp is not None:
        comp.destroy()
        print("[tdmcp] bridge removed")
