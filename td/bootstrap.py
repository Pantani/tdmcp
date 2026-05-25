"""One-paste TouchDesigner bridge bootstrap (no clone, no Preferences).

Paste this single line into the Textport (Dialogs -> Textport and DATs) and the
bridge installs itself and starts:

    import urllib.request; exec(urllib.request.urlopen("https://raw.githubusercontent.com/Pantani/tdmcp/main/td/bootstrap.py").read().decode())

It downloads just the bridge modules to ~/tdmcp-bridge/modules, puts them on
sys.path for this session, and runs install.run() -> a tdmcp_bridge on port 9980.

Requires the GitHub repo (or release zip) to be reachable. If your repo is
private, point REPO_ZIP at a public release asset, or use `install-bridge`
(`node dist/index.js install-bridge`) from a local checkout instead.
"""

import io
import os
import sys
import zipfile
import urllib.request

REPO_ZIP = "https://github.com/Pantani/tdmcp/archive/refs/heads/main.zip"
DEST = os.path.expanduser("~/tdmcp-bridge")
_MARKER = "/td/modules/"


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
    for name in zf.namelist():
        if name.endswith("/"):
            continue
        idx = name.find(_MARKER)
        if idx == -1:
            continue
        rel = name[idx + len(_MARKER):]
        if not rel:
            continue
        target = os.path.join(modules_dir, rel)
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
run()
