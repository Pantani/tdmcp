"""Atomic-ish batch operations: create / update / delete / connect."""

from mcp.services import api_service


def connect(source_path, target_path, source_output=0, target_input=0):
    src = op(source_path)  # noqa: F821 - TD global
    dst = op(target_path)  # noqa: F821
    if src is None or dst is None:
        raise LookupError("Source or target not found")
    dst.inputConnectors[target_input].connect(src.outputConnectors[source_output])


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
