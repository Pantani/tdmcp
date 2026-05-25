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
    if parameters:
        apply_parameters(node, parameters)
    return node_ref(node)


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
    apply_parameters(node, parameters)
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
