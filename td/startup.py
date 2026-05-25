# tdmcp bridge auto-start (Execute DAT).
#
# Easiest path (no DAT at all): once td/modules is on the Preferences module
# path, just paste this into the Textport once:
#
#     from mcp import install; install.run()
#
# This file is the "run automatically on every project open" version: paste it
# into an Execute DAT and turn ON its "Start" and "Create" toggles. Put that
# Execute DAT in your Default Project template to make it global for new projects.
#
# If you did NOT add td/modules to the Preferences module path, set MODULES_DIR
# to its absolute path below.

MODULES_DIR = ""


def _install():
    if MODULES_DIR:
        import sys

        if MODULES_DIR not in sys.path:
            sys.path.insert(0, MODULES_DIR)
    from mcp import install

    install.run(modules_dir=MODULES_DIR or None)


def onStart():
    _install()


def onCreate():
    _install()
