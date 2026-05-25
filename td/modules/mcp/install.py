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
        "    return api_controller.handle(request, response)\n\n"
        "def onWebSocketOpen(webServerDAT, client, uri): return\n"
        "def onWebSocketReceiveText(webServerDAT, client, data): return\n"
        "def onWebSocketReceiveBinary(webServerDAT, client, data): return\n"
        "def onWebSocketReceivePing(webServerDAT, client, data):\n"
        "    webServerDAT.webSocketSendPong(client, data=data)\n"
        "def onWebSocketReceivePong(webServerDAT, client, data): return\n"
        "def onServerStart(webServerDAT): return\n"
        "def onServerStop(webServerDAT): return\n"
    )


def run(port=9980, parent_path="/project1", container="tdmcp_bridge", modules_dir=None, export_tox=None):
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

    if export_tox:
        comp.save(export_tox)

    print("[tdmcp] bridge running on port %d (%s)" % (port, comp.path))
    return comp


def uninstall(parent_path="/project1", container="tdmcp_bridge"):
    import td

    root = td.op(parent_path) or td.op("/")
    comp = root.op(container)
    if comp is not None:
        comp.destroy()
        print("[tdmcp] bridge removed")
