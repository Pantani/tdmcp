"""Structured snapshot/CAS apply for annotation-aware network layout.

No caller code is evaluated.  Context is compact and contains only paths,
rectangles, dock relationships and edges.  Apply re-derives the fingerprint,
snapshots every touched attribute, verifies exact readback and rolls back on any
partial failure.
"""

import hashlib
import json


MAX_NETWORKS = 16
MAX_HOSTS = 512
MAX_ANNOTATIONS = 64
MAX_TOUCHED = 1024
MAX_PATH = 1024
MAX_COORDINATE = 1_000_000
MIN_SIZE = 10
MAX_SIZE = 1_000_000


class AnnotationLayoutError(RuntimeError):
    code = "annotation_layout_error"

    def __init__(self, message, report=None):
        super().__init__(message)
        self.report = report


class InvalidAnnotationLayoutError(AnnotationLayoutError, ValueError):
    code = "invalid_annotation_layout"


class AnnotationLayoutNotFoundError(AnnotationLayoutError, LookupError):
    code = "annotation_layout_not_found"


class StaleAnnotationLayoutError(AnnotationLayoutError):
    code = "stale_annotation_layout"


class AnnotationLayoutApplyError(AnnotationLayoutError):
    code = "annotation_layout_apply_failed"


class AnnotationLayoutRollbackError(AnnotationLayoutError):
    code = "annotation_layout_rollback_failed"


def _td_module():
    import td

    return td


def _path(value, field="path"):
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or len(value) > MAX_PATH
        or any(char in value for char in "\x00\r\n")
    ):
        raise InvalidAnnotationLayoutError("%s must be a bounded absolute path" % field)
    return value.rstrip("/") or "/"


def _integer(value, field, minimum, maximum):
    if type(value) is not int or value < minimum or value > maximum:  # noqa: E721
        raise InvalidAnnotationLayoutError(
            "%s must be an integer from %d to %d" % (field, minimum, maximum)
        )
    return value


def _op_type(node):
    value = getattr(node, "OPType", None)
    if value is None:
        value = getattr(node, "type", "unknown")
    return str(value)


def _rect(node):
    try:
        return {
            "path": _path(str(node.path)),
            "x": int(node.nodeX),
            "y": int(node.nodeY),
            "w": int(node.nodeWidth),
            "h": int(node.nodeHeight),
        }
    except Exception as exc:
        raise InvalidAnnotationLayoutError("operator geometry is unavailable") from exc


def _children(parent):
    return sorted(
        list(getattr(parent, "children", []) or []), key=lambda node: str(node.path)
    )


def _comp_children(parent):
    return [
        child
        for child in _children(parent)
        if bool(getattr(child, "isCOMP", False))
    ]


def _network_parents(root, recursive):
    parents = [root]
    if not recursive:
        return parents
    cursor = 0
    while cursor < len(parents):
        parents.extend(_comp_children(parents[cursor]))
        if len(parents) > MAX_NETWORKS:
            raise InvalidAnnotationLayoutError("recursive layout exceeds network cap")
        cursor += 1
    return parents


def _positive_area_contains(annotation, node):
    center_x = node["x"] + node["w"] / 2.0
    center_y = node["y"] - node["h"] / 2.0
    return (
        annotation["x"] <= center_x <= annotation["x"] + annotation["w"]
        and annotation["y"] - annotation["h"] <= center_y <= annotation["y"]
    )


def _docked_entries(hosts, child_paths):
    entries = []
    docked_paths = set()
    for host in hosts:
        for child in list(getattr(host, "docked", []) or []):
            path = str(getattr(child, "path", ""))
            if path not in child_paths or path in docked_paths:
                continue
            entry = _rect(child)
            entry["host_path"] = str(host.path)
            entries.append(entry)
            docked_paths.add(path)
    return sorted(entries, key=lambda item: item["path"]), docked_paths


def _input_connections(target):
    return (
        connection
        for connector in list(getattr(target, "inputConnectors", []) or [])
        for connection in list(getattr(connector, "connections", []) or [])
    )


def _edge_from_connection(connection, target_path, host_paths):
    owner = getattr(connection, "owner", None)
    source_path = str(getattr(owner, "path", ""))
    if (
        source_path in host_paths
        and target_path in host_paths
        and source_path != target_path
    ):
        return source_path, target_path
    return None


def _target_edges(target, host_paths):
    target_path = str(target.path)
    candidates = (
        _edge_from_connection(connection, target_path, host_paths)
        for connection in _input_connections(target)
    )
    return {edge for edge in candidates if edge is not None}


def _edge_entries(hosts):
    host_paths = {str(node.path) for node in hosts}
    edges = set()
    for target in hosts:
        edges.update(_target_edges(target, host_paths))
    return [{"from": source, "to": target} for source, target in sorted(edges)]


def _network_context(parent):
    children = _children(parent)
    child_paths = {str(child.path) for child in children}
    annotations = [
        child for child in children if _op_type(child).lower() == "annotatecomp"
    ]
    provisional_hosts = [child for child in children if child not in annotations]
    docked, docked_paths = _docked_entries(provisional_hosts, child_paths)
    hosts = [
        child for child in provisional_hosts if str(child.path) not in docked_paths
    ]
    if len(hosts) > MAX_HOSTS or len(annotations) > MAX_ANNOTATIONS:
        raise InvalidAnnotationLayoutError(
            "layout context exceeds node or annotation cap"
        )
    if len(hosts) + len(annotations) + len(docked) > MAX_TOUCHED:
        raise InvalidAnnotationLayoutError(
            "layout context exceeds touched-operator cap"
        )
    node_rects = [_rect(node) for node in hosts]
    annotation_entries = []
    for annotation_node in annotations:
        annotation = _rect(annotation_node)
        annotation["enclosed_paths"] = sorted(
            node["path"]
            for node in node_rects
            if _positive_area_contains(annotation, node)
        )
        annotation_entries.append(annotation)
    return {
        "path": str(parent.path),
        "nodes": node_rects,
        "annotations": annotation_entries,
        "docked": docked,
        "edges": _edge_entries(hosts),
    }


def _fingerprint(networks, root_path, recursive):
    body = json.dumps(
        {"root_path": root_path, "recursive": recursive, "networks": networks},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def get_layout_context(root_path, recursive=False):
    root_path = _path(root_path, "root_path")
    if type(recursive) is not bool:  # noqa: E721
        raise InvalidAnnotationLayoutError("recursive must be a boolean")
    td = _td_module()
    root = td.op(root_path)
    if root is None or not bool(getattr(root, "isCOMP", False)):
        raise AnnotationLayoutNotFoundError("layout root COMP was not found")
    networks = [
        _network_context(parent) for parent in _network_parents(root, recursive)
    ]
    return {
        "root_path": root_path,
        "recursive": recursive,
        "fingerprint": _fingerprint(networks, root_path, recursive),
        "networks": networks,
    }


def _position(value, field):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise InvalidAnnotationLayoutError("%s must be [x, y]" % field)
    return (
        _integer(value[0], field + ".x", -MAX_COORDINATE, MAX_COORDINATE),
        _integer(value[1], field + ".y", -MAX_COORDINATE, MAX_COORDINATE),
    )


def _bounds(value, field):
    if not isinstance(value, dict) or set(value) - {"x", "y", "w", "h", "resized"}:
        raise InvalidAnnotationLayoutError("%s has invalid bounds" % field)
    return {
        "x": _integer(value.get("x"), field + ".x", -MAX_COORDINATE, MAX_COORDINATE),
        "y": _integer(value.get("y"), field + ".y", -MAX_COORDINATE, MAX_COORDINATE),
        "w": _integer(value.get("w"), field + ".w", MIN_SIZE, MAX_SIZE),
        "h": _integer(value.get("h"), field + ".h", MIN_SIZE, MAX_SIZE),
        "resized": value.get("resized") is True,
    }


def _network_plan_inputs(raw, index, by_network):
    if not isinstance(raw, dict):
        raise InvalidAnnotationLayoutError("network plan must be an object")
    network_path = _path(raw.get("path"), "networks[%d].path" % index)
    current = by_network.get(network_path)
    if current is None:
        raise InvalidAnnotationLayoutError("network plan is outside the context")
    allowed = {
        item["path"]
        for key in ("nodes", "annotations", "docked")
        for item in current[key]
    }
    annotation_paths = {item["path"] for item in current["annotations"]}
    raw_positions = raw.get("positions")
    raw_bounds = raw.get("annotation_bounds", {})
    if not isinstance(raw_positions, dict) or not isinstance(raw_bounds, dict):
        raise InvalidAnnotationLayoutError(
            "positions and annotation_bounds must be objects"
        )
    return network_path, allowed, annotation_paths, raw_positions, raw_bounds


def _validated_positions(raw_positions, allowed, touched):
    positions = {}
    for path, value in raw_positions.items():
        path = _path(path, "position path")
        if path not in allowed or path in touched:
            raise InvalidAnnotationLayoutError("position path is unknown or duplicated")
        positions[path] = _position(value, "positions[%s]" % path)
        touched.add(path)
    return positions


def _validated_annotation_bounds(raw_bounds, annotation_paths, touched):
    bounds = {}
    for path, value in raw_bounds.items():
        path = _path(path, "annotation path")
        if path not in annotation_paths:
            raise InvalidAnnotationLayoutError("annotation bounds target is invalid")
        bounds[path] = _bounds(value, "annotation_bounds[%s]" % path)
        touched.add(path)
    return bounds


def _validate_network_plan(raw, index, by_network, touched):
    network_path, allowed, annotation_paths, raw_positions, raw_bounds = (
        _network_plan_inputs(raw, index, by_network)
    )
    positions = _validated_positions(raw_positions, allowed, touched)
    bounds = _validated_annotation_bounds(raw_bounds, annotation_paths, touched)
    return {"path": network_path, "positions": positions, "bounds": bounds}


def _validate_plans(body, context):
    raw_plans = body.get("networks")
    if not isinstance(raw_plans, list) or len(raw_plans) > MAX_NETWORKS:
        raise InvalidAnnotationLayoutError("networks must be a bounded list")
    by_network = {item["path"]: item for item in context["networks"]}
    touched = set()
    plans = [
        _validate_network_plan(raw, index, by_network, touched)
        for index, raw in enumerate(raw_plans)
    ]
    if len(touched) > MAX_TOUCHED:
        raise InvalidAnnotationLayoutError("layout plan exceeds touched-operator cap")
    return plans


def _snapshot(td, plans):
    snapshots = []
    for plan in plans:
        paths = sorted(set(plan["positions"]) | set(plan["bounds"]))
        for path in paths:
            node = td.op(path)
            if node is None:
                raise StaleAnnotationLayoutError("layout target disappeared")
            attrs = (
                ("nodeX", "nodeY", "nodeWidth", "nodeHeight")
                if path in plan["bounds"]
                else ("nodeX", "nodeY")
            )
            snapshots.append(
                {
                    "path": path,
                    "node": node,
                    "id": str(getattr(node, "id", "")),
                    "values": {attr: getattr(node, attr) for attr in attrs},
                }
            )
    return snapshots


def _expected_for(path, plans):
    for plan in plans:
        if path in plan["bounds"]:
            value = plan["bounds"][path]
            return {
                "nodeX": value["x"],
                "nodeY": value["y"],
                "nodeWidth": value["w"],
                "nodeHeight": value["h"],
            }
        if path in plan["positions"]:
            x, y = plan["positions"][path]
            return {"nodeX": x, "nodeY": y}
    raise InvalidAnnotationLayoutError("layout target has no expected state")


def _planned_bounds_for(path, plans):
    for plan in plans:
        if path in plan["bounds"]:
            return plan["bounds"][path]
    return None


def _restore_snapshot(snapshot):
    node = snapshot["node"]
    if str(getattr(node, "id", "")) != snapshot["id"]:
        raise RuntimeError("operator identity changed")
    for attr, value in snapshot["values"].items():
        setattr(node, attr, value)
    for attr, value in snapshot["values"].items():
        if getattr(node, attr) != value:
            raise RuntimeError("rollback readback mismatch")


def _restore(snapshots):
    errors = []
    for snapshot in reversed(snapshots):
        try:
            _restore_snapshot(snapshot)
        except Exception as exc:  # noqa: BLE001
            errors.append({"path": snapshot["path"], "message": str(exc)[:160]})
    return errors


def _prepare_apply(body):
    if not isinstance(body, dict):
        raise InvalidAnnotationLayoutError("layout body must be an object")
    root_path = _path(body.get("root_path"), "root_path")
    recursive = body.get("recursive", False)
    fingerprint = body.get("fingerprint")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise InvalidAnnotationLayoutError("fingerprint must be a SHA-256 string")
    context = get_layout_context(root_path, recursive)
    if context["fingerprint"] != fingerprint:
        raise StaleAnnotationLayoutError(
            "network changed after annotation layout planning"
        )
    plans = _validate_plans(body, context)
    return root_path, fingerprint, plans, _snapshot(_td_module(), plans)


def _matches_expected(node, expected):
    return all(getattr(node, attr) == value for attr, value in expected.items())


def _write_expected(node, expected):
    for attr, value in expected.items():
        setattr(node, attr, value)
    for attr, value in expected.items():
        if getattr(node, attr) != value:
            raise RuntimeError("%s readback mismatch" % attr)


def _apply_snapshot(snapshot, plans):
    expected = _expected_for(snapshot["path"], plans)
    node = snapshot["node"]
    if _matches_expected(node, expected):
        return False
    _write_expected(node, expected)
    return True


def _apply_snapshots(snapshots, plans):
    return [
        snapshot["path"]
        for snapshot in snapshots
        if _apply_snapshot(snapshot, plans)
    ]


def _resized_count(snapshots, plans):
    return sum(
        1
        for snapshot in snapshots
        for bounds in [_planned_bounds_for(snapshot["path"], plans)]
        if bounds is not None
        and bounds["resized"]
        and (
            snapshot["values"].get("nodeWidth") != bounds["w"]
            or snapshot["values"].get("nodeHeight") != bounds["h"]
        )
    )


def apply_layout(body):
    root_path, fingerprint, plans, snapshots = _prepare_apply(body)
    try:
        changed = _apply_snapshots(snapshots, plans)
    except Exception as exc:  # noqa: BLE001
        rollback_errors = _restore(snapshots)
        report = {
            "applied": False,
            "rolled_back": not rollback_errors,
            "moved": 0,
            "resized_annotations": 0,
            "error": {
                "code": "annotation_layout_apply_failed",
                "message": str(exc)[:160],
            },
            "rollback_errors": rollback_errors,
        }
        if rollback_errors:
            raise AnnotationLayoutRollbackError(
                "annotation layout rollback failed", report
            )
        raise AnnotationLayoutApplyError("annotation layout apply failed", report)
    resized = _resized_count(snapshots, plans)
    return {
        "applied": True,
        "rolled_back": False,
        "root_path": root_path,
        "fingerprint": fingerprint,
        "moved": len(changed),
        "resized_annotations": resized,
        "networks": len(plans),
        "rollback_errors": [],
    }
