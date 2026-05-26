"""Atomic-ish batch operations: create / update / delete / connect."""

import td

from mcp.services import api_service

op = td.op  # TD globals are not available inside imported modules; reach via td


def connect(source_path, target_path, source_output=0, target_input=0):
    src = op(source_path)
    dst = op(target_path)
    if src is None or dst is None:
        raise LookupError("Source or target not found: %s -> %s" % (source_path, target_path))
    src_parent = src.parent()
    dst_parent = dst.parent()
    # TD wires only connect operators sharing a parent. A cross-container connect
    # silently no-ops (no exception, no wire), so reject it with an actionable msg.
    if src_parent is None or dst_parent is None or src_parent.path != dst_parent.path:
        raise ValueError(
            "Cannot wire across containers: %s (in %s) -> %s (in %s). "
            "Wires only connect operators sharing a parent; to bring an operator "
            "across networks use a Select/In OP (e.g. a Select TOP/CHOP whose source "
            "parameter points at %r)."
            % (
                src.path,
                getattr(src_parent, "path", "<root>"),
                dst.path,
                getattr(dst_parent, "path", "<root>"),
                source_path,
            )
        )
    try:
        in_conn = dst.inputConnectors[target_input]
        out_conn = src.outputConnectors[source_output]
    except IndexError:
        raise IndexError(
            "Connector index out of range: target_input=%d (%s has %d input(s)), "
            "source_output=%d (%s has %d output(s))."
            % (
                target_input,
                dst.path,
                len(dst.inputConnectors),
                source_output,
                src.path,
                len(src.outputConnectors),
            )
        )
    in_conn.connect(out_conn)


def run(operations):
    results = []
    for operation in operations or []:
        action = operation.get("action")
        try:
            if action == "create":
                ref = api_service.create_node(
                    operation["parent_path"],
                    operation["type"],
                    operation.get("name"),
                    operation.get("parameters"),
                )
                results.append({"action": action, "ok": True, "data": ref})
            elif action == "update":
                api_service.update_parameters(operation["path"], operation.get("parameters", {}))
                results.append({"action": action, "ok": True, "path": operation["path"]})
            elif action == "delete":
                api_service.delete_node(operation["path"])
                results.append({"action": action, "ok": True, "path": operation["path"]})
            elif action == "connect":
                connect(
                    operation["source_path"],
                    operation["target_path"],
                    operation.get("source_output", 0),
                    operation.get("target_input", 0),
                )
                results.append({"action": action, "ok": True})
            else:
                results.append({"action": action, "ok": False, "error": "unknown action"})
        except Exception as exc:  # noqa: BLE001
            results.append({"action": action, "ok": False, "error": str(exc)})
    return {"results": results}
