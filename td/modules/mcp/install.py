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
        "        # Broadcast on a row-count delta OR a newest-row identity change. At\n"
        "        # the maxlines cap, clamp replaces old rows so numRows stops growing —\n"
        "        # tracking the newest (absframe, message) too keeps cook.error firing\n"
        "        # for fresh errors after the buffer fills (still <=1 per frame).\n"
        "        _ed = me.parent().op('error_log')\n"
        "        if _ed is not None and _ed.numRows > 0:\n"
        "            _rows = _ed.numRows - 1   # data rows, minus header\n"
        "            _prev = getattr(me, '_tdmcp_err_rows', 0)\n"
        "            _prev_new = getattr(me, '_tdmcp_err_newest', None)\n"
        "            _new = (str(_ed[_rows, 2]), str(_ed[_rows, 1])) if _rows > 0 else None\n"
        "            if _rows != _prev or _new != _prev_new:\n"
        "                me._tdmcp_err_rows = _rows\n"
        "                me._tdmcp_err_newest = _new\n"
        "                if _rows == 0:\n"
        "                    _broadcast('error.cleared', {'count': 0})\n"
        "                else:\n"
        "                    _broadcast('cook.error', {\n"
        "                        'source': str(_ed[_rows, 0]), 'message': str(_ed[_rows, 1]),\n"
        "                        'severity': str(_ed[_rows, 4]), 'type': str(_ed[_rows, 5]), 'count': _rows,\n"
        "                    })\n"
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


DEFAULT_PACKAGE_NAME = "tdmcp_bridge_package"
DEFAULT_PACKAGE_TOX_NAME = DEFAULT_PACKAGE_NAME + ".tox"
DEFAULT_PACKAGE_PALETTE_FOLDER = "tdmcp"
DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP = "https://github.com/Pantani/tdmcp/archive/refs/tags/v0.11.0.zip"
DEFAULT_PACKAGE_BOOTSTRAP_DEST = "~/tdmcp-bridge"

RUNTIME_BRIDGE_LAYOUT = {
    "callbacks": (-320, 120),
    "webserver": (0, 120),
    "webserver_callbacks": (0, -260),
    "events_hook": (0, -80),
    "error_log": (320, 120),
    "error_log_callbacks": (320, -80),
}


def _is_safe_package_segment(value):
    text = str(value)
    return (
        text != ""
        and text.strip() == text
        and text not in (".", "..")
        and "/" not in text
        and "\\" not in text
    )


def _package_tox_name(package_name):
    name = str(package_name or DEFAULT_PACKAGE_NAME)
    if name.lower().endswith(".tox"):
        name = name[:-4]
    if not _is_safe_package_segment(name):
        raise ValueError("package_name must be a single filename segment")
    return name + ".tox"


def _ensure_tox_path(path):
    import os

    if path is None or str(path).strip() == "":
        raise ValueError("package export path is required")
    text = os.path.expanduser(str(path))
    _root, ext = os.path.splitext(text)
    if not ext:
        return text + ".tox"
    if ext.lower() != ".tox":
        raise ValueError("package export path must end in .tox")
    return text


def palette_package_path(tox_name=DEFAULT_PACKAGE_TOX_NAME, palette_dir=None, home=None):
    """Return the default TouchDesigner Palette path for the bridge package .tox."""
    import os

    name = str(tox_name or DEFAULT_PACKAGE_TOX_NAME)
    expanded_name = os.path.expanduser(name)
    if os.path.isabs(expanded_name) or os.sep in expanded_name or (os.altsep and os.altsep in expanded_name):
        return _ensure_tox_path(expanded_name)

    if palette_dir is None:
        base_home = os.path.expanduser(str(home or "~"))
        palette_dir = os.path.join(
            base_home,
            "Documents",
            "Derivative",
            "Palette",
            DEFAULT_PACKAGE_PALETTE_FOLDER,
        )
    return _ensure_tox_path(os.path.join(os.path.expanduser(str(palette_dir)), expanded_name))


def package_callbacks_source(
    modules_dir=None,
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
):
    """Python source embedded in the package COMP's Parameter Execute DAT."""
    header = ""
    if modules_dir:
        header = (
            "import sys\n"
            "if %r not in sys.path:\n"
            "    sys.path.insert(0, %r)\n\n" % (modules_dir, modules_dir)
        )
    bootstrap_config = (
        "import io\n"
        "import os\n"
        "import sys\n"
        "import zipfile\n"
        "import urllib.request\n\n"
        "_REPO_ZIP = %r\n"
        "_BOOTSTRAP_DEST = %r\n"
        "_MARKER = '/td/modules/'\n\n" % (repo_zip, bootstrap_dest)
    )
    return header + bootstrap_config + (
        "def _add_module_path(modules_dir):\n"
        "    if modules_dir and modules_dir not in sys.path:\n"
        "        sys.path.insert(0, modules_dir)\n"
        "    return modules_dir\n\n"
        "def _is_symlink(info):\n"
        "    return ((info.external_attr >> 16) & 0o170000) == 0o120000\n\n"
        "def _safe_module_path(name, modules_dir):\n"
        "    idx = name.find(_MARKER)\n"
        "    if idx == -1:\n"
        "        return None\n"
        "    rel = name[idx + len(_MARKER):].replace('\\\\', '/')\n"
        "    if not rel or rel.endswith('/'):\n"
        "        return None\n"
        "    parts = rel.split('/')\n"
        "    if (\n"
        "        rel.startswith('/')\n"
        "        or rel.startswith('\\\\')\n"
        "        or (len(parts[0]) >= 2 and parts[0][1] == ':')\n"
        "        or any(part in ('', '.', '..') for part in parts)\n"
        "    ):\n"
        "        raise RuntimeError('[tdmcp package] Refusing unsafe archive entry: %s' % name)\n"
        "    root = os.path.realpath(modules_dir)\n"
        "    target = os.path.realpath(os.path.join(modules_dir, *parts))\n"
        "    if target != root and not target.startswith(root + os.sep):\n"
        "        raise RuntimeError('[tdmcp package] Refusing archive entry outside modules: %s' % name)\n"
        "    return target\n\n"
        "def fetch_modules(repo_zip=_REPO_ZIP, dest=_BOOTSTRAP_DEST):\n"
        "    dest = os.path.expanduser(str(dest or _BOOTSTRAP_DEST))\n"
        "    modules_dir = os.path.join(dest, 'modules')\n"
        "    try:\n"
        "        data = urllib.request.urlopen(repo_zip, timeout=30).read()\n"
        "    except Exception as exc:\n"
        "        raise RuntimeError(\n"
        "            '[tdmcp package] Could not download bridge modules from %r (%s). '\n"
        "            'Set Modules Dir to a local td/modules path or check the Repo Zip value.' % (repo_zip, exc)\n"
        "        )\n"
        "    zf = zipfile.ZipFile(io.BytesIO(data))\n"
        "    os.makedirs(modules_dir, exist_ok=True)\n"
        "    extracted = 0\n"
        "    for info in zf.infolist():\n"
        "        name = info.filename\n"
        "        if name.endswith('/'):\n"
        "            continue\n"
        "        target = _safe_module_path(name, modules_dir)\n"
        "        if target is None:\n"
        "            continue\n"
        "        if _is_symlink(info):\n"
        "            raise RuntimeError('[tdmcp package] Refusing symlink archive entry: %s' % name)\n"
        "        os.makedirs(os.path.dirname(target), exist_ok=True)\n"
        "        with zf.open(name) as src, open(target, 'wb') as out:\n"
        "            out.write(src.read())\n"
        "        extracted += 1\n"
        "    if extracted == 0:\n"
        "        raise RuntimeError('[tdmcp package] Downloaded archive had no td/modules tree')\n"
        "    print('[tdmcp package] bridge modules -> %s (%d files)' % (modules_dir, extracted))\n"
        "    return modules_dir\n\n"
        "def _ensure_modules(opts):\n"
        "    modules_dir = opts.get('modules_dir')\n"
        "    if modules_dir:\n"
        "        return _add_module_path(modules_dir)\n"
        "    modules_dir = fetch_modules(opts.get('repo_zip') or _REPO_ZIP, opts.get('bootstrap_dest') or _BOOTSTRAP_DEST)\n"
        "    opts['modules_dir'] = modules_dir\n"
        "    return _add_module_path(modules_dir)\n\n"
        "def _load_install(opts):\n"
        "    _ensure_modules(opts)\n"
        "    from mcp import install\n"
        "    return install\n\n"
        "def _bridge_opts(opts):\n"
        "    return {\n"
        "        'port': opts['port'],\n"
        "        'parent_path': opts['parent_path'],\n"
        "        'container': opts['container'],\n"
        "        'modules_dir': opts.get('modules_dir'),\n"
        "    }\n\n"
        "def _destroy_bridge(parent_path, container):\n"
        "    import td\n"
        "    root = td.op(parent_path) or td.op('/')\n"
        "    comp = root.op(container) if root is not None else None\n"
        "    if comp is not None:\n"
        "        comp.destroy()\n"
        "        return True\n"
        "    return False\n\n"
        "def _owner(source=None):\n"
        "    try:\n"
        "        return source.owner\n"
        "    except Exception:\n"
        "        pass\n"
        "    try:\n"
        "        return me.parent()\n"
        "    except Exception:\n"
        "        return None\n\n"
        "def _read(owner, name, default=None):\n"
        "    try:\n"
        "        par = getattr(owner.par, name)\n"
        "    except Exception:\n"
        "        return default\n"
        "    try:\n"
        "        value = par.eval()\n"
        "    except Exception:\n"
        "        try:\n"
        "            value = par.val\n"
        "        except Exception:\n"
        "            return default\n"
        "    if value in (None, '') and default is not None:\n"
        "        return default\n"
        "    return value\n\n"
        "def _write_status(owner, message):\n"
        "    try:\n"
        "        owner.par.Laststatus.val = message\n"
        "    except Exception:\n"
        "        pass\n"
        "    print('[tdmcp package] ' + message)\n\n"
        "def _as_bool(value):\n"
        "    if isinstance(value, str):\n"
        "        return value.strip().lower() in ('1', 'true', 'on', 'yes')\n"
        "    return bool(value)\n\n"
        "def _settings(owner):\n"
        "    modules_dir = str(_read(owner, 'Modulesdir', '') or '').strip() or None\n"
        "    repo_zip = str(_read(owner, 'Repozip', _REPO_ZIP) or _REPO_ZIP).strip() or _REPO_ZIP\n"
        "    bootstrap_dest = str(_read(owner, 'Bootstrapdest', _BOOTSTRAP_DEST) or _BOOTSTRAP_DEST).strip() or _BOOTSTRAP_DEST\n"
        "    return {\n"
        "        'port': int(_read(owner, 'Bridgeport', 9980) or 9980),\n"
        "        'parent_path': str(_read(owner, 'Parentpath', '/project1') or '/project1'),\n"
        "        'container': str(_read(owner, 'Container', 'tdmcp_bridge') or 'tdmcp_bridge'),\n"
        "        'modules_dir': modules_dir,\n"
        "        'repo_zip': repo_zip,\n"
        "        'bootstrap_dest': bootstrap_dest,\n"
        "    }\n\n"
        "def _configure_security(owner):\n"
        "    token = str(_read(owner, 'Token', '') or '').strip()\n"
        "    allow_exec = _as_bool(_read(owner, 'Allowexec', False))\n"
        "    if token:\n"
        "        os.environ['TDMCP_BRIDGE_TOKEN'] = token\n"
        "        print('[tdmcp package] TDMCP_BRIDGE_TOKEN set for this TD process')\n"
        "    else:\n"
        "        os.environ.pop('TDMCP_BRIDGE_TOKEN', None)\n"
        "        print('[tdmcp package] No Token set; cleared TDMCP_BRIDGE_TOKEN for this TD process')\n"
        "    if allow_exec:\n"
        "        os.environ['TDMCP_BRIDGE_ALLOW_EXEC'] = '1'\n"
        "        print('[tdmcp package] TDMCP_BRIDGE_ALLOW_EXEC=1; arbitrary exec endpoints enabled')\n"
        "    elif token:\n"
        "        os.environ.pop('TDMCP_BRIDGE_ALLOW_EXEC', None)\n"
        "        print('[tdmcp package] TDMCP_BRIDGE_ALLOW_EXEC unset; token-authenticated exec endpoints enabled')\n"
        "    else:\n"
        "        os.environ['TDMCP_BRIDGE_ALLOW_EXEC'] = '0'\n"
        "        print('[tdmcp package] TDMCP_BRIDGE_ALLOW_EXEC=0; arbitrary exec endpoints disabled')\n"
        "    return token, allow_exec\n\n"
        "def install_bridge(source=None, reinstall=False):\n"
        "    owner = _owner(source)\n"
        "    if owner is None:\n"
        "        raise RuntimeError('package owner not found')\n"
        "    opts = _settings(owner)\n"
        "    _configure_security(owner)\n"
        "    install = _load_install(opts)\n"
        "    if reinstall:\n"
        "        install.uninstall(parent_path=opts['parent_path'], container=opts['container'])\n"
        "    comp = install.run(**_bridge_opts(opts))\n"
        "    _write_status(owner, 'running at %s on port %s' % (comp.path, opts['port']))\n"
        "    return comp\n\n"
        "def uninstall_bridge(source=None):\n"
        "    owner = _owner(source)\n"
        "    if owner is None:\n"
        "        raise RuntimeError('package owner not found')\n"
        "    opts = _settings(owner)\n"
        "    removed = _destroy_bridge(opts['parent_path'], opts['container'])\n"
        "    if removed:\n"
        "        _write_status(owner, 'removed %s/%s' % (opts['parent_path'], opts['container']))\n"
        "    else:\n"
        "        _write_status(owner, 'not installed at %s/%s' % (opts['parent_path'], opts['container']))\n\n"
        "def status_bridge(source=None):\n"
        "    owner = _owner(source)\n"
        "    if owner is None:\n"
        "        raise RuntimeError('package owner not found')\n"
        "    opts = _settings(owner)\n"
        "    try:\n"
        "        import td\n"
        "        root = td.op(opts['parent_path']) or td.op('/')\n"
        "        comp = root.op(opts['container']) if root is not None else None\n"
        "    except Exception:\n"
        "        comp = None\n"
        "    if comp is None:\n"
        "        message = 'not installed at %s/%s' % (opts['parent_path'], opts['container'])\n"
        "    else:\n"
        "        webserver = comp.op('webserver') if hasattr(comp, 'op') else None\n"
        "        try:\n"
        "            active = bool(webserver.par.active.eval()) if webserver is not None else False\n"
        "        except Exception:\n"
        "            active = webserver is not None\n"
        "        message = 'installed at %s; webserver active=%s; port=%s' % (comp.path, active, opts['port'])\n"
        "    _write_status(owner, message)\n"
        "    return message\n\n"
        "def onPulse(par):\n"
        "    name = par.name\n"
        "    if name == 'Install':\n"
        "        install_bridge(par)\n"
        "    elif name == 'Reinstall':\n"
        "        install_bridge(par, reinstall=True)\n"
        "    elif name == 'Uninstall':\n"
        "        uninstall_bridge(par)\n"
        "    elif name == 'Status':\n"
        "        status_bridge(par)\n"
        "    return\n\n"
        "def onValueChange(par, prev): return\n"
        "def onValuesChanged(changes): return\n"
    )


def _package_readme_source(
    port,
    parent_path,
    container,
    modules_dir=None,
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
):
    modules_line = modules_dir or "(blank: download Repo Zip into Bootstrap Dest)"
    return (
        "tdmcp bridge Palette package\n"
        "============================\n\n"
        "Drag this COMP from the Palette into a project, then use its Bridge page:\n"
        "- Install: create or repair the bridge without deleting the package COMP.\n"
        "- Reinstall: remove the bridge container, then call install.run() again.\n"
        "- Uninstall: remove the bridge container with install.uninstall().\n"
        "- Status: print whether the bridge container and Web Server DAT exist.\n\n"
        "Default target:\n"
        "- port: %s\n"
        "- parent_path: %s\n"
        "- container: %s\n"
        "- modules_dir: %s\n\n"
        "Self-bootstrap fallback:\n"
        "- repo_zip: %s\n"
        "- bootstrap_dest: %s\n"
        "- Leave Modules Dir blank to download td/modules from Repo Zip.\n\n"
        "Security guidance:\n"
        "- Set Token to populate TDMCP_BRIDGE_TOKEN for this TD process.\n"
        "- Turn Allow Exec on only when you need /api/exec or node-method calls.\n"
        "- Firewall the Web Server DAT port to localhost on untrusted networks.\n"
    ) % (port, parent_path, container, modules_line, repo_zip, bootstrap_dest)


def _set_par_value(op_obj, name, value):
    try:
        par = getattr(op_obj.par, name)
    except Exception:
        return False
    try:
        par.val = value
        return True
    except Exception:
        try:
            setattr(op_obj.par, name, value)
            return True
        except Exception:
            return False


def _set_first_existing_par(op_obj, names, value):
    for name in names:
        if _set_par_value(op_obj, name, value):
            return True
    return False


def _append_custom_par(page, comp, kind, name, default=None, label=None):
    method = getattr(page, "append" + kind, None)
    if method is None:
        return None
    try:
        created = method(name, label=label)
    except TypeError:
        try:
            created = method(name)
        except Exception:
            return None
    except Exception:
        return None
    if default is not None:
        if isinstance(created, (list, tuple)):
            for par in created:
                try:
                    par.val = default
                except Exception:
                    pass
        _set_par_value(comp, name, default)
    return created


def _configure_parameter_execute(dat, comp):
    _set_first_existing_par(dat, ("active", "Active"), True)
    _set_first_existing_par(dat, ("op", "ops", "OP", "Ops"), comp.path)
    _set_first_existing_par(dat, ("pars", "parameters", "Pars", "Parameters"), "Install Reinstall Uninstall Status")
    _set_first_existing_par(dat, ("pulse", "onpulse", "Pulse", "Onpulse"), True)
    _set_first_existing_par(dat, ("valuechange", "Valuechange"), False)


def _set_node_position(node, x, y):
    try:
        node.nodeX = x
        node.nodeY = y
    except Exception:
        pass


def _layout_runtime_bridge(comp):
    _set_node_position(comp, -300, 0)
    for name, (x, y) in RUNTIME_BRIDGE_LAYOUT.items():
        try:
            child = comp.op(name)
        except Exception:
            child = None
        if child is not None:
            _set_node_position(child, x, y)


def _add_package_controls(comp, port, parent_path, container, modules_dir, repo_zip, bootstrap_dest):
    try:
        page = comp.appendCustomPage("Bridge")
    except Exception:
        return

    _append_custom_par(page, comp, "Pulse", "Install", label="Install")
    _append_custom_par(page, comp, "Pulse", "Reinstall", label="Reinstall")
    _append_custom_par(page, comp, "Pulse", "Uninstall", label="Uninstall")
    _append_custom_par(page, comp, "Pulse", "Status", label="Status")
    _append_custom_par(page, comp, "Int", "Bridgeport", port, label="Port")
    _append_custom_par(page, comp, "Str", "Parentpath", parent_path, label="Parent Path")
    _append_custom_par(page, comp, "Str", "Container", container, label="Container")
    _append_custom_par(page, comp, "Str", "Modulesdir", modules_dir or "", label="Modules Dir")
    _append_custom_par(page, comp, "Str", "Repozip", repo_zip, label="Repo Zip")
    _append_custom_par(page, comp, "Str", "Bootstrapdest", bootstrap_dest, label="Bootstrap Dest")
    _append_custom_par(page, comp, "Str", "Token", "", label="Token")
    _append_custom_par(page, comp, "Toggle", "Allowexec", False, label="Allow Exec")
    _append_custom_par(page, comp, "Str", "Laststatus", "not checked", label="Last Status")

    _set_par_value(comp, "Bridgeport", port)
    _set_par_value(comp, "Parentpath", parent_path)
    _set_par_value(comp, "Container", container)
    _set_par_value(comp, "Modulesdir", modules_dir or "")
    _set_par_value(comp, "Repozip", repo_zip)
    _set_par_value(comp, "Bootstrapdest", bootstrap_dest)
    _set_par_value(comp, "Allowexec", False)
    _set_par_value(comp, "Laststatus", "not checked")


def build_package(
    port=9980,
    parent_path="/project1",
    container="tdmcp_bridge",
    modules_dir=None,
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
    package_parent_path="/project1",
    package_name=DEFAULT_PACKAGE_NAME,
):
    """Build a Palette-style package COMP that can install the bridge inside TD."""
    import td

    if modules_dir:
        import sys

        if modules_dir not in sys.path:
            sys.path.insert(0, modules_dir)

    root = td.op(package_parent_path) or td.op("/")
    comp = root.op(package_name) or root.create(td.baseCOMP, package_name)

    callbacks_type = getattr(td, "parameterexecuteDAT", td.textDAT)
    callbacks = comp.op("package_callbacks") or comp.create(callbacks_type, "package_callbacks")
    try:
        callbacks.nodeX = -180
        callbacks.nodeY = 0
    except Exception:
        pass
    callbacks.text = package_callbacks_source(
        modules_dir,
        repo_zip=repo_zip,
        bootstrap_dest=bootstrap_dest,
    )
    _configure_parameter_execute(callbacks, comp)

    readme = comp.op("package_readme") or comp.create(td.textDAT, "package_readme")
    try:
        readme.nodeX = 180
        readme.nodeY = 0
    except Exception:
        pass
    readme.text = _package_readme_source(
        port,
        parent_path,
        container,
        modules_dir,
        repo_zip=repo_zip,
        bootstrap_dest=bootstrap_dest,
    )

    _add_package_controls(comp, port, parent_path, container, modules_dir, repo_zip, bootstrap_dest)

    try:
        comp.nodeX = -300
        comp.nodeY = 150
    except Exception:
        pass

    print("[tdmcp] package component ready at %s" % comp.path)
    return comp


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
        # Set the VALUE directly (a constant op path) — assigning .expr alone would
        # not switch the par into Expression mode, so it would keep its default/
        # constant fromop and never watch parent_path/error_scope.
        scope = error_scope or parent_path
        err.par.fromop.val = scope
    except Exception:
        pass

    _layout_runtime_bridge(comp)

    if export_tox:
        comp.save(export_tox)

    print("[tdmcp] bridge running on port %d (%s)" % (port, comp.path))
    print(
        "[tdmcp] SECURITY: the Web Server DAT listens on ALL network interfaces and, by "
        "default, refuses arbitrary Python endpoints (/api/exec and node-method) unless "
        "TDMCP_BRIDGE_TOKEN or TDMCP_BRIDGE_ALLOW_EXEC=1 is set. On a shared/untrusted "
        "network, keep exec disabled, set TDMCP_BRIDGE_TOKEN for authenticated use, "
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


def export_package(
    path,
    port=9980,
    parent_path="/project1",
    container="tdmcp_bridge",
    modules_dir=None,
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
    package_parent_path="/project1",
    package_name=DEFAULT_PACKAGE_NAME,
):
    """Build the package COMP in live TD and save it as a .tox package file."""
    import os

    tox_path = _ensure_tox_path(path)
    folder = os.path.dirname(tox_path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    comp = build_package(
        port=port,
        parent_path=parent_path,
        container=container,
        modules_dir=modules_dir,
        repo_zip=repo_zip,
        bootstrap_dest=bootstrap_dest,
        package_parent_path=package_parent_path,
        package_name=package_name,
    )
    comp.save(tox_path)
    print("[tdmcp] package exported to %s" % tox_path)
    return comp


def export_package_to_palette(
    tox_name=DEFAULT_PACKAGE_TOX_NAME,
    palette_dir=None,
    home=None,
    port=9980,
    parent_path="/project1",
    container="tdmcp_bridge",
    modules_dir=None,
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
    package_parent_path="/project1",
    package_name=DEFAULT_PACKAGE_NAME,
):
    """Build and save the package .tox under TouchDesigner's user Palette folder."""
    path = palette_package_path(tox_name=tox_name, palette_dir=palette_dir, home=home)
    return export_package(
        path,
        port=port,
        parent_path=parent_path,
        container=container,
        modules_dir=modules_dir,
        repo_zip=repo_zip,
        bootstrap_dest=bootstrap_dest,
        package_parent_path=package_parent_path,
        package_name=package_name,
    )


def export_palette_package(
    modules_dir=None,
    package_name=DEFAULT_PACKAGE_NAME,
    palette_dir=None,
    port=9980,
    parent_path="/project1",
    container="tdmcp_bridge",
    package_parent_path="/project1",
    repo_zip=DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
    bootstrap_dest=DEFAULT_PACKAGE_BOOTSTRAP_DEST,
):
    """Build and save the bridge package using the CLI-friendly argument order."""
    tox_name = _package_tox_name(package_name)
    return export_package_to_palette(
        tox_name=tox_name,
        palette_dir=palette_dir,
        port=port,
        parent_path=parent_path,
        container=container,
        modules_dir=modules_dir,
        package_parent_path=package_parent_path,
        package_name=tox_name[:-4],
        repo_zip=repo_zip,
        bootstrap_dest=bootstrap_dest,
    )


def uninstall(parent_path="/project1", container="tdmcp_bridge"):
    import td

    root = td.op(parent_path) or td.op("/")
    comp = root.op(container)
    if comp is not None:
        comp.destroy()
        print("[tdmcp] bridge removed")
