"""Recursive network analysis: errors, topology and performance."""

import td

from mcp.services import api_service

op = td.op  # TD globals are not available inside imported modules; reach via td


def errors(path):
    return api_service.get_node_errors(path, recursive=True)


def topology(path, recursive=False):
    root = op(path)
    if root is None:
        return {"nodes": [], "connections": []}
    nodes, connections = [], []
    if not hasattr(root, "findChildren"):
        children = []
    elif recursive:
        children = root.findChildren()  # all descendants
    else:
        children = root.findChildren(depth=1)  # direct children only
    for child in children:
        nodes.append(
            {"path": child.path, "type": api_service.op_type(child), "name": child.name}
        )
        for index, connector in enumerate(getattr(child, "inputConnectors", [])):
            # `connector.connections` yields the source-side output Connectors; each
            # carries its own `.index` (the source output index) and `.owner` (the op).
            for source in getattr(connector, "connections", []):
                owner = getattr(source, "owner", None)
                if owner is None:
                    continue
                connections.append(
                    {
                        "source_path": owner.path,
                        "source_output": int(getattr(source, "index", 0) or 0),
                        "target_path": child.path,
                        "target_input": index,
                    }
                )
    return {"nodes": nodes, "connections": connections}


def performance(path):
    root = op(path)  # noqa: F821
    if root is None:
        return {"nodes": [], "total_cook_time_ms": 0.0}
    nodes = []
    total = 0.0
    children = root.findChildren(depth=1) if hasattr(root, "findChildren") else []
    for child in children:
        cook_time = float(getattr(child, "cookTime", 0.0) or 0.0)
        total += cook_time
        nodes.append(
            {
                "path": child.path,
                "cook_time_ms": cook_time,
                "cook_count": int(getattr(child, "cookCount", 0) or 0),
            }
        )
    return {"nodes": nodes, "total_cook_time_ms": total}
