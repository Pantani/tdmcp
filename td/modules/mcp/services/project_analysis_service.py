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


def _make_report(path, recursive):
    return {
        "path": path,
        "recursive": bool(recursive),
        "counts": {"nodes": 0, "by_family": {}},
        "unused": [],
        "broken_file_deps": [],
        "orphan_comps": [],
        "dependency_map": {},
        "warnings": [],
    }


def _index_children(report, kids):
    by_path = {}
    for c in kids:
        try:
            fam = getattr(c, "family", "") or "other"
            report["counts"]["by_family"][fam] = report["counts"]["by_family"].get(fam, 0) + 1
            by_path[c.path] = c
        except Exception:  # noqa: BLE001
            report["warnings"].append("Could not index " + str(getattr(c, "path", "?")))
    return by_path


def _project_file_candidate(td_module, raw_value):
    expanded = os.path.expandvars(os.path.expanduser(raw_value.strip()))
    if os.path.isabs(expanded):
        return expanded
    try:
        project_dir = getattr(getattr(td_module, "project", None), "folder", "") or ""
    except Exception:  # noqa: BLE001
        project_dir = ""
    return os.path.normpath(os.path.join(project_dir, expanded)) if project_dir else expanded


def _file_dependency(c, pr, td_module):
    try:
        is_file = getattr(pr, "isFile", None)
        if is_file is None:
            is_file = pr.name.lower() in _FILE_PAR_HINTS
        if not is_file:
            return None
        val = pr.eval()
        if not isinstance(val, str) or not val.strip():
            return None
        candidate = _project_file_candidate(td_module, val)
        if os.path.exists(candidate):
            return None
        return {"path": c.path, "par": pr.name, "file": val.strip()}
    except Exception:  # noqa: BLE001
        return None


def _expression_dependencies(c, pr, expr_enum, op_global):
    deps = set()
    try:
        if expr_enum is not None and pr.mode == expr_enum:
            for ref in _opref_names(getattr(pr, "expr", "") or ""):
                tgt = _resolve(c, ref, op_global)
                if tgt is not None and tgt.path != c.path:
                    deps.add(tgt.path)
    except Exception:  # noqa: BLE001
        pass
    return deps


def _source_param_dependencies(c, pr, expr_enum, op_global):
    deps = set()
    try:
        if pr.name.lower() in _SRC_PARS and pr.mode != expr_enum:
            v = pr.eval()
            if isinstance(v, str) and v.strip():
                tgt = _resolve(c, v.strip(), op_global)
                if tgt is not None and tgt.path != c.path:
                    deps.add(tgt.path)
    except Exception:  # noqa: BLE001
        pass
    return deps


def _export_dependencies(c, pr):
    deps = set()
    try:
        for ex in getattr(pr, "exports", []) or []:
            xo = getattr(ex, "owner", None) or getattr(ex, "op", None)
            if xo is not None and getattr(xo, "path", None) and xo.path != c.path:
                deps.add(xo.path)
    except Exception:  # noqa: BLE001
        pass
    return deps


def _param_dependencies(c, pr, expr_enum, op_global):
    deps = _expression_dependencies(c, pr, expr_enum, op_global)
    deps.update(_source_param_dependencies(c, pr, expr_enum, op_global))
    deps.update(_export_dependencies(c, pr))
    return deps


def _scan_node_dependencies(report, c, expr_enum, op_global, td_module):
    deps = set()
    try:
        pars = c.pars()
    except Exception:  # noqa: BLE001
        pars = []
    for pr in pars:
        deps.update(_param_dependencies(c, pr, expr_enum, op_global))
        broken = _file_dependency(c, pr, td_module)
        if broken is not None:
            report["broken_file_deps"].append(broken)
    return deps


def _scan_dependencies(report, kids, expr_enum, op_global, td_module):
    referenced = set()
    for c in kids:
        try:
            deps = _scan_node_dependencies(report, c, expr_enum, op_global, td_module)
            if deps:
                report["dependency_map"][c.path] = sorted(deps)
                referenced.update(deps)
        except Exception:  # noqa: BLE001
            report["warnings"].append(
                "Could not scan parameters of " + str(getattr(c, "path", "?"))
            )
    return referenced


def _connector_count(node, attr):
    count = 0
    try:
        for connector in getattr(node, attr, []):
            count += len(getattr(connector, "connections", []) or [])
    except Exception:  # noqa: BLE001
        return 0
    return count


def _par_enabled(node, name):
    try:
        par = getattr(node.par, name, None)
        return par is not None and bool(par.eval())
    except Exception:  # noqa: BLE001
        return False


def _is_shown(node):
    if _par_enabled(node, "display") or _par_enabled(node, "render"):
        return True
    try:
        return bool(getattr(node, "viewer", False))
    except Exception:  # noqa: BLE001
        return False


def _is_intentional_out(node, root, name):
    try:
        return node.parent() is root and (name.startswith("out") or name.startswith("null"))
    except Exception:  # noqa: BLE001
        return False


def _child_count(node):
    try:
        return len(list(node.children))
    except Exception:  # noqa: BLE001
        return -1


def _classify_node(report, c, root, referenced):
    ty = getattr(c, "OPType", None) or getattr(c, "type", "") or ""
    name = getattr(c, "name", "") or ""
    out_wired = _connector_count(c, "outputConnectors")
    in_wired = _connector_count(c, "inputConnectors")
    ref = c.path in referenced
    shown = _is_shown(c)
    intentional_out = _is_intentional_out(c, root, name)
    if out_wired == 0 and not ref and not shown and not intentional_out:
        report["unused"].append(
            {
                "path": c.path,
                "type": ty,
                "reason": "no output connections, not referenced by any op(), not displayed/rendered",
            }
        )
    if bool(getattr(c, "isCOMP", False)) and _child_count(c) == 0:
        if out_wired == 0 and in_wired == 0 and not ref:
            report["orphan_comps"].append(
                {
                    "path": c.path,
                    "reason": "empty COMP with no connections and not referenced by any op()",
                }
            )


def _classify_nodes(report, kids, root, referenced):
    for c in kids:
        try:
            _classify_node(report, c, root, referenced)
        except Exception:  # noqa: BLE001
            report["warnings"].append("Could not classify " + str(getattr(c, "path", "?")))


def analyze(path, recursive=True):
    """Diagnostic scan of ``path``'s descendants. Read-only.

    See module docstring for the returned dict shape. Never raises on TD-side
    quirks — accumulates into ``warnings`` instead so partial reports remain
    useful. Only ``fatal`` (returned in-band) signals the root path itself was
    not resolvable.
    """
    import td

    op_global = td.op

    report = _make_report(path, recursive)

    root = op_global(path)
    if root is None or not hasattr(root, "findChildren"):
        report["fatal"] = "Network not found: %s" % path
        return report

    kids = _children(root, recursive)
    report["counts"]["nodes"] = len(kids)
    expr_enum = _expression_mode(kids)

    _index_children(report, kids)
    referenced = _scan_dependencies(report, kids, expr_enum, op_global, td)
    _classify_nodes(report, kids, root, referenced)

    return report
