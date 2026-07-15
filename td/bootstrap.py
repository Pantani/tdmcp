"""One-paste TouchDesigner bridge bootstrap (no clone, no Preferences).

Paste this single line into the Textport (Dialogs -> Textport and DATs) and the
bridge installs itself and starts:

    import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.13.1/td/bootstrap.py").read().decode())

That release-pinned snippet downloads just the bridge modules to
~/tdmcp-bridge/modules, puts them on sys.path for this session, and runs
install.run() -> a tdmcp_bridge on port 9980.

Requires the GitHub repo (or release zip) to be reachable. If your repo is
private, point REPO_ZIP at a public release asset, or use `install-bridge`
(`node dist/index.js install-bridge`) from a local checkout instead.
"""

import io
import os
import stat
import sys
import zipfile
import urllib.request

REPO_ZIP = "https://github.com/Pantani/tdmcp/archive/refs/tags/v0.13.1.zip"
DEST = os.path.expanduser("~/tdmcp-bridge")
_MARKER = "/td/modules/"
_SKIP_RUN_ENV = "TDMCP_BOOTSTRAP_SKIP_RUN"


def _is_symlink(info):
    return stat.S_ISLNK((info.external_attr >> 16) & 0o170000)


def _safe_module_path(name, modules_dir):
    idx = name.find(_MARKER)
    if idx == -1:
        return None

    rel = name[idx + len(_MARKER):].replace("\\", "/")
    if not rel or rel.endswith("/"):
        return None

    parts = rel.split("/")
    if (
        rel.startswith("/")
        or rel.startswith("\\")
        or (len(parts[0]) >= 2 and parts[0][1] == ":")
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise RuntimeError("[tdmcp] Refusing unsafe archive entry: %s" % name)

    root = os.path.realpath(modules_dir)
    target = os.path.realpath(os.path.join(modules_dir, *parts))
    if target != root and not target.startswith(root + os.sep):
        raise RuntimeError("[tdmcp] Refusing archive entry outside modules: %s" % name)

    return target


def fetch_modules(repo_zip=REPO_ZIP, dest=DEST):
    """Download the repo zip and extract only its td/modules tree into dest/modules."""
    modules_dir = os.path.join(dest, "modules")
    try:
        data = urllib.request.urlopen(repo_zip, timeout=30).read()
    except Exception as exc:  # noqa: BLE001 - surface a friendly hint in the Textport
        raise RuntimeError(
            "[tdmcp] Could not download the bridge from %r (%s). If the repo is "
            "private, use a public release asset or the local 'install-bridge' "
            "command instead." % (repo_zip, exc)
        )

    zf = zipfile.ZipFile(io.BytesIO(data))
    os.makedirs(modules_dir, exist_ok=True)
    extracted = 0
    for info in zf.infolist():
        name = info.filename
        if name.endswith("/"):
            continue
        target = _safe_module_path(name, modules_dir)
        if target is None:
            continue
        if _is_symlink(info):
            raise RuntimeError("[tdmcp] Refusing symlink archive entry: %s" % name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(name) as src, open(target, "wb") as out:
            out.write(src.read())
        extracted += 1

    if extracted == 0:
        raise RuntimeError("[tdmcp] Downloaded archive had no td/modules — wrong REPO_ZIP?")
    print("[tdmcp] bridge modules -> %s (%d files)" % (modules_dir, extracted))
    return modules_dir


def run(repo_zip=REPO_ZIP, dest=DEST, port=9980):
    modules_dir = fetch_modules(repo_zip, dest)
    if modules_dir not in sys.path:
        sys.path.insert(0, modules_dir)
    from mcp import install

    return install.run(port=port, modules_dir=modules_dir)


# Running via exec(urlopen(...).read()) or as a script kicks off the install.
if os.environ.get(_SKIP_RUN_ENV) != "1":
    run()
