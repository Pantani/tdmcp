"""Core node CRUD, Python execution, method calls and server info.

All functions assume the TouchDesigner globals (`op`, `app`, `project`) are
available, which is the case when this package is imported from a running TD.
"""

import io
import re
import sys
import traceback
from contextlib import redirect_stdout

import td

# TouchDesigner injects globals (op, app, project, operator classes) only into
# DAT/Textport scope, not into imported modules — so reach them via `td`.
op = td.op
app = td.app
project = td.project

_TYPE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*$")


def op_type(node):
    """Returns the operator type string, e.g. 'noiseTOP'."""
    return getattr(node, "OPType", None) or getattr(node, "type", "") or ""


def _resolve_type(type_name):
    """Resolves an operator type string to its class via the td module."""
    if not type_name or not _TYPE_RE.match(type_name):
        raise ValueError("Invalid operator type: %r" % (type_name,))
    cls = getattr(td, type_name, None)
    if cls is None:
        raise ValueError("Unknown operator type: %s" % type_name)
    return cls


def node_ref(node):
    return {"path": node.path, "type": op_type(node), "name": node.name}


def _jsonable(value):
    try:
        import json

        json.dumps(value)
        return value
    except Exception:  # noqa: BLE001
        return str(value)


def apply_parameters(node, parameters):
    applied, failed = [], []
    for key, value in (parameters or {}).items():
        try:
            par = getattr(node.par, key, None)
            if par is None:
                failed.append(key)
                continue
            par.val = value
            applied.append(key)
        except Exception:  # noqa: BLE001
            failed.append(key)
    return applied, failed


def create_node(parent_path, type_name, name=None, parameters=None):
    parent = op(parent_path)  # noqa: F821 - TD global
    if parent is None:
        raise LookupError("Parent not found: %s" % parent_path)
    cls = _resolve_type(type_name)
    node = parent.create(cls, name) if name else parent.create(cls)
    ref = node_ref(node)
    if parameters:
        # The node is created regardless; surface any params that did not apply
        # (unknown name or bad value) as a non-fatal warning rather than dropping
        # them silently. The caller (create_td_node) relays these to the user.
        _applied, failed = apply_parameters(node, parameters)
        if failed:
            ref["parameter_warnings"] = sorted(failed)
    return ref


def delete_node(path):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    node.destroy()
    return {"deleted": path}


def get_nodes(parent_path=None):
    parent = op(parent_path or "/")  # noqa: F821
    if parent is None:
        raise LookupError("Parent not found: %s" % parent_path)
    children = parent.findChildren(depth=1) if hasattr(parent, "findChildren") else []
    return {"nodes": [node_ref(c) for c in children]}


def _flags(node):
    out = {}
    for attr in ("bypass", "render", "display", "lock", "allowCooking", "cloneImmune"):
        try:
            v = getattr(node, attr)
            if isinstance(v, bool):
                out[attr] = v
        except Exception:  # noqa: BLE001
            pass
    # clone is COMP-only and lives on .par.clone (path to master), NOT op.clone.
    try:
        if hasattr(node, "isClone"):
            out["is_clone"] = bool(node.isClone)
    except Exception:  # noqa: BLE001
        pass
    try:
        cp = getattr(node.par, "clone", None)
        if cp is not None:
            cv = cp.eval()
            out["clone"] = str(cv) if cv else None
    except Exception:  # noqa: BLE001
        pass
    return out


def _indexed_inputs(node):
    # Faithful, index-aware: iterate inputConnectors (NOT node.inputs, which omits empty
    # slots). Each wire => {in_index, from, out_index}. Multi-input TOPs pack contiguously,
    # so the indices reported are the live/current ones.
    wires = []
    try:
        for ic in node.inputConnectors:
            try:
                in_index = ic.index
            except Exception:  # noqa: BLE001
                in_index = None
            try:
                conns = list(ic.connections)
            except Exception:  # noqa: BLE001
                conns = []
            for oc in conns:
                try:
                    wires.append(
                        {"in_index": in_index, "from": oc.owner.path, "out_index": oc.index}
                    )
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        pass
    return wires


def node_detail(node):
    pars = {}
    try:
        for par in node.pars():
            try:
                pars[par.name] = _jsonable(par.eval())
            except Exception:  # noqa: BLE001
                pars[par.name] = None
    except Exception:  # noqa: BLE001
        pars = {}
    inputs = [c.path for c in getattr(node, "inputs", []) if c]
    outputs = [c.path for c in getattr(node, "outputs", []) if c]
    detail = node_ref(node)
    detail.update({"parameters": pars, "inputs": inputs, "outputs": outputs})
    # --- NEW (node_flags_in_detail): flags + index-aware wiring + position/comment/color/tags ---
    detail["flags"] = _flags(node)
    detail["wires_in"] = _indexed_inputs(node)
    # op.errors() returns a STRING (not a list) — wrap it so a multi-line message is
    # ONE entry, never iterated char-by-char. Lets get_td_node_flags' REST path flag
    # "cook error" suspects (and honor only_problems) the same as the exec walk.
    try:
        _err = node.errors(recurse=False)
        detail["errors"] = [str(_err)] if _err else []
    except Exception:  # noqa: BLE001
        pass
    try:
        detail["nodeX"] = node.nodeX
        detail["nodeY"] = node.nodeY
    except Exception:  # noqa: BLE001
        pass
    try:
        if node.comment:
            detail["comment"] = node.comment
    except Exception:  # noqa: BLE001
        pass
    try:
        detail["color"] = list(node.color)  # tuple -> JSON list
    except Exception:  # noqa: BLE001
        pass
    try:
        if node.tags:
            detail["tags"] = sorted(str(t) for t in node.tags)  # set -> sorted list
    except Exception:  # noqa: BLE001
        pass
    return detail


def get_node(path):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    return node_detail(node)


def update_parameters(path, parameters):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    params = parameters or {}
    # Reject unknown parameter names up front (atomic: apply nothing) so a typo
    # like `gain` on a levelTOP fails loudly instead of being silently dropped.
    unknown = [k for k in params if getattr(node.par, k, None) is None]
    if unknown:
        raise ValueError(
            "Unknown parameter(s) on %s (%s): %s. "
            "Use get_td_node_parameters to see the valid parameter names."
            % (path, op_type(node), ", ".join(sorted(unknown)))
        )
    applied, failed = apply_parameters(node, params)
    if failed:
        raise ValueError(
            "Could not set parameter(s) on %s (%s): %s "
            "(wrong value type or out of range?). Applied: %s."
            % (path, op_type(node), ", ".join(sorted(failed)), ", ".join(sorted(applied)) or "none")
        )
    return node_detail(node)


def exec_script(script, return_output=True):
    buf = io.StringIO()
    # Seed the exec namespace with the full TD namespace (op, ParMode, operator
    # classes, …) so scripts behave like they would in a DAT/Textport.
    namespace = dict(vars(td))
    namespace["op"] = op
    try:
        with redirect_stdout(buf):
            exec(script, namespace)  # noqa: S102 - intentional, runs inside TD
    except Exception:  # noqa: BLE001
        raise RuntimeError(traceback.format_exc())
    result = {"stdout": buf.getvalue() if return_output else ""}
    if namespace.get("result") is not None:
        result["result"] = _jsonable(namespace["result"])
    return result


def call_method(path, method, args=None, kwargs=None):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    fn = getattr(node, method, None)
    if not callable(fn):
        raise AttributeError("%s has no callable method %s" % (path, method))
    value = fn(*(args or []), **(kwargs or {}))
    return {"result": _jsonable(value)}


def get_node_errors(path, recursive=False):
    node = op(path)  # noqa: F821
    if node is None:
        return {"errors": []}
    targets = [node]
    if recursive and hasattr(node, "findChildren"):
        targets += node.findChildren()
    out = []
    for target in targets:
        for kind in ("errors", "warnings"):
            try:
                fn = getattr(target, kind)
                text = fn(recurse=False) if callable(fn) else fn
            except Exception:  # noqa: BLE001
                text = ""
            if text:
                out.append({"path": target.path, "message": text, "type": kind[:-1]})
    return {"errors": out}


def get_info():
    info = {"python_version": sys.version.split()[0]}
    try:
        info["td_version"] = app.version  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        info["build"] = app.build  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        info["project"] = project.name  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        from utils.version import BRIDGE_VERSION

        info["bridge_version"] = BRIDGE_VERSION
    except Exception:  # noqa: BLE001
        info["bridge_version"] = "unknown"
    return info
