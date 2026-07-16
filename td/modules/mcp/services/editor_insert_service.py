"""Atomic, context-checked insertion in the active Network Editor.

This service deliberately uses only TouchDesigner's structured operator and
Connector APIs.  It never calls ``NetworkEditor.placeOPs`` (mouse-interactive),
never evaluates caller code, and leaves undo ownership to the authenticated
REST request wrapper.
"""

import copy
import hashlib
import inspect
import json
import math
import re
import time
from collections import OrderedDict


_MAX_PATH = 1024
_MAX_NAME = 128
_MAX_TYPE = 64
_MAX_PARAMETERS = 64
_MAX_PARAMETER_NAME = 128
_MAX_EDGES = 128
_MAX_RECEIPTS = 128
_RECEIPT_TTL_SECONDS = 300.0
_MAX_COORDINATE = 1_000_000
_TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_SUPPORTED_FAMILIES = ("TOP", "CHOP", "SOP", "DAT", "MAT")


class EditorInsertError(ValueError):
    """Typed service error suitable for the bridge error envelope."""

    def __init__(self, code, message, report=None):
        super().__init__(message)
        self.code = code
        self.report = report


def _fail(code, message, report=None):
    raise EditorInsertError(code, message, report)


def _path(value):
    try:
        return str(value.path)
    except Exception:  # noqa: BLE001
        return None


def _op_type(node):
    try:
        return str(getattr(node, "OPType", None) or getattr(node, "type", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def _family(type_name):
    upper = str(type_name or "").upper()
    for family in ("CHOP", "COMP", "TOP", "SOP", "DAT", "MAT", "POP"):
        if upper.endswith(family):
            return family
    return None


def _validate_path(value, field):
    if not isinstance(value, str) or not value.startswith("/"):
        _fail(
            "stale_editor_context", "%s must be an absolute TouchDesigner path" % field
        )
    if len(value) > _MAX_PATH or any(char in value for char in ("\x00", "\r", "\n")):
        _fail("stale_editor_context", "%s is invalid or too long" % field)
    parts = value.split("/")[1:]
    if value != "/" and any(part in ("", ".", "..") for part in parts):
        _fail("stale_editor_context", "%s must be normalized" % field)
    return value.rstrip("/") or "/"


def _validate_json_scalar(value):
    if value is None or type(value) in (str, bool, int):  # noqa: E721
        return True
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail(
                "unsupported_connector_shape",
                "parameters must contain finite JSON numbers",
            )
        return True
    return False


def _validate_json_bounds(depth, count):
    count[0] += 1
    if depth > 16 or count[0] > 1024:
        _fail(
            "unsupported_connector_shape",
            "parameters exceed the bounded JSON complexity",
        )


def _validate_json_list(value, depth, count):
    for item in value:
        _validate_json_value(item, depth + 1, count)


def _validate_json_object(value, depth, count):
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > _MAX_PARAMETER_NAME:
            _fail(
                "unsupported_connector_shape",
                "parameter object keys must be bounded strings",
            )
        _validate_json_value(item, depth + 1, count)


def _validate_json_value(value, depth=0, count=None):
    count = [0] if count is None else count
    _validate_json_bounds(depth, count)
    if _validate_json_scalar(value):
        return
    if isinstance(value, list):
        _validate_json_list(value, depth, count)
        return
    if isinstance(value, dict):
        _validate_json_object(value, depth, count)
        return
    _fail("unsupported_connector_shape", "parameters accept JSON values only")


def _validated_type_name(value):
    if (
        not isinstance(value, str)
        or len(value) > _MAX_TYPE
        or not _TYPE_RE.fullmatch(value)
    ):
        _fail(
            "unsupported_operator_type",
            "type must be a bounded TouchDesigner operator type",
        )
    return value


def _validated_name(value):
    if value is not None and (
        not isinstance(value, str)
        or len(value) > _MAX_NAME
        or not _NAME_RE.fullmatch(value)
    ):
        _fail(
            "unsupported_operator_type",
            "name must be a bounded TouchDesigner operator name",
        )
    return value


def _validated_parameters(value):
    parameters = {} if value is None else value
    if not isinstance(parameters, dict) or len(parameters) > _MAX_PARAMETERS:
        _fail(
            "unsupported_connector_shape", "parameters must contain at most 64 entries"
        )
    for key, item in parameters.items():
        if not isinstance(key, str) or not key or len(key) > _MAX_PARAMETER_NAME:
            _fail(
                "unsupported_connector_shape",
                "parameter names must contain 1 to 128 characters",
            )
        _validate_json_value(item)
    return parameters


def _validated_expected_context(value):
    required = {"owner_path", "selected_path", "current_path"}
    if not isinstance(value, dict) or set(value) != required:
        _fail(
            "stale_editor_context",
            "expected_context must contain owner, selected and current paths",
        )
    context = {
        "owner_path": _validate_path(value.get("owner_path"), "owner_path"),
        "selected_path": _validate_path(value.get("selected_path"), "selected_path"),
        "current_path": _validate_path(value.get("current_path"), "current_path"),
    }
    if context["selected_path"] != context["current_path"]:
        _fail(
            "stale_editor_context",
            "selected_path and current_path must identify the same operator",
        )
    return context


def _validated_key(value):
    if not isinstance(value, str) or not _KEY_RE.fullmatch(value):
        _fail(
            "idempotency_conflict",
            "idempotency_key must contain 16 to 128 safe characters",
        )
    return value


def _validated_request(payload):
    if not isinstance(payload, dict):
        _fail("stale_editor_context", "insert payload must be an object")
    allowed = {"type", "name", "parameters", "expected_context", "idempotency_key"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail(
            "stale_editor_context", "unsupported insert fields: %s" % ", ".join(unknown)
        )

    return {
        "type": _validated_type_name(payload.get("type")),
        "name": _validated_name(payload.get("name")),
        "parameters": _validated_parameters(payload.get("parameters")),
        "expected_context": _validated_expected_context(
            payload.get("expected_context")
        ),
        "idempotency_key": _validated_key(payload.get("idempotency_key")),
    }


def _request_hash(request):
    encoded = json.dumps(
        request,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "").upper().replace("_", "")
    except Exception:  # noqa: BLE001
        return ""


def _active_pane(panes):
    for attr in ("current", "currentPane"):
        try:
            pane = getattr(panes, attr)
        except Exception:  # noqa: BLE001
            continue
        if pane is not None:
            return pane
    return None


def _perform_mode(td):
    for source in (getattr(td, "ui", None), getattr(td, "project", None)):
        if source is None:
            continue
        try:
            return bool(source.performMode)
        except Exception:  # noqa: BLE001
            continue
    return False


def _active_network_owner(td):
    if _perform_mode(td):
        _fail("perform_mode", "operator insertion is unavailable in Perform Mode")
    ui = getattr(td, "ui", None)
    if ui is None:
        _fail("ui_unavailable", "TouchDesigner UI is unavailable")
    panes = getattr(ui, "panes", None)
    if panes is None:
        _fail("ui_unavailable", "TouchDesigner pane collection is unavailable")
    pane = _active_pane(panes)
    if pane is None or _pane_type(pane) != "NETWORKEDITOR":
        _fail(
            "no_active_network_editor",
            "the explicit active pane is not a Network Editor",
        )
    owner = getattr(pane, "owner", None)
    if owner is None:
        _fail("stale_editor_context", "active Network Editor owner is unavailable")
    return owner


def _single_selection(owner):
    try:
        selected = list(owner.selectedChildren or [])
    except Exception:  # noqa: BLE001
        _fail("no_selection", "active Network Editor selection is unavailable")
    if not selected:
        _fail("no_selection", "select exactly one operator before insertion")
    if len(selected) != 1:
        _fail(
            "ambiguous_selection",
            "operator insertion requires exactly one selected operator",
        )
    return selected[0]


def _revalidate_context(td, expected):
    owner = _active_network_owner(td)
    if _path(owner) != expected["owner_path"]:
        _fail(
            "stale_editor_context",
            "active Network Editor owner changed before insertion",
        )
    selected = _single_selection(owner)
    current = getattr(owner, "currentChild", None)
    if (
        _path(selected) != expected["selected_path"]
        or _path(current) != expected["current_path"]
        or selected is not current
    ):
        _fail(
            "stale_editor_context",
            "selection or current operator changed before insertion",
        )
    return owner, selected


def _connector_index(connector):
    try:
        return int(connector.index)
    except Exception:  # noqa: BLE001
        return -1


def _connector_direction(connector):
    """Return a stable connector direction across TD and offline doubles."""
    for attribute in ("isInput", "is_input"):
        try:
            value = getattr(connector, attribute)
        except Exception:  # noqa: BLE001
            continue
        if value is not None:
            return bool(value)
    return None


def _same_connector(left, right):
    """Compare TD connector proxies by their stable structural identity.

    TouchDesigner may return a fresh Python proxy when following the reverse
    ``connections`` edge, so object identity is not a reliable wire check.
    Owner path, connector index and input/output direction uniquely identify a
    connector inside the active network.
    """
    left_direction = _connector_direction(left)
    right_direction = _connector_direction(right)
    return (
        _path(getattr(left, "owner", None))
        == _path(getattr(right, "owner", None))
        and _connector_index(left) == _connector_index(right)
        and left_direction is not None
        and left_direction == right_direction
    )


def _edge(from_connector, to_connector):
    return {
        "from_path": _path(getattr(from_connector, "owner", None)),
        "out_index": _connector_index(from_connector),
        "to_path": _path(getattr(to_connector, "owner", None)),
        "in_index": _connector_index(to_connector),
    }


def _edge_key(edge):
    return (edge["from_path"], edge["out_index"], edge["to_path"], edge["in_index"])


def _output_connectors(node):
    try:
        return list(node.outputConnectors or [])
    except Exception:  # noqa: BLE001
        _fail(
            "unsupported_connector_shape",
            "selected operator output connectors are unavailable",
        )


def _output_connections(output):
    try:
        return list(output.connections or [])
    except Exception:  # noqa: BLE001
        _fail(
            "unsupported_connector_shape",
            "selected output connections are unavailable",
        )


def _connection_item(output, input_connector):
    edge = _edge(output, input_connector)
    missing_path = None in (edge["from_path"], edge["to_path"])
    missing_index = min(edge["out_index"], edge["in_index"]) < 0
    if missing_path or missing_index:
        _fail(
            "unsupported_connector_shape",
            "a downstream connector identity is unavailable",
        )
    return edge, output, input_connector


def _outgoing(node):
    found = []
    for output in _output_connectors(node):
        found.extend(
            _connection_item(output, connection)
            for connection in _output_connections(output)
        )
    found.sort(key=lambda item: _edge_key(item[0]))
    if len(found) > _MAX_EDGES:
        _fail(
            "unsupported_connector_shape", "selected fan-out exceeds 128 bounded edges"
        )
    return found


def _snapshot(node, extra=None):
    edges = [item[0] for item in _outgoing(node)]
    if extra is not None:
        edges.extend(item[0] for item in _outgoing(extra))
    unique = {_edge_key(edge): edge for edge in edges}
    if len(unique) > _MAX_EDGES:
        _fail(
            "unsupported_connector_shape", "affected topology exceeds 128 bounded edges"
        )
    return [unique[key] for key in sorted(unique)]


def _same_edges(left, right):
    return sorted(_edge_key(edge) for edge in left) == sorted(
        _edge_key(edge) for edge in right
    )


def _finite_coordinate(node, attr):
    try:
        value = float(getattr(node, attr))
    except Exception:  # noqa: BLE001
        _fail("placement_failed", "existing operator position is unavailable")
    if not math.isfinite(value) or abs(value) > _MAX_COORDINATE:
        _fail(
            "placement_failed",
            "existing operator position is outside the supported range",
        )
    return int(round(value))


def _occupied(candidate, children, ignored):
    x, y = candidate
    for node in children:
        if node in ignored:
            continue
        try:
            node_x = float(node.nodeX)
            node_y = float(node.nodeY)
        except Exception:  # noqa: BLE001
            continue
        if abs(node_x - x) < 100 and abs(node_y - y) < 80:
            return True
    return False


def _placement_base(selected, target):
    selected_x = _finite_coordinate(selected, "nodeX")
    selected_y = _finite_coordinate(selected, "nodeY")
    target_x = _finite_coordinate(target, "nodeX")
    target_y = _finite_coordinate(target, "nodeY")
    if abs(target_x - selected_x) >= 240:
        return (
            int(round((selected_x + target_x) / 2.0)),
            int(round((selected_y + target_y) / 2.0)),
        )
    direction = 1 if target_x >= selected_x else -1
    return selected_x + direction * 180, selected_y


def _owner_children(owner, selected, target):
    try:
        return list(owner.children or [])
    except Exception:  # noqa: BLE001
        return [selected, target]


def _placement_offsets():
    offsets = [(0, 0)]
    for ring in range(1, 17):
        offsets.extend(
            ((0, ring * 120), (0, -ring * 120), (ring * 180, 0), (-ring * 180, 0))
        )
    return offsets


def _placement_candidate(base, offset):
    return base[0] + offset[0], base[1] + offset[1]


def _candidate_available(candidate, children):
    if max(abs(candidate[0]), abs(candidate[1])) > _MAX_COORDINATE:
        return False
    return not _occupied(candidate, children, set())


def _placement(owner, selected, target):
    base = _placement_base(selected, target)
    children = _owner_children(owner, selected, target)
    for offset in _placement_offsets():
        candidate = _placement_candidate(base, offset)
        if _candidate_available(candidate, children):
            return candidate
    _fail(
        "placement_failed",
        "no deterministic non-overlapping placement slot is available",
    )


def _validate_insert_family(selected, requested_family):
    selected_family = _family(_op_type(selected))
    if (
        requested_family not in _SUPPORTED_FAMILIES
        or selected_family != requested_family
    ):
        _fail(
            "unsupported_family",
            "inserted and selected operators must share a supported TOP/CHOP/SOP/DAT/MAT family",
        )


def _chosen_downstream(selected):
    outgoing = _outgoing(selected)
    if not outgoing:
        _fail(
            "unsupported_connector_shape",
            "selected operator has no downstream edge to replace",
        )
    output_indices = {item[0]["out_index"] for item in outgoing}
    if len(output_indices) != 1:
        _fail(
            "unsupported_connector_shape",
            "multiple connected output connectors require an explicit wire identity",
        )
    # With no wire selector in the frozen schema, choose one stable edge and make
    # it visible in before/after receipts.  Sibling fan-out edges remain intact.
    return outgoing[0]


def _validate_downstream_target(owner, chosen):
    target = getattr(chosen[2], "owner", None)
    if target is None or getattr(target, "parent", lambda: None)() is not owner:
        _fail(
            "unsupported_connector_shape",
            "downstream operator must share the selected parent",
        )
    try:
        incoming = list(chosen[2].connections or [])
    except Exception:  # noqa: BLE001
        incoming = []
    if len(incoming) != 1 or not _same_connector(incoming[0], chosen[1]):
        _fail(
            "unsupported_connector_shape",
            "chosen downstream input is not an exact single wire",
        )
    return target


def _validate_topology(owner, selected, requested_family):
    _validate_insert_family(selected, requested_family)
    chosen = _chosen_downstream(selected)
    return chosen, _validate_downstream_target(owner, chosen)


def _resolve_type(td, type_name):
    op_class = getattr(td, type_name, None)
    if op_class is None or not inspect.isclass(op_class):
        _fail(
            "unsupported_operator_type",
            "unknown or non-creatable operator type: %s" % type_name,
        )
    for family in _SUPPORTED_FAMILIES:
        base = getattr(td, family, None)
        try:
            if base is not None and issubclass(op_class, base):
                return op_class, family
        except TypeError:
            continue
    _fail(
        "unsupported_operator_type",
        "operator type is not in the running build's creatable allowlist: %s"
        % type_name,
    )


def _existing_child(owner, name):
    if not name:
        return None
    try:
        return owner.op(name)
    except Exception:  # noqa: BLE001
        for child in list(getattr(owner, "children", None) or []):
            if getattr(child, "name", None) == name:
                return child
    return None


def _apply_parameters(node, parameters):
    for name, value in parameters.items():
        parameter = getattr(getattr(node, "par", None), name, None)
        if parameter is None:
            raise RuntimeError("unknown parameter: %s" % name)
        parameter.val = value


def _node_readback(node):
    report = {
        "path": _path(node),
        "type": _op_type(node),
        "name": str(node.name),
        "nodeX": _finite_coordinate(node, "nodeX"),
        "nodeY": _finite_coordinate(node, "nodeY"),
    }
    try:
        report["viewer"] = bool(node.viewer)
    except Exception:  # noqa: BLE001
        pass
    return report


def _disconnect(connector):
    # Live TD 2025.32820 proves only the no-argument Connector.disconnect API.
    connector.disconnect()


def _connect(input_connector, output_connector):
    input_connector.connect(output_connector)


def _destroyed(td, node, node_path):
    try:
        node.destroy()
    except Exception:  # noqa: BLE001
        return False
    try:
        return td.op(node_path) is None
    except Exception:  # noqa: BLE001
        return True


def _restore(td, selected, inserted, inserted_path, chosen, before):
    target_input = chosen[2]
    try:
        if inserted is not None and not _destroyed(td, inserted, inserted_path):
            return False
        if _same_edges(_snapshot(selected), before):
            return True
        _disconnect(target_input)
        _connect(target_input, chosen[1])
        return _same_edges(_snapshot(selected), before)
    except Exception:  # noqa: BLE001
        return False


def _prepare_insert(td, request):
    owner, selected = _revalidate_context(td, request["expected_context"])
    op_class, requested_family = _resolve_type(td, request["type"])
    chosen, target = _validate_topology(owner, selected, requested_family)
    before = _snapshot(selected)
    position = _placement(owner, selected, target)
    if _existing_child(owner, request["name"]) is not None:
        _fail(
            "placement_failed",
            "requested operator name already exists in the active network",
        )
    return {
        "owner": owner,
        "selected": selected,
        "op_class": op_class,
        "requested_family": requested_family,
        "chosen": chosen,
        "before": before,
        "position": position,
    }


def _create_requested_node(owner, op_class, name):
    if name:
        return owner.create(op_class, name)
    return owner.create(op_class)


def _configure_inserted(inserted, request, prepared):
    position = prepared["position"]
    inserted.nodeX = position[0]
    inserted.nodeY = position[1]
    inserted.viewer = False
    if _family(_op_type(inserted)) != prepared["requested_family"]:
        raise RuntimeError("created operator family did not match the requested family")
    _apply_parameters(inserted, request["parameters"])
    inputs = list(inserted.inputConnectors or [])
    outputs = list(inserted.outputConnectors or [])
    if not inputs or not outputs:
        raise RuntimeError(
            "created operator does not expose one input and one output connector"
        )
    node = _node_readback(inserted)
    if node["nodeX"] != position[0] or node["nodeY"] != position[1]:
        raise RuntimeError("explicit placement readback mismatch")
    return inputs, outputs, node


def _expected_after(prepared, inputs, outputs):
    chosen = prepared["chosen"]
    expected = [
        edge for edge in prepared["before"] if _edge_key(edge) != _edge_key(chosen[0])
    ]
    expected.extend(
        (
            _edge(chosen[1], inputs[0]),
            _edge(outputs[0], chosen[2]),
        )
    )
    return expected


def _rewire_and_readback(prepared, inserted, inputs, outputs):
    chosen = prepared["chosen"]
    _disconnect(chosen[2])
    _connect(inputs[0], chosen[1])
    _connect(chosen[2], outputs[0])
    after = _snapshot(prepared["selected"], inserted)
    if not _same_edges(after, _expected_after(prepared, inputs, outputs)):
        raise RuntimeError("post-insert topology readback mismatch")
    return after


def _apply_insert_transaction(request, prepared, transaction):
    inserted = _create_requested_node(
        prepared["owner"], prepared["op_class"], request["name"]
    )
    transaction["inserted"] = inserted
    transaction["inserted_path"] = _path(inserted)
    inputs, outputs, node = _configure_inserted(inserted, request, prepared)
    transaction["phase"] = "rewire"
    after = _rewire_and_readback(prepared, inserted, inputs, outputs)
    return node, after


def _failure_kind(phase):
    if phase == "placement":
        return (
            "placement_failed",
            "operator creation, parameter application, or placement readback failed",
        )
    return "rewire_failed", "connector rewire or topology readback failed"


def _failure_report(request, prepared, rollback_ok, code, safe_reason):
    return {
        "status": "failed",
        "idempotency_key": request["idempotency_key"],
        "context": copy.deepcopy(request["expected_context"]),
        "before": {"edges": prepared["before"]},
        "rollback": {"attempted": True, "succeeded": rollback_ok},
        "warnings": [],
        "error": {"code": code, "message": safe_reason},
    }


def _success_report(request, prepared, node, after):
    return {
        "status": "applied",
        "idempotency_key": request["idempotency_key"],
        "context": copy.deepcopy(request["expected_context"]),
        "node": node,
        "before": {"edges": prepared["before"]},
        "after": {"edges": after},
        "rollback": {"attempted": False, "succeeded": True},
        "warnings": [],
    }


class EditorInsertService:
    """Bounded receipt store plus one-request insertion transaction."""

    def __init__(self, td_runtime=None, clock=None):
        self._td_runtime = td_runtime
        self._clock = clock or time.monotonic
        self._receipts = OrderedDict()

    def _td(self):
        if self._td_runtime is not None:
            return self._td_runtime
        import td

        return td

    def _prune(self, now):
        expired = [
            key
            for key, receipt in self._receipts.items()
            if now - receipt["created_at"] >= _RECEIPT_TTL_SECONDS
        ]
        for key in expired:
            self._receipts.pop(key, None)

    def _lookup(self, td, request, digest, now):
        self._prune(now)
        key = request["idempotency_key"]
        receipt = self._receipts.get(key)
        if receipt is None:
            return None
        if receipt["digest"] != digest:
            _fail(
                "idempotency_conflict",
                "idempotency key was already used for a different request",
            )
        if receipt.get("error") is not None:
            report = copy.deepcopy(receipt["report"])
            report["replayed"] = True
            error = receipt["error"]
            _fail(error["code"], error["message"], report)
        node_path = receipt["result"]["node"]["path"]
        node = td.op(node_path)
        selected = td.op(receipt["result"]["context"]["selected_path"])
        if node is None or selected is None:
            _fail(
                "idempotency_conflict",
                "stored insertion no longer exists; use a new idempotency key",
            )
        current_edges = _snapshot(selected, node)
        if not _same_edges(current_edges, receipt["result"]["after"]["edges"]):
            _fail(
                "idempotency_conflict",
                "stored insertion topology changed; use a new idempotency key",
            )
        result = copy.deepcopy(receipt["result"])
        result["status"] = "replayed"
        return result

    def _store(self, key, digest, result, now, error=None):
        while len(self._receipts) >= _MAX_RECEIPTS:
            self._receipts.popitem(last=False)
        self._receipts[key] = {
            "created_at": now,
            "digest": digest,
            "result": copy.deepcopy(result) if error is None else None,
            "report": copy.deepcopy(result) if error is not None else None,
            "error": copy.deepcopy(error),
        }

    def _raise_transaction_failure(
        self, td, request, prepared, transaction, digest, now
    ):
        rollback_ok = _restore(
            td,
            prepared["selected"],
            transaction["inserted"],
            transaction["inserted_path"],
            prepared["chosen"],
            prepared["before"],
        )
        code, safe_reason = _failure_kind(transaction["phase"])
        report = _failure_report(request, prepared, rollback_ok, code, safe_reason)
        if not rollback_ok:
            report["error"]["code"] = "rollback_failed"
            _fail(
                "rollback_failed",
                "operator insertion failed and exact rollback was not confirmed",
                report,
            )
        error = {
            "code": code,
            "message": "operator insertion failed and was rolled back: %s"
            % safe_reason,
        }
        self._store(request["idempotency_key"], digest, report, now, error=error)
        _fail(error["code"], error["message"], report)

    def insert(self, payload):
        request = _validated_request(payload)
        digest = _request_hash(request)
        now = self._clock()
        td = self._td()
        replay = self._lookup(td, request, digest, now)
        if replay is not None:
            return replay
        prepared = _prepare_insert(td, request)
        transaction = {"inserted": None, "inserted_path": None, "phase": "placement"}
        try:
            node, after = _apply_insert_transaction(request, prepared, transaction)
        except Exception:  # noqa: BLE001
            self._raise_transaction_failure(
                td, request, prepared, transaction, digest, now
            )
        result = _success_report(request, prepared, node, after)
        self._store(request["idempotency_key"], digest, result, now)
        return result


_DEFAULT_SERVICE = EditorInsertService()


def insert_operator_at_selection(payload):
    """Insert one operator from a validated structured request payload."""
    return _DEFAULT_SERVICE.insert(payload)
