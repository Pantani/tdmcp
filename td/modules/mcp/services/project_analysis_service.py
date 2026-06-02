"""Project diagnostic scan — first-class endpoint for ``analyze_project``.

Mirrors ``transport_service`` / ``system_service``: pure function, reach TD
globals (``op``, ``ParMode``) via ``import td`` INSIDE the function so the
module imports cleanly off-TD. Walks the descendants of a root COMP and reports
likely-unused operators, broken external-file dependencies, orphan COMPs, plus
a who-references-whom dependency map.

Read-only. Best-effort by field: every per-parameter / per-node probe is wrapped
in try/except so a single quirky attribute degrades into a warning instead of
killing the whole scan. Output shape is the SAME dict the legacy
``/api/exec`` script printed, so the rewired Node tool collapses both branches
through ``parsePythonReport`` into one result handler.

NOT gated by ``TDMCP_BRIDGE_ALLOW_EXEC`` — diagnostic inspection must survive
the hardened config the same way ``transport_service`` does.

Returned shape (every key always present, ``fatal`` only on root-not-found):
    {
      "path": str, "recursive": bool,
      "counts": {"nodes": int, "by_family": {fam: int}},
      "unused": [{"path", "type", "reason"}, ...],
      "broken_file_deps": [{"path", "par", "file"}, ...],
      "orphan_comps": [{"path", "reason"}, ...],
      "dependency_map": {src_path: [dep_path, ...]},
      "warnings": [str, ...],
      "fatal": str  # optional
    }
"""

import os
import re

# op('...') / op("...") inside an expression — capture the referenced name/path.
_OPREF = re.compile(r"op\(\s*['\"]([^'\"]+)['\"]\s*\)")
# Source-style parameter names that name another operator (Select ops + converters).
_SRC_PARS = ("top", "chop", "sop", "dat", "mat")
_FILE_PAR_HINTS = ("file", "moviefile", "imagefile", "soundfile", "fbxfile", "objfile")


def _opref_names(text):
    try:
        return list(_OPREF.findall(text or ""))
    except Exception:  # noqa: BLE001
        return []


def _resolve(owner, ref, op_global):
    """Resolve a name/relative path against the owner first, then globally."""
    try:
        r = owner.op(ref)
        if r is not None:
            return r
    except Exception:  # noqa: BLE001
        pass
    try:
        return op_global(ref)
    except Exception:  # noqa: BLE001
        return None


def _children(root, recursive):
    """``findChildren(maxDepth=)`` for recursive, ``depth=1`` for shallow."""
    try:
        if recursive:
            return list(root.findChildren(maxDepth=9999))
        return list(root.findChildren(depth=1))
    except Exception:  # noqa: BLE001
        try:
            return list(root.findChildren())
        except Exception:  # noqa: BLE001
            return []


def _expression_mode(kids):
    """Derive ``ParMode.EXPRESSION`` from a live ``par.mode`` (ParMode not global)."""
    for c in kids:
        try:
            for pr in c.pars():
                return type(pr.mode).EXPRESSION
        except Exception:  # noqa: BLE001
            continue
    return None


def analyze(path, recursive=True):
    """Diagnostic scan of ``path``'s descendants. Read-only.

    See module docstring for the returned dict shape. Never raises on TD-side
    quirks — accumulates into ``warnings`` instead so partial reports remain
    useful. Only ``fatal`` (returned in-band) signals the root path itself was
    not resolvable.
    """
    import td

    op_global = td.op

    report = {
        "path": path,
        "recursive": bool(recursive),
        "counts": {"nodes": 0, "by_family": {}},
        "unused": [],
        "broken_file_deps": [],
        "orphan_comps": [],
        "dependency_map": {},
        "warnings": [],
    }

    root = op_global(path)
    if root is None or not hasattr(root, "findChildren"):
        report["fatal"] = "Network not found: %s" % path
        return report

    kids = _children(root, recursive)
    report["counts"]["nodes"] = len(kids)
    expr_enum = _expression_mode(kids)

    # by-family counts + path index
    by_path = {}
    referenced = set()
    for c in kids:
        try:
            fam = getattr(c, "family", "") or "other"
            report["counts"]["by_family"][fam] = report["counts"]["by_family"].get(fam, 0) + 1
            by_path[c.path] = c
        except Exception:  # noqa: BLE001
            report["warnings"].append("Could not index " + str(getattr(c, "path", "?")))

    # Pass 1: dependency edges + broken file deps + referenced set
    for c in kids:
        try:
            deps = set()
            try:
                pars = c.pars()
            except Exception:  # noqa: BLE001
                pars = []
            for pr in pars:
                # (a) expression-mode pars referencing op('...')
                try:
                    if expr_enum is not None and pr.mode == expr_enum:
                        for ref in _opref_names(getattr(pr, "expr", "") or ""):
                            tgt = _resolve(c, ref, op_global)
                            if tgt is not None and tgt.path != c.path:
                                deps.add(tgt.path)
                except Exception:  # noqa: BLE001
                    pass
                # (b) source-style pars naming another op (Select ops + *to* converters)
                try:
                    if pr.name.lower() in _SRC_PARS and pr.mode != expr_enum:
                        v = pr.eval()
                        if isinstance(v, str) and v.strip():
                            tgt = _resolve(c, v.strip(), op_global)
                            if tgt is not None and tgt.path != c.path:
                                deps.add(tgt.path)
                except Exception:  # noqa: BLE001
                    pass
                # broken external-file dependency
                try:
                    is_file = getattr(pr, "isFile", None)
                    if is_file is None:
                        is_file = pr.name.lower() in _FILE_PAR_HINTS
                    if is_file:
                        val = pr.eval()
                        if isinstance(val, str) and val.strip():
                            expanded = os.path.expandvars(os.path.expanduser(val.strip()))
                            if not os.path.exists(expanded):
                                report["broken_file_deps"].append(
                                    {"path": c.path, "par": pr.name, "file": val.strip()}
                                )
                except Exception:  # noqa: BLE001
                    pass
                # (c) CHOP exports: this op drives the export target
                try:
                    for ex in getattr(pr, "exports", []) or []:
                        xo = getattr(ex, "owner", None) or getattr(ex, "op", None)
                        if xo is not None and getattr(xo, "path", None) and xo.path != c.path:
                            deps.add(xo.path)
                except Exception:  # noqa: BLE001
                    pass
            if deps:
                report["dependency_map"][c.path] = sorted(deps)
                for d in deps:
                    referenced.add(d)
        except Exception:  # noqa: BLE001
            report["warnings"].append(
                "Could not scan parameters of " + str(getattr(c, "path", "?"))
            )

    # Pass 2: wired-output / display / orphan-COMP classification (conservative).
    for c in kids:
        try:
            ty = getattr(c, "OPType", None) or getattr(c, "type", "") or ""
            nm = getattr(c, "name", "") or ""
            is_comp = bool(getattr(c, "isCOMP", False))

            out_wired = 0
            try:
                for oc in getattr(c, "outputConnectors", []):
                    out_wired += len(getattr(oc, "connections", []) or [])
            except Exception:  # noqa: BLE001
                out_wired = 0
            in_wired = 0
            try:
                for ic in getattr(c, "inputConnectors", []):
                    in_wired += len(getattr(ic, "connections", []) or [])
            except Exception:  # noqa: BLE001
                in_wired = 0

            ref = c.path in referenced

            # displayed/rendered/viewer guards
            shown = False
            try:
                dp = getattr(c.par, "display", None)
                if dp is not None and bool(dp.eval()):
                    shown = True
            except Exception:  # noqa: BLE001
                pass
            try:
                rp = getattr(c.par, "render", None)
                if rp is not None and bool(rp.eval()):
                    shown = True
            except Exception:  # noqa: BLE001
                pass
            try:
                if bool(getattr(c, "viewer", False)):
                    shown = True
            except Exception:  # noqa: BLE001
                pass

            # top-level out/null nodes are likely intentional outputs — don't flag.
            intentional_out = False
            try:
                if c.parent() is root and (nm.startswith("out") or nm.startswith("null")):
                    intentional_out = True
            except Exception:  # noqa: BLE001
                pass

            if out_wired == 0 and not ref and not shown and not intentional_out:
                report["unused"].append(
                    {
                        "path": c.path,
                        "type": ty,
                        "reason": (
                            "no output connections, not referenced by any op(), "
                            "not displayed/rendered"
                        ),
                    }
                )

            if is_comp:
                try:
                    nchild = len(list(c.children))
                except Exception:  # noqa: BLE001
                    nchild = -1
                if nchild == 0 and out_wired == 0 and in_wired == 0 and not ref:
                    report["orphan_comps"].append(
                        {
                            "path": c.path,
                            "reason": (
                                "empty COMP with no connections and not referenced by any op()"
                            ),
                        }
                    )
        except Exception:  # noqa: BLE001
            report["warnings"].append("Could not classify " + str(getattr(c, "path", "?")))

    return report
