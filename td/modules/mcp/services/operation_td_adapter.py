"""TouchDesigner-native adapter for bounded structured operation plans.

The module imports TouchDesigner only inside live entry points so it remains
offline-testable.  Every OP, Par and Connector proxy is resolved and discarded
inside one synchronous call.  Transaction actions, callback info and observation
records contain bounded JSON scalars only; no closure or caller-provided callable
is retained.

This is an internal adapter.  A future controller must authorize receipt access
before calling :func:`observe_operation`; operation ids and native undo labels are
not authorization boundaries.
"""

import copy
import hashlib
import inspect
import math
import threading
import time
from collections import OrderedDict

from .operation_plan_service import (
    INERT_OPERATOR_TYPES,
    JournalReport,
    LiveTransactionAdapter,
    RECEIPT_TTL_SECONDS,
    RevertTransactionOutcome,
    RollbackError,
    RollbackReport,
    ScalarSnapshotAdapter,
    TransactionOutcome,
    _LIVE_TRANSACTION_CAPABILITY,
    _canonical_json,
    _derive_state_contract,
    _resolve_target,
    _safe_scalar,
    _simulate_aliases_and_scope,
    _summarize_plan,
)


LEGACY_JOURNAL_SCHEMA_VERSION = 1
JOURNAL_SCHEMA_VERSION = 2
# Keep exact observation state slightly longer than terminal lookup authority.
# Receipt expiry starts only after execute() returns, while the journal is stored
# inside execute(); an equal TTL would let a still-valid capability briefly
# outlive its journal. The extra bounded margin is not additional authority.
JOURNAL_TTL_SECONDS = RECEIPT_TTL_SECONDS + 30.0
MAX_JOURNALS = 128
MAX_JOURNAL_BYTES = 64 * 1024
MAX_DIRECT_CHILDREN = 64
SOFT_TRANSACTION_SECONDS = 3.0
_METADATA_FIELDS = (
    "position",
    "color",
    "comment",
    "viewer",
    "bypass",
    "display",
    "render",
)
_ANNOTATION_PAR_NAMES = (
    "Titletext",
    "Bodytext",
    "Backcolorr",
    "Backcolorg",
    "Backcolorb",
    "Backcoloralpha",
)


class OperationTdAdapterError(RuntimeError):
    """Sanitized internal failure; messages never contain project values."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class JournalRegistrationError(OperationTdAdapterError):
    def __init__(self, orphan_possible=False):
        super().__init__("journal_registration_failed")
        self.orphan_possible = bool(orphan_possible)


def _fail(code):
    raise OperationTdAdapterError(code)


def _path(value):
    try:
        result = str(value.path)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if not result.startswith("/"):
        _fail("stale_plan")
    return result


def _op_type(node):
    value = getattr(node, "OPType", None) or getattr(node, "type", None)
    text = str(value or "")
    if not text or len(text.encode("utf-8")) > 128:
        _fail("stale_plan")
    return text


def _identity(node):
    value = getattr(node, "id", None)
    # TouchDesigner's root operator legitimately has native id 0 on build
    # 2025.32820. It is still a stable exact identity; only negative ids are
    # invalid. Do not coerce booleans (``type`` is intentionally exact).
    if type(value) is int:
        if value >= 0:
            return value
        _fail("stale_plan")
    text = str(value or "")
    if not text or len(text.encode("utf-8")) > 256:
        _fail("stale_plan")
    return text


def _resolve_op(td, path, required=True):
    try:
        node = td.op(path)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if required and node is None:
        _fail("stale_plan")
    return node


def _scalar(value, field="runtime value"):
    # _safe_scalar copies containers and rejects TD proxy objects.
    return _safe_scalar(value, field)


def _enum_text(value):
    text = str(value or "")
    if not text or len(text.encode("utf-8")) > 64:
        _fail("stale_plan")
    return text


def _constant_mode(value):
    return _enum_text(value).upper().split(".")[-1] == "CONSTANT"


def _read_parameter_value(parameter):
    evaluator = getattr(parameter, "eval", None)
    try:
        value = evaluator() if callable(evaluator) else parameter.val
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    return _scalar(value, "parameter value")


def _parameter_writable(parameter, mode):
    if not _constant_mode(mode):
        return False
    for name in ("readOnly", "readonly", "isReadOnly"):
        try:
            if bool(getattr(parameter, name)):
                return False
        except (AttributeError, TypeError):
            continue
    return hasattr(parameter, "val")


def _parameter(node, name):
    collection = getattr(node, "par", None)
    try:
        parameter = getattr(collection, name)
    except (AttributeError, TypeError) as exc:
        raise OperationTdAdapterError("stale_plan") from exc
    if parameter is None:
        _fail("stale_plan")
    return parameter


def _parameter_fact(node, name):
    parameter = _parameter(node, name)
    style = _enum_text(getattr(parameter, "style", None))
    mode = _enum_text(getattr(parameter, "mode", None))
    return {
        "style": style,
        "mode": mode,
        "value": _read_parameter_value(parameter),
        "writable": _parameter_writable(parameter, mode),
    }


def _integral_coordinate(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("stale_plan")
    number = float(value)
    if not math.isfinite(number) or abs(number) > 1_000_000 or not number.is_integer():
        _fail("stale_plan")
    return int(number)


def _position_value(node):
    try:
        return {
            "x": _integral_coordinate(node.nodeX),
            "y": _integral_coordinate(node.nodeY),
        }
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc


def _color_value(node):
    try:
        color = list(node.color)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if len(color) != 3:
        _fail("stale_plan")
    return [float(channel) for channel in color]


def _metadata_value(node, field):
    if field == "position":
        return _position_value(node)
    if field == "color":
        return _color_value(node)
    try:
        value = getattr(node, field)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if field == "comment":
        return str(value)
    return bool(value)


def _metadata_writable(node, field):
    attrs = ("nodeX", "nodeY") if field == "position" else (field,)
    for attr in attrs:
        if not hasattr(node, attr):
            return False
        descriptor = getattr(type(node), attr, None)
        if isinstance(descriptor, property) and descriptor.fset is None:
            return False
    return True


def _metadata_fact(node, field):
    return {
        "value": _scalar(_metadata_value(node, field), "metadata value"),
        "writable": _metadata_writable(node, field),
    }


def _connector(node, direction, index):
    attr = "inputConnectors" if direction == "input" else "outputConnectors"
    try:
        connectors = list(getattr(node, attr) or [])
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if not 0 <= index < len(connectors):
        _fail("stale_plan")
    return connectors[index]


def _connector_index(connector):
    try:
        value = int(connector.index)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc
    if not 0 <= value <= 255:
        _fail("stale_plan")
    return value


def _connections(connector):
    try:
        return list(connector.connections or [])
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("stale_plan") from exc


def _peer_fact(connector, path_field, index_field):
    owner = getattr(connector, "owner", None)
    return {
        path_field: _path(owner),
        index_field: _connector_index(connector),
    }


def _input_fact(node, index):
    peers = [
        _peer_fact(connection, "source_path", "source_output")
        for connection in _connections(_connector(node, "input", index))
    ]
    peers.sort(key=lambda item: (item["source_path"], item["source_output"]))
    return {"occupants": peers}


def _output_fact(node, index):
    peers = [
        _peer_fact(connection, "target_path", "target_input")
        for connection in _connections(_connector(node, "output", index))
    ]
    peers.sort(key=lambda item: (item["target_path"], item["target_input"]))
    return {"targets": peers}


def _entity_state(node, required):
    return {
        "parameters": {
            name: _parameter_fact(node, name) for name in sorted(required["parameters"])
        },
        "metadata": {
            name: _metadata_fact(node, name) for name in sorted(required["metadata"])
        },
        "connectors": {
            "inputs": {
                str(index): _input_fact(node, index)
                for index in sorted(required["inputs"])
            },
            "outputs": {
                str(index): _output_fact(node, index)
                for index in sorted(required["outputs"])
            },
        },
    }


def _entity_fact(td, path, required):
    node = _resolve_op(td, path, required=False)
    if node is None:
        return {
            "path": path,
            "exists": False,
            "identity": None,
            "type": None,
            "state": {},
        }
    return {
        "path": path,
        "exists": True,
        "identity": _identity(node),
        "type": _op_type(node),
        "state": _entity_state(node, required),
    }


def _project_identity(td):
    project = getattr(td, "project", None)
    root = _resolve_op(td, "/", required=False)
    material = {
        "name": str(getattr(project, "name", "") or ""),
        "folder": str(getattr(project, "folder", "") or ""),
        "root": _identity(root) if root is not None else "root-unavailable",
    }
    return hashlib.sha256(_canonical_json(material)).hexdigest()


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "")
    except Exception:  # noqa: BLE001
        return ""


def _active_pane(panes):
    for name in ("current", "currentPane"):
        try:
            pane = getattr(panes, name)
        except Exception:  # noqa: BLE001
            continue
        if pane is not None:
            return pane
    return None


def _runtime_context(td, expected):
    if expected is None:
        return None
    ui = getattr(td, "ui", None)
    panes = getattr(ui, "panes", None) if ui is not None else None
    pane = _active_pane(panes) if panes is not None else None
    if pane is None or _pane_type(pane).upper().replace("_", "") != "NETWORKEDITOR":
        return None
    try:
        owner = pane.owner
        current = owner.currentChild
        selected = list(owner.selectedChildren or [])
    except Exception:  # noqa: BLE001
        return None
    return {
        "owner_path": _path(owner),
        "current_path": _path(current),
        "selected_paths": sorted(_path(node) for node in selected),
    }


def _runtime_type_fact(td, type_name):
    operator_class = getattr(td, type_name, None)
    return {
        "resolved_name": type_name,
        "creatable": type_name in INERT_OPERATOR_TYPES and inspect.isclass(operator_class),
    }


def capture_scalar_snapshot(td, canonical_plan, affected_paths, requested_operator_types):
    """Capture the exact bounded scalar contract without retaining TD proxies."""

    aliases = _simulate_aliases_and_scope(
        canonical_plan["intents"], canonical_plan["owner_path"]
    )
    contract = _derive_state_contract(canonical_plan, aliases, affected_paths)
    owner = _resolve_op(td, canonical_plan["owner_path"])
    app = getattr(td, "app", None)
    snapshot = {
        "schema_version": 1,
        "td_build": str(getattr(app, "build", "unknown")),
        "project_identity": _project_identity(td),
        "owner": {
            "path": _path(owner),
            "identity": _identity(owner),
            "type": _op_type(owner),
        },
        "context": _runtime_context(td, canonical_plan.get("expected_context")),
        "runtime_types": {
            name: _runtime_type_fact(td, name) for name in requested_operator_types
        },
        "entities": [
            _entity_fact(td, path, contract[path]) for path in affected_paths
        ],
    }
    return _scalar(snapshot, "runtime snapshot")


def _perform_mode(td):
    for source in (getattr(td, "ui", None), getattr(td, "project", None)):
        if source is None:
            continue
        try:
            return bool(source.performMode)
        except Exception:  # noqa: BLE001
            continue
    return False


def _validate_undo_methods(undo):
    if undo is None:
        _fail("ui_unavailable")
    missing = any(
        not callable(getattr(undo, name, None))
        for name in ("startBlock", "endBlock", "addCallback")
    )
    if missing:
        _fail("undo_unavailable")


def _validate_undo_state(undo):
    try:
        global_enabled = bool(undo.globalState) is True
        idle = bool(undo.state) is False
        list(undo.undoStack)
        list(undo.redoStack)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("undo_unavailable") from exc
    if not global_enabled:
        _fail("undo_unavailable")
    if not idle:
        _fail("undo_busy")


def _undo_api(td):
    if _perform_mode(td):
        _fail("perform_mode")
    ui = getattr(td, "ui", None)
    undo = getattr(ui, "undo", None) if ui is not None else None
    _validate_undo_methods(undo)
    _validate_undo_state(undo)
    return undo


def _stack_labels(undo):
    try:
        return [str(item) for item in list(undo.undoStack)]
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("undo_unavailable") from exc


def _requested_types(plan):
    return tuple(
        sorted(
            {
                intent["type"]
                for intent in plan["intents"]
                if intent["kind"] == "create_operator"
            }
        )
    )


def _final_paths(prepared, index):
    return list(prepared.effects[index]["target_paths"])


def _result(prepared, index, status):
    return {
        "index": index,
        "kind": prepared.canonical_plan["intents"][index]["kind"],
        "status": status,
        "final_paths": _final_paths(prepared, index),
    }


def _menu_value(parameter, requested):
    names = list(getattr(parameter, "menuNames", None) or [])
    labels = list(getattr(parameter, "menuLabels", None) or [])
    if not names and not labels:
        return requested
    if requested in names:
        return requested
    if requested in labels:
        return names[labels.index(requested)]
    _fail("apply_failed")


def _set_parameter(node, name, requested, action, actions):
    parameter = _parameter(node, name)
    before = _parameter_fact(node, name)
    if not before["writable"]:
        _fail("stale_plan")
    requested = _menu_value(parameter, requested)
    expected = copy.deepcopy(before)
    expected["value"] = _scalar(requested, "requested parameter value")
    action.update({"before": before, "after": expected})
    actions.append(action)
    try:
        parameter.val = requested
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("apply_failed") from exc
    if _parameter_fact(node, name) != expected:
        _fail("verification_failed")


def _write_metadata(node, field, value):
    try:
        if field == "position":
            node.nodeX = value["x"]
            node.nodeY = value["y"]
        elif field == "color":
            node.color = tuple(value)
        else:
            setattr(node, field, value)
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("apply_failed") from exc


def _set_metadata(node, field, requested, action, actions):
    before = _metadata_fact(node, field)
    if not before["writable"]:
        _fail("stale_plan")
    expected = copy.deepcopy(before)
    expected["value"] = _scalar(requested, "requested metadata value")
    action.update({"before": before, "after": expected})
    actions.append(action)
    _write_metadata(node, field, requested)
    if _metadata_fact(node, field) != expected:
        _fail("verification_failed")


def _edge_present(td, source_path, source_output, target_path, target_input):
    source = _resolve_op(td, source_path)
    target = _resolve_op(td, target_path)
    output = _connector(source, "output", source_output)
    input_connector = _connector(target, "input", target_input)
    output_peers = {
        (_path(getattr(peer, "owner", None)), _connector_index(peer))
        for peer in _connections(output)
    }
    input_peers = {
        (_path(getattr(peer, "owner", None)), _connector_index(peer))
        for peer in _connections(input_connector)
    }
    in_output = (target_path, target_input) in output_peers
    in_input = (source_path, source_output) in input_peers
    if in_output != in_input:
        _fail("stale_plan")
    return in_output


def _write_edge(td, action, present):
    source = _resolve_op(td, action["source_path"])
    target = _resolve_op(td, action["target_path"])
    output = _connector(source, "output", action["source_output"])
    input_connector = _connector(target, "input", action["target_input"])
    try:
        if present:
            input_connector.connect(output)
        else:
            input_connector.disconnect()
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("apply_failed") from exc


def _direct_child_paths(node):
    try:
        children = list(node.children or [])
    except Exception:  # noqa: BLE001
        return []
    if len(children) > MAX_DIRECT_CHILDREN:
        _fail("operation_capacity")
    return sorted(_path(child) for child in children)


def _annotation_values(node):
    values = {}
    for name in _ANNOTATION_PAR_NAMES:
        parameter = _parameter(node, name)
        values[name] = _read_parameter_value(parameter)
    return values


def _created_fact(td, path, required, annotation=False):
    node = _resolve_op(td, path)
    fact = {
        "entity": _entity_fact(td, path, required),
        "node": {
            "position": _position_value(node),
            "viewer": bool(getattr(node, "viewer", False)),
            "color": _color_value(node),
            "comment": str(getattr(node, "comment", "")),
            "children": _direct_child_paths(node),
        },
    }
    if annotation:
        fact["annotation"] = {
            "width": _integral_coordinate(node.nodeWidth),
            "height": _integral_coordinate(node.nodeHeight),
            "parameters": _annotation_values(node),
        }
    if _op_type(node) == "textDAT" and hasattr(node, "text"):
        fact["text"] = _scalar(str(node.text), "created Text DAT content")
    return _scalar(fact, "created operator fact")


def _create_class(td, intent):
    type_name = "annotateCOMP" if intent["kind"] == "create_annotation" else intent["type"]
    operator_class = getattr(td, type_name, None)
    if not inspect.isclass(operator_class):
        _fail("unsupported_operator_type")
    if intent["kind"] == "create_operator" and type_name not in INERT_OPERATOR_TYPES:
        _fail("unsupported_operator_type")
    return operator_class


def _configure_annotation(node, intent):
    bounds = intent["bounds"]
    node.nodeX = bounds["x"]
    node.nodeY = bounds["y"]
    node.nodeWidth = bounds["w"]
    node.nodeHeight = bounds["h"]
    assignments = {}
    if "title" in intent:
        assignments["Titletext"] = intent["title"]
    if "body" in intent:
        assignments["Bodytext"] = intent["body"]
    if "color" in intent:
        assignments.update(
            {
                "Backcolorr": intent["color"][0],
                "Backcolorg": intent["color"][1],
                "Backcolorb": intent["color"][2],
            }
        )
    for name, value in assignments.items():
        parameter = _parameter(node, name)
        parameter.val = value
        if _read_parameter_value(parameter) != value:
            _fail("verification_failed")


def _create_node(td, intent, aliases, contract, index, actions):
    path = aliases[intent["ref"]]["path"]
    if _resolve_op(td, path, required=False) is not None:
        _fail("stale_plan")
    parent_path = _resolve_target(intent["parent"], aliases)
    parent = _resolve_op(td, parent_path)
    operator_class = _create_class(td, intent)
    try:
        node = parent.create(operator_class, intent["name"])
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("apply_failed") from exc
    action = {
        "index": index,
        "kind": "create",
        "path": path,
        "intent": copy.deepcopy(intent),
        "before": {"exists": False},
        "after": {"partial_identity": _identity(node)},
        "partial": True,
    }
    actions.append(action)
    if intent["kind"] == "create_annotation":
        _configure_annotation(node, intent)
    else:
        # Placement is immediate and deterministic; never leave a default stack.
        node.nodeX = intent["position"]["x"]
        node.nodeY = intent["position"]["y"]
        if "viewer" in intent:
            node.viewer = intent["viewer"]
    if _path(node) != path:
        _fail("verification_failed")
    action["after"] = _created_fact(
        td,
        path,
        contract[path],
        annotation=intent["kind"] == "create_annotation",
    )
    action["partial"] = False


def _target_path(intent, aliases):
    return _resolve_target(intent["target"], aliases)


def _apply_parameter_intent(td, intent, aliases, index, actions):
    path = _target_path(intent, aliases)
    node = _resolve_op(td, path)
    changed = False
    for name, value in intent["values"].items():
        before = _parameter_fact(node, name)
        requested = _menu_value(_parameter(node, name), value)
        if before["value"] == requested:
            continue
        action = {
            "index": index,
            "kind": "parameter",
            "path": path,
            "identity": _identity(node),
            "name": name,
        }
        _set_parameter(node, name, value, action, actions)
        changed = True
    return changed


def _apply_metadata_intent(td, intent, aliases, index, actions):
    path = _target_path(intent, aliases)
    node = _resolve_op(td, path)
    changed = False
    for field in _METADATA_FIELDS:
        if field not in intent:
            continue
        before = _metadata_fact(node, field)
        if before["value"] == intent[field]:
            continue
        action = {
            "index": index,
            "kind": "metadata",
            "path": path,
            "identity": _identity(node),
            "field": field,
        }
        _set_metadata(node, field, intent[field], action, actions)
        changed = True
    return changed


def _edge_action(intent, aliases, index):
    return {
        "index": index,
        "kind": "edge",
        "source_path": _resolve_target(intent["source"], aliases),
        "source_output": intent["source_output"],
        "target_path": _resolve_target(intent["target"], aliases),
        "target_input": intent["target_input"],
    }


def _apply_edge_intent(td, intent, aliases, index, actions):
    action = _edge_action(intent, aliases, index)
    before = _edge_present(
        td,
        action["source_path"],
        action["source_output"],
        action["target_path"],
        action["target_input"],
    )
    requested = intent["kind"] == "connect"
    if before == requested:
        return False
    action.update({"before": before, "after": requested})
    actions.append(action)
    _write_edge(td, action, requested)
    if _edge_present(
        td,
        action["source_path"],
        action["source_output"],
        action["target_path"],
        action["target_input"],
    ) is not requested:
        _fail("verification_failed")
    return True


def _apply_intent(td, prepared, intent, index, aliases, contract, actions):
    kind = intent["kind"]
    if kind in ("create_operator", "create_annotation"):
        _create_node(td, intent, aliases, contract, index, actions)
        return True
    if kind == "set_constant_parameters":
        return _apply_parameter_intent(td, intent, aliases, index, actions)
    if kind == "edit_metadata":
        return _apply_metadata_intent(td, intent, aliases, index, actions)
    return _apply_edge_intent(td, intent, aliases, index, actions)


def _apply_plan(td, prepared, deadline=None, actions=None, results=None):
    plan = prepared.canonical_plan
    aliases = _simulate_aliases_and_scope(plan["intents"], plan["owner_path"])
    contract = _derive_state_contract(plan, aliases, prepared.affected_paths)
    actions = [] if actions is None else actions
    results = [] if results is None else results
    for index, intent in enumerate(plan["intents"]):
        if deadline is not None and time.monotonic() > deadline:
            raise OperationTdAdapterError("apply_failed")
        changed = _apply_intent(
            td,
            prepared,
            intent,
            index,
            aliases,
            contract,
            actions,
        )
        results.append(_result(prepared, index, "applied" if changed else "unchanged"))
    return actions, results


def _create_action_contract(action):
    required = action["after"]["entity"]["state"]
    return {
        "parameters": set(required["parameters"]),
        "metadata": set(required["metadata"]),
        "inputs": {int(key) for key in required["connectors"]["inputs"]},
        "outputs": {int(key) for key in required["connectors"]["outputs"]},
    }


def _create_action_state(td, action):
    node = _resolve_op(td, action["path"], required=False)
    if node is None:
        return action["before"]
    if action.get("partial"):
        return {"partial_identity": _identity(node)}
    annotation = action["intent"]["kind"] == "create_annotation"
    return _created_fact(
        td,
        action["path"],
        _create_action_contract(action),
        annotation=annotation,
    )


def _node_action_state(td, action):
    node = _resolve_op(td, action["path"])
    if _identity(node) != action["identity"]:
        _fail("rollback_conflict")
    if action["kind"] == "parameter":
        return _parameter_fact(node, action["name"])
    return _metadata_fact(node, action["field"])


def _edge_action_state(td, action):
    return _edge_present(
        td,
        action["source_path"],
        action["source_output"],
        action["target_path"],
        action["target_input"],
    )


def _current_action_state(td, action):
    if action["kind"] == "create":
        return _create_action_state(td, action)
    if action["kind"] in ("parameter", "metadata"):
        return _node_action_state(td, action)
    return _edge_action_state(td, action)


def _destroy_created(td, action):
    node = _resolve_op(td, action["path"], required=False)
    if node is None:
        return
    try:
        node.destroy()
    except Exception as exc:  # noqa: BLE001
        raise OperationTdAdapterError("rollback_failed") from exc
    if _resolve_op(td, action["path"], required=False) is not None:
        _fail("rollback_failed")


def _restore_action_before(td, action):
    current = _current_action_state(td, action)
    if current == action["before"]:
        return False
    if current != action["after"]:
        _fail("rollback_conflict")
    kind = action["kind"]
    if kind == "create":
        _destroy_created(td, action)
    elif kind == "parameter":
        node = _resolve_op(td, action["path"])
        _set_parameter(
            node,
            action["name"],
            action["before"]["value"],
            {**action},
            [],
        )
    elif kind == "metadata":
        node = _resolve_op(td, action["path"])
        _write_metadata(node, action["field"], action["before"]["value"])
    else:
        _write_edge(td, action, action["before"])
    if _current_action_state(td, action) != action["before"]:
        _fail("rollback_failed")
    return True


def _refresh_created_identity(actions, path, identity):
    for candidate in actions:
        if candidate.get("path") == path and candidate.get("kind") in (
            "parameter",
            "metadata",
        ):
            candidate["identity"] = identity


def _recreate_action_after(td, action, aliases, contract, all_actions):
    fresh_actions = []
    try:
        _create_node(
            td,
            action["intent"],
            aliases,
            contract,
            action["index"],
            fresh_actions,
        )
    except OperationTdAdapterError:
        if fresh_actions:
            _rollback_actions(td, fresh_actions)
        raise
    if len(fresh_actions) != 1:
        _fail("rollback_failed")
    fresh = fresh_actions[0]
    action["after"] = copy.deepcopy(fresh["after"])
    action["partial"] = False
    _refresh_created_identity(
        all_actions,
        action["path"],
        fresh["after"]["entity"]["identity"],
    )


def _write_action_after(td, action):
    kind = action["kind"]
    if kind == "parameter":
        node = _resolve_op(td, action["path"])
        _set_parameter(
            node,
            action["name"],
            action["after"]["value"],
            {**action},
            [],
        )
    elif kind == "metadata":
        node = _resolve_op(td, action["path"])
        _write_metadata(node, action["field"], action["after"]["value"])
    else:
        _write_edge(td, action, action["after"])


def _restore_action_after(td, action, aliases, contract, all_actions):
    current = _current_action_state(td, action)
    if current == action["after"]:
        return False
    if current != action["before"]:
        _fail("rollback_conflict")
    if action["kind"] == "create":
        _recreate_action_after(td, action, aliases, contract, all_actions)
    else:
        _write_action_after(td, action)
    if _current_action_state(td, action) != action["after"]:
        _fail("rollback_failed")
    return True


def _rollback_actions(td, actions):
    restored = []
    errors = {}
    for action in reversed(actions):
        try:
            if _restore_action_before(td, action):
                restored.append(action)
        except OperationTdAdapterError as exc:
            errors.setdefault(action["index"], exc.code)
    return restored, errors


def _rollforward_actions(td, journal, selected_actions=None):
    actions = _journal_actions(journal)
    selected_ids = (
        None if selected_actions is None else {id(action) for action in selected_actions}
    )
    plan = journal["plan"]
    aliases = _simulate_aliases_and_scope(plan["intents"], plan["owner_path"])
    contract = _derive_state_contract(plan, aliases, journal["affected_paths"])
    restored = []
    errors = {}
    for action in actions:
        if selected_ids is not None and id(action) not in selected_ids:
            continue
        try:
            if _restore_action_after(td, action, aliases, contract, actions):
                restored.append(action)
        except OperationTdAdapterError as exc:
            errors.setdefault(action["index"], exc.code)
            break
    return restored, errors


def _failure_results(prepared, actions, rollback_errors):
    touched = {action["index"] for action in actions}
    return tuple(
        _result(
            prepared,
            index,
            "rollback_failed"
            if index in rollback_errors
            else "rolled_back"
            if index in touched
            else "unchanged",
        )
        for index in range(len(prepared.canonical_plan["intents"]))
    )


def _rollback_report(errors):
    return RollbackReport(
        attempted=True,
        succeeded=not errors,
        errors=tuple(
            RollbackError(index, code, "sanitized")
            for index, code in sorted(errors.items())
        ),
    )


def _failed_outcome(prepared, operation_id, actions, errors, error_code, before_ok):
    status = "failed_rolled_back" if not errors and before_ok else "failed_rollback"
    return TransactionOutcome(
        status=status,
        operation_id=operation_id,
        results=_failure_results(prepared, actions, errors),
        verification_status="PASS" if status == "failed_rolled_back" else "FAIL",
        verification_snapshot="before" if before_ok else "unknown",
        rollback=_rollback_report(errors),
        journal=JournalReport(),
        error_code=error_code,
    )


def _unknown_outcome(operation_id):
    return TransactionOutcome(
        status="outcome_unknown",
        operation_id=operation_id,
        results=(),
        verification_status="FAIL",
        verification_snapshot="unknown",
        rollback=RollbackReport(attempted=False, succeeded=False),
        journal=JournalReport(),
        error_code="outcome_unknown",
    )


def _create_actions(actions):
    return [action for action in actions if action.get("kind") == "create"]


def _absent_created_intrinsics(actions):
    return {
        action["path"]: {"exists": False}
        for action in sorted(_create_actions(actions), key=lambda item: item["path"])
    }


def _current_created_intrinsics(td, actions):
    facts = {}
    for action in sorted(_create_actions(actions), key=lambda item: item["path"]):
        path = action["path"]
        if _resolve_op(td, path, required=False) is None:
            facts[path] = {"exists": False}
            continue
        facts[path] = _created_fact(
            td,
            path,
            _create_action_contract(action),
            annotation=action["intent"]["kind"] == "create_annotation",
        )
    return _scalar(facts, "created operator journal facts")


def _bounded_journal_graph_snapshot(snapshot, created_intrinsics=None):
    graph = copy.deepcopy(snapshot)
    # Editor selection/current are commit CAS inputs, not graph fields owned by
    # undo/redo.  A later artist selection must not block a safe journal replay.
    graph["context"] = None
    if created_intrinsics is not None:
        graph["created_intrinsics"] = copy.deepcopy(created_intrinsics)
    safe = _scalar(graph, "operation journal snapshot")
    if len(_canonical_json(safe)) > MAX_JOURNAL_BYTES:
        _fail("operation_capacity")
    return safe


def _journal_info(td, prepared, operation_id, before, after, actions):
    info = {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "operation_id": operation_id,
        "generation": 0,
        "direction": "forward",
        "lineage": {
            "root_operation_id": operation_id,
            "source_operation_id": None,
        },
        "plan": copy.deepcopy(prepared.canonical_plan),
        "affected_paths": list(prepared.affected_paths),
        "requested_types": list(_requested_types(prepared.canonical_plan)),
        "source_snapshot": _bounded_journal_graph_snapshot(
            before,
            _absent_created_intrinsics(actions),
        ),
        "target_snapshot": _bounded_journal_graph_snapshot(
            after,
            _current_created_intrinsics(td, actions),
        ),
        "inverse_actions": copy.deepcopy(actions),
    }
    safe = _scalar(info, "operation journal")
    if len(_canonical_json(safe)) > MAX_JOURNAL_BYTES:
        _fail("operation_capacity")
    return safe


def _legacy_journal_graph_snapshot(snapshot):
    return _bounded_journal_graph_snapshot(snapshot)


def _journal_stack_or_registration_error(undo):
    try:
        return _stack_labels(undo)
    except OperationTdAdapterError as exc:
        raise JournalRegistrationError(orphan_possible=False) from exc


def _start_journal_registration(undo, label, info):
    try:
        undo.startBlock(label)
    except Exception as exc:  # noqa: BLE001
        return False, False, exc
    try:
        undo.addCallback(operation_journal_callback, info)
    except Exception as exc:  # noqa: BLE001
        return True, False, exc
    return True, True, None


def _end_journal_registration(undo, started):
    if not started:
        return False
    try:
        undo.endBlock()
    except Exception:  # noqa: BLE001
        return True
    return False


def _journal_registration_state(undo):
    try:
        return _stack_labels(undo), bool(undo.state) is False
    except OperationTdAdapterError:
        return [], False


def _register_journal(undo, label, info):
    before = _journal_stack_or_registration_error(undo)
    started, callback_added, error = _start_journal_registration(undo, label, info)
    end_failed = _end_journal_registration(undo, started)
    after, idle = _journal_registration_state(undo)
    delta = len(after) - len(before)
    registered = error is None and not end_failed and idle and delta == 1
    if registered and after and after[0] == label:
        return 1
    orphan_possible = callback_added or end_failed or delta != 0
    raise JournalRegistrationError(orphan_possible=orphan_possible)


def _capture_prepared(td, prepared):
    return capture_scalar_snapshot(
        td,
        prepared.canonical_plan,
        prepared.affected_paths,
        _requested_types(prepared.canonical_plan),
    )


def _restore_global_state(undo, original):
    try:
        undo.globalState = original
        return bool(undo.globalState) is original
    except Exception:  # noqa: BLE001
        return False


def _apply_with_recording_disabled(td, prepared, undo):
    original = bool(undo.globalState)
    stack_before = _stack_labels(undo)
    actions = []
    results = []
    error = None
    restored = False
    try:
        undo.globalState = False
        if bool(undo.globalState) is not False or _stack_labels(undo) != stack_before:
            _fail("undo_unavailable")
        _apply_plan(
            td,
            prepared,
            deadline=time.monotonic() + SOFT_TRANSACTION_SECONDS,
            actions=actions,
            results=results,
        )
        if _stack_labels(undo) != stack_before:
            _fail("undo_busy")
    except OperationTdAdapterError as exc:
        error = exc
        restored_actions, rollback_errors = _rollback_actions(td, actions)
        del restored_actions
    else:
        rollback_errors = {}
    finally:
        restored = _restore_global_state(undo, original)
    return actions, results, error, rollback_errors, restored


def _rollback_journal_failure(td, prepared, undo, operation_id, actions, error_code):
    original = bool(undo.globalState)
    try:
        undo.globalState = False
        _, rollback_errors = _rollback_actions(td, actions)
    finally:
        global_restored = _restore_global_state(undo, original)
    try:
        before_ok = global_restored and _capture_prepared(td, prepared) == prepared.snapshot
    except Exception:  # noqa: BLE001 - graph was compensated but proof is unknown.
        before_ok = False
    return _failed_outcome(
        prepared,
        operation_id,
        actions,
        rollback_errors,
        error_code,
        before_ok,
    )


def _applied_outcome(operation_id, results, label, stack_delta, private_journal):
    return TransactionOutcome(
        status="applied",
        operation_id=operation_id,
        results=tuple(results),
        verification_status="PASS",
        verification_snapshot="after",
        rollback=RollbackReport(),
        journal=JournalReport(
            registered=True,
            operation_id=operation_id,
            label=label,
            native_stack_delta=stack_delta,
            observed_state="applied",
        ),
        private_journal=copy.deepcopy(private_journal),
    )


def _finalize_applied(td, prepared, undo, operation_id, label, actions, results):
    try:
        after = _capture_prepared(td, prepared)
        info = _journal_info(
            td,
            prepared,
            operation_id,
            prepared.snapshot,
            after,
            actions,
        )
        stack_delta = _register_journal(undo, label, info)
    except JournalRegistrationError as exc:
        if exc.orphan_possible:
            return _unknown_outcome(operation_id)
        return _rollback_journal_failure(
            td,
            prepared,
            undo,
            operation_id,
            actions,
            "journal_registration_failed",
        )
    except OperationTdAdapterError as exc:
        return _rollback_journal_failure(
            td,
            prepared,
            undo,
            operation_id,
            actions,
            exc.code,
        )
    except Exception:  # noqa: BLE001 - post-write verification must compensate.
        return _rollback_journal_failure(
            td,
            prepared,
            undo,
            operation_id,
            actions,
            "verification_failed",
        )

    _remember_journal(info, "applied")
    return _applied_outcome(operation_id, results, label, stack_delta, info)


def execute_td_transaction(td, prepared, operation_id, label):
    """Execute one bounded transaction synchronously on the current TD thread."""

    try:
        _ensure_journal_capacity(operation_id)
        undo = _undo_api(td)
        current = _capture_prepared(td, prepared)
    except OperationTdAdapterError as exc:
        return _failed_outcome(prepared, operation_id, [], {}, exc.code, True)
    if current != prepared.snapshot:
        return _unknown_outcome(operation_id)

    actions, results, error, rollback_errors, global_restored = _apply_with_recording_disabled(
        td, prepared, undo
    )
    if not global_restored:
        return _unknown_outcome(operation_id)
    if error is not None:
        before_ok = _capture_prepared(td, prepared) == prepared.snapshot
        return _failed_outcome(
            prepared,
            operation_id,
            actions,
            rollback_errors,
            error.code,
            before_ok,
        )
    return _finalize_applied(
        td,
        prepared,
        undo,
        operation_id,
        label,
        actions,
        results,
    )


_JOURNALS = OrderedDict()
_JOURNAL_LOCK = threading.RLock()


def _prune_journals_locked(now=None):
    now = time.monotonic() if now is None else float(now)
    for operation_id, record in list(_JOURNALS.items()):
        if record["expires_at"] <= now:
            _JOURNALS.pop(operation_id, None)


def _ensure_journal_capacity(operation_id):
    """Fail before mutation when retention cannot preserve a future journal."""

    with _JOURNAL_LOCK:
        _prune_journals_locked()
        if operation_id not in _JOURNALS and len(_JOURNALS) >= MAX_JOURNALS:
            _fail("operation_capacity")


def _remember_journal(info, state):
    safe = _scalar(info, "operation journal")
    operation_id = safe["operation_id"]
    with _JOURNAL_LOCK:
        _prune_journals_locked()
        if operation_id not in _JOURNALS and len(_JOURNALS) >= MAX_JOURNALS:
            _fail("operation_capacity")
        existing = _JOURNALS.get(operation_id)
        _JOURNALS[operation_id] = {
            "info": copy.deepcopy(safe),
            "state": state,
            "expires_at": existing["expires_at"]
            if existing is not None
            else time.monotonic() + JOURNAL_TTL_SECONDS,
        }
        _JOURNALS.move_to_end(operation_id)


def _journal_record(operation_id):
    with _JOURNAL_LOCK:
        _prune_journals_locked()
        record = _JOURNALS.get(operation_id)
        return copy.deepcopy(record) if record is not None else None


def _mark_known_journal_state(operation_id, state):
    with _JOURNAL_LOCK:
        _prune_journals_locked()
        record = _JOURNALS.get(operation_id)
        if record is None:
            return
        record["state"] = state
        _JOURNALS.move_to_end(operation_id)


def _update_journal_state(info, state):
    _remember_journal(info, state)


def _prepared_from_journal(info):
    class JournalPrepared:
        pass

    prepared = JournalPrepared()
    prepared.canonical_plan = copy.deepcopy(info["plan"])
    prepared.affected_paths = tuple(info["affected_paths"])
    prepared.snapshot = copy.deepcopy(_journal_source(info))
    aliases, effects, _, _ = _summarize_plan(prepared.canonical_plan)
    prepared.aliases = aliases
    prepared.effects = tuple(effects)
    return prepared


def _journal_format(info):
    if info.get("schema_version") == LEGACY_JOURNAL_SCHEMA_VERSION:
        return "legacy"
    if info.get("schema_version") == JOURNAL_SCHEMA_VERSION and {
        "before",
        "after",
        "actions",
    }.issubset(info):
        return "provisional_v2"
    if info.get("schema_version") == JOURNAL_SCHEMA_VERSION:
        return "v2"
    return "unknown"


def _journal_source(info):
    return info["source_snapshot"] if _journal_format(info) == "v2" else info["before"]


def _journal_target(info):
    return info["target_snapshot"] if _journal_format(info) == "v2" else info["after"]


def _journal_actions(info):
    return info["inverse_actions"] if _journal_format(info) == "v2" else info["actions"]


def _validate_legacy_journal(safe, journal_format, required):
    if set(safe) != required:
        _fail("outcome_unknown")
    if journal_format == "provisional_v2":
        _validate_created_intrinsics(
            safe["actions"],
            safe["before"],
            safe["after"],
            "forward",
        )


def _valid_v2_lineage(safe):
    lineage = safe["lineage"]
    return (
        type(safe["generation"]) is int
        and 0 <= safe["generation"] <= MAX_JOURNALS
        and safe["direction"] in ("forward", "compensating_revert")
        and type(lineage) is dict
        and set(lineage) == {"root_operation_id", "source_operation_id"}
        and type(lineage["root_operation_id"]) is str
        and (
            lineage["source_operation_id"] is None
            or type(lineage["source_operation_id"]) is str
        )
    )


def _validate_final_v2_journal(safe, required):
    if set(safe) != required or not _valid_v2_lineage(safe):
        _fail("outcome_unknown")
    _validate_created_intrinsics(
        safe["inverse_actions"],
        safe["source_snapshot"],
        safe["target_snapshot"],
        safe["direction"],
    )


def _validate_journal_info(info, require_final_v2=False):
    if type(info) is not dict:
        _fail("outcome_unknown")
    safe = _scalar(info, "operation journal")
    legacy_required = {
        "schema_version",
        "operation_id",
        "plan",
        "affected_paths",
        "requested_types",
        "before",
        "after",
        "actions",
    }
    v2_required = {
        "schema_version",
        "operation_id",
        "generation",
        "direction",
        "lineage",
        "plan",
        "affected_paths",
        "requested_types",
        "source_snapshot",
        "target_snapshot",
        "inverse_actions",
    }
    journal_format = _journal_format(safe)
    if require_final_v2 and journal_format != "v2":
        _fail("outcome_unknown")
    if journal_format in ("legacy", "provisional_v2"):
        _validate_legacy_journal(safe, journal_format, legacy_required)
    elif journal_format == "v2":
        _validate_final_v2_journal(safe, v2_required)
    else:
        _fail("outcome_unknown")
    if len(_canonical_json(safe)) > MAX_JOURNAL_BYTES:
        _fail("operation_capacity")
    return safe


def _validate_created_intrinsics(actions, source_snapshot, target_snapshot, direction):
    create_actions = _create_actions(actions)
    expected_paths = {action["path"] for action in create_actions}
    absent = source_snapshot if direction == "forward" else target_snapshot
    created = target_snapshot if direction == "forward" else source_snapshot
    absent_facts = absent.get("created_intrinsics")
    created_facts = created.get("created_intrinsics")
    if type(absent_facts) is not dict or type(created_facts) is not dict:
        _fail("outcome_unknown")
    if set(absent_facts) != expected_paths or set(created_facts) != expected_paths:
        _fail("outcome_unknown")
    for action in create_actions:
        path = action["path"]
        if absent_facts[path] != {"exists": False}:
            _fail("outcome_unknown")
        _validate_created_intrinsic_after(path, action, created_facts[path])


def _validate_created_intrinsic_after(path, action, fact):
    if type(fact) is not dict or set(fact) - {"entity", "node", "annotation", "text"}:
        _fail("outcome_unknown")
    if "entity" not in fact or "node" not in fact:
        _fail("outcome_unknown")
    entity = fact["entity"]
    node = fact["node"]
    if (
        type(entity) is not dict
        or entity.get("path") != path
        or entity.get("exists") is not True
        or type(node) is not dict
        or set(node) != {"position", "viewer", "color", "comment", "children"}
    ):
        _fail("outcome_unknown")
    annotation = action["intent"]["kind"] == "create_annotation"
    if annotation != ("annotation" in fact):
        _fail("outcome_unknown")
    is_text = action["intent"].get("type") == "textDAT"
    if is_text != ("text" in fact):
        _fail("outcome_unknown")


def _journal_snapshot(td, info):
    snapshot = capture_scalar_snapshot(
        td,
        info["plan"],
        tuple(info["affected_paths"]),
        tuple(info["requested_types"]),
    )
    if _journal_format(info) == "legacy":
        return _legacy_journal_graph_snapshot(snapshot)
    return _bounded_journal_graph_snapshot(
        snapshot,
        _current_created_intrinsics(td, _journal_actions(info)),
    )


def _legacy_undo_journal(td, info):
    if _journal_snapshot(td, info) != info["after"]:
        _update_journal_state(info, "drifted")
        return
    _, errors = _rollback_actions(td, info["actions"])
    if errors or _journal_snapshot(td, info) != info["before"]:
        _update_journal_state(info, "drifted")
        return
    _update_journal_state(info, "undone")


def _legacy_redo_journal(td, info):
    if _journal_snapshot(td, info) != info["before"]:
        _update_journal_state(info, "drifted")
        return
    prepared = _prepared_from_journal(info)
    actions = []
    try:
        _apply_plan(td, prepared, actions=actions)
    except OperationTdAdapterError:
        if actions:
            _rollback_actions(td, actions)
        _update_journal_state(info, "drifted")
        return
    after = _journal_snapshot(td, info)
    info["actions"] = copy.deepcopy(actions)
    info["after"] = copy.deepcopy(after)
    if len(_canonical_json(_scalar(info, "operation journal"))) > MAX_JOURNAL_BYTES:
        _rollback_actions(td, actions)
        _update_journal_state(info, "drifted")
        return
    _update_journal_state(info, "redone")


def _snapshot_matches_with_refreshed_create_identity(expected, current):
    normalized = copy.deepcopy(expected)
    expected_created = normalized.get("created_intrinsics")
    current_created = current.get("created_intrinsics")
    if type(expected_created) is not dict or type(current_created) is not dict:
        return normalized == current
    if set(expected_created) != set(current_created):
        return False
    if not _refresh_created_intrinsic_identities(expected_created, current_created):
        return False
    return _refresh_created_entity_identities(normalized, current, set(expected_created))


def _refresh_created_intrinsic_identities(expected_created, current_created):
    for path, expected_fact in expected_created.items():
        current_fact = current_created[path]
        if expected_fact == {"exists": False} or current_fact == {"exists": False}:
            continue
        try:
            expected_fact["entity"]["identity"] = current_fact["entity"]["identity"]
        except (KeyError, TypeError):
            return False
    return True


def _refresh_created_entity_identities(normalized, current, created_paths):
    current_entities = {
        entity.get("path"): entity
        for entity in current.get("entities", [])
        if type(entity) is dict
    }
    for entity in normalized.get("entities", []):
        if type(entity) is not dict or entity.get("path") not in created_paths:
            continue
        current_entity = current_entities.get(entity["path"])
        if current_entity is None:
            return False
        entity["identity"] = current_entity.get("identity")
    return normalized == current


def _apply_v2_transition_actions(td, info, to_source):
    inverse = info["direction"] == "forward" if to_source else info["direction"] != "forward"
    if inverse:
        changed, errors = _rollback_actions(td, _journal_actions(info))
        if errors:
            _rollforward_actions(td, info, changed)
    else:
        changed, errors = _rollforward_actions(td, info)
        if errors:
            _rollback_actions(td, changed)
    return inverse, changed, errors


def _restore_v2_transition(td, info, inverse, changed):
    if inverse:
        _rollforward_actions(td, info, changed)
    else:
        _rollback_actions(td, changed)


def _transition_v2_journal(td, info, to_source):
    expected = _journal_target(info) if to_source else _journal_source(info)
    if _journal_snapshot(td, info) != expected:
        _update_journal_state(info, "drifted")
        return
    inverse, changed, errors = _apply_v2_transition_actions(td, info, to_source)
    if errors:
        _update_journal_state(info, "drifted")
        return
    current = _journal_snapshot(td, info)
    destination = _journal_source(info) if to_source else _journal_target(info)
    if not _snapshot_matches_with_refreshed_create_identity(destination, current):
        _restore_v2_transition(td, info, inverse, changed)
        _update_journal_state(info, "drifted")
        return
    destination_key = "source_snapshot" if to_source else "target_snapshot"
    info[destination_key] = copy.deepcopy(current)
    if len(_canonical_json(_scalar(info, "operation journal"))) > MAX_JOURNAL_BYTES:
        _restore_v2_transition(td, info, inverse, changed)
        _update_journal_state(info, "drifted")
        return
    _update_journal_state(info, "undone" if to_source else "redone")


def _callback_undo(td):
    ui = getattr(td, "ui", None)
    undo = getattr(ui, "undo", None) if ui is not None else None
    if undo is None or not hasattr(undo, "globalState"):
        _fail("undo_unavailable")
    return undo


def _run_journal_direction(td, is_undo, info):
    if _journal_format(info) == "v2":
        _transition_v2_journal(td, info, bool(is_undo))
    elif bool(is_undo):
        _legacy_undo_journal(td, info)
    else:
        _legacy_redo_journal(td, info)


def _journal_operation_id(info):
    operation_id = info.get("operation_id") if type(info) is dict else None
    return operation_id if isinstance(operation_id, str) else None


def _journal_callback(td, is_undo, info):
    operation_id = _journal_operation_id(info)
    try:
        _validate_journal_info(info)
        undo = _callback_undo(td)
        original = bool(undo.globalState)
        try:
            undo.globalState = False
            if bool(undo.globalState) is not False:
                _fail("undo_unavailable")
            _run_journal_direction(td, is_undo, info)
        finally:
            if not _restore_global_state(undo, original):
                _fail("undo_unavailable")
    except Exception:  # noqa: BLE001 - native callback must never escape.
        if operation_id is not None:
            _mark_known_journal_state(operation_id, "drifted")


def operation_journal_callback(is_undo, info):
    """Module-level TouchDesigner callback; ``info`` must remain scalar-only."""

    import td

    _journal_callback(td, is_undo, info)


def _resolve_td_module(td_module):
    if td_module is not None:
        return td_module
    import td

    return td


def validate_journal_v2(journal):
    """Validate and copy the final private journal-v2 scalar contract."""

    return copy.deepcopy(_validate_journal_info(journal, require_final_v2=True))


def _journal_invariants(info):
    return {
        name: copy.deepcopy(info[name])
        for name in (
            "schema_version",
            "operation_id",
            "generation",
            "direction",
            "lineage",
            "plan",
            "affected_paths",
            "requested_types",
        )
    }


def _authorized_journal_record(journal):
    safe = validate_journal_v2(journal)
    record = _journal_record(safe["operation_id"])
    if record is None:
        return {"info": safe, "state": "unknown"}
    try:
        cached = validate_journal_v2(record["info"])
    except OperationTdAdapterError:
        return {"info": safe, "state": "unknown"}
    if _journal_invariants(cached) != _journal_invariants(safe):
        _fail("outcome_unknown")
    return {"info": cached, "state": record["state"]}


def observe_journal(journal, td_module=None):
    """Observe a journal obtained only after private receipt authorization."""

    try:
        record = _authorized_journal_record(journal)
        if record["state"] == "drifted":
            return "drifted"
        return _observed_snapshot_state(_resolve_td_module(td_module), record)
    except Exception:  # noqa: BLE001 - trusted observation still fails closed.
        return "unknown"


def _compensation_journal(source, revert_operation_id):
    info = {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "operation_id": revert_operation_id,
        "generation": source["generation"] + 1,
        "direction": "compensating_revert",
        "lineage": {
            "root_operation_id": source["lineage"]["root_operation_id"],
            "source_operation_id": source["operation_id"],
        },
        "plan": copy.deepcopy(source["plan"]),
        "affected_paths": copy.deepcopy(source["affected_paths"]),
        "requested_types": copy.deepcopy(source["requested_types"]),
        "source_snapshot": copy.deepcopy(source["target_snapshot"]),
        "target_snapshot": copy.deepcopy(source["source_snapshot"]),
        "inverse_actions": copy.deepcopy(source["inverse_actions"]),
    }
    return validate_journal_v2(info)


def _revert_outcome(
    source,
    revert_operation_id,
    status,
    verification_status,
    verification_snapshot,
    rollback=None,
    journal=None,
    error_code=None,
    private_journal=None,
):
    return RevertTransactionOutcome(
        status=status,
        source_operation_id=source["operation_id"],
        revert_operation_id=revert_operation_id,
        verification_status=verification_status,
        verification_snapshot=verification_snapshot,
        rollback=rollback or RollbackReport(),
        journal=journal or JournalReport(),
        error_code=error_code,
        private_journal=copy.deepcopy(private_journal),
    )


def _revert_failure_after_restore(source, revert_operation_id, restore_errors, restored):
    return _revert_outcome(
        source,
        revert_operation_id,
        "failed_rolled_back" if restored and not restore_errors else "failed_rollback",
        "PASS" if restored and not restore_errors else "FAIL",
        "after" if restored and not restore_errors else "unknown",
        rollback=_rollback_report(restore_errors),
        error_code="revert_failed"
        if restored and not restore_errors
        else "revert_rollback_failed",
    )


def _record_exact_revert_target(td, source, errors, global_restored):
    if errors or not global_restored:
        return False
    try:
        current = _journal_snapshot(td, source)
        matches = _snapshot_matches_with_refreshed_create_identity(
            source["target_snapshot"],
            current,
        )
    except Exception:  # noqa: BLE001 - restoration proof remains unknown.
        return False
    if not matches:
        return False
    source["target_snapshot"] = copy.deepcopy(current)
    try:
        _remember_journal(source, "applied")
    except OperationTdAdapterError:
        return False
    return True


def _rollforward_revert_source(td, source, undo, original_global_state, selected=None):
    errors = {}
    try:
        undo.globalState = False
        if bool(undo.globalState) is not False:
            _fail("undo_unavailable")
        _, errors = _rollforward_actions(td, source, selected)
    except OperationTdAdapterError as exc:
        errors.setdefault(0, exc.code)
    finally:
        restored_global_state = _restore_global_state(undo, original_global_state)
    restored = _record_exact_revert_target(
        td,
        source,
        errors,
        restored_global_state,
    )
    return errors, restored


def _revert_preflight(td, source, revert_operation_id):
    try:
        _ensure_journal_capacity(revert_operation_id)
        undo = _undo_api(td)
        if _journal_snapshot(td, source) != source["target_snapshot"]:
            return None, _revert_outcome(
                source,
                revert_operation_id,
                "failed_rolled_back",
                "FAIL",
                "unknown",
                error_code="operation_drifted",
            )
    except OperationTdAdapterError as exc:
        return None, _revert_outcome(
            source,
            revert_operation_id,
            "failed_rolled_back",
            "FAIL",
            "unknown",
            error_code=exc.code,
        )
    except Exception:  # noqa: BLE001 - preflight is a proven zero-write failure.
        return None, _revert_outcome(
            source,
            revert_operation_id,
            "failed_rolled_back",
            "FAIL",
            "unknown",
            error_code="revert_failed",
        )
    return undo, None


def _apply_revert_inverse(td, source, undo):
    original_global_state = bool(undo.globalState)
    changed = []
    inverse_errors = {}
    forward_errors = {}
    global_restored = False
    try:
        undo.globalState = False
        if bool(undo.globalState) is not False:
            _fail("undo_unavailable")
        changed, inverse_errors = _rollback_actions(td, source["inverse_actions"])
        if inverse_errors:
            _, forward_errors = _rollforward_actions(td, source, changed)
    except OperationTdAdapterError as exc:
        inverse_errors.setdefault(0, exc.code)
        if changed:
            _, forward_errors = _rollforward_actions(td, source, changed)
    finally:
        global_restored = _restore_global_state(undo, original_global_state)
    return original_global_state, inverse_errors, forward_errors, global_restored


def _failed_revert_with_rollforward(
    td,
    source,
    undo,
    original_global_state,
    revert_operation_id,
):
    restore_errors, restored = _rollforward_revert_source(
        td,
        source,
        undo,
        original_global_state,
    )
    return _revert_failure_after_restore(
        source,
        revert_operation_id,
        restore_errors,
        restored,
    )


def _register_compensation_or_restore(
    td,
    source,
    undo,
    original_global_state,
    revert_operation_id,
    label,
):
    try:
        compensation = _compensation_journal(source, revert_operation_id)
    except Exception:  # noqa: BLE001 - callback registration has not started.
        return _failed_revert_with_rollforward(
            td,
            source,
            undo,
            original_global_state,
            revert_operation_id,
        )
    try:
        stack_delta = _register_journal(undo, label, compensation)
    except JournalRegistrationError as exc:
        if not exc.orphan_possible:
            return _failed_revert_with_rollforward(
                td,
                source,
                undo,
                original_global_state,
                revert_operation_id,
            )
        return _revert_outcome(
            source,
            revert_operation_id,
            "outcome_unknown",
            "FAIL",
            "unknown",
            rollback=RollbackReport(attempted=False, succeeded=False),
            error_code="outcome_unknown",
        )
    try:
        _remember_journal(compensation, "applied")
    except Exception:  # noqa: BLE001 - callback may exist; never mutate again.
        return _revert_outcome(
            source,
            revert_operation_id,
            "outcome_unknown",
            "FAIL",
            "unknown",
            rollback=RollbackReport(attempted=False, succeeded=False),
            error_code="outcome_unknown",
        )
    return _revert_outcome(
        source,
        revert_operation_id,
        "reverted",
        "PASS",
        "before",
        journal=JournalReport(
            registered=True,
            operation_id=revert_operation_id,
            label=label,
            native_stack_delta=stack_delta,
            observed_state="applied",
        ),
        private_journal=compensation,
    )


def execute_revert_transaction(td, journal, revert_operation_id, label):
    """Execute one exact-CAS compensation without selecting native history."""

    source_record = _authorized_journal_record(journal)
    source = source_record["info"]
    if source_record["state"] == "drifted":
        return _revert_outcome(
            source,
            revert_operation_id,
            "failed_rolled_back",
            "FAIL",
            "unknown",
            error_code="operation_drifted",
        )
    undo, preflight_failure = _revert_preflight(td, source, revert_operation_id)
    if preflight_failure is not None:
        return preflight_failure
    (
        original_global_state,
        inverse_errors,
        forward_errors,
        global_restored,
    ) = _apply_revert_inverse(td, source, undo)

    if inverse_errors:
        restored = _record_exact_revert_target(
            td,
            source,
            forward_errors,
            global_restored,
        )
        return _revert_failure_after_restore(
            source,
            revert_operation_id,
            forward_errors,
            restored,
        )
    try:
        source_verified = (
            global_restored
            and _journal_snapshot(td, source) == source["source_snapshot"]
        )
    except Exception:  # noqa: BLE001 - post-inverse proof failed before callback.
        source_verified = False
    if not source_verified:
        return _failed_revert_with_rollforward(
            td,
            source,
            undo,
            original_global_state,
            revert_operation_id,
        )
    return _register_compensation_or_restore(
        td,
        source,
        undo,
        original_global_state,
        revert_operation_id,
        label,
    )


def _observed_snapshot_state(td, record):
    info = record["info"]
    try:
        current = _journal_snapshot(td, info)
    except Exception:  # noqa: BLE001
        return "unknown"
    if current == _journal_target(info):
        return "redone" if record["state"] == "redone" else "applied"
    if current == _journal_source(info):
        return "undone"
    return "drifted"


def observe_operation(operation_id, td_module=None):
    """Observe state by exact snapshot; caller must enforce receipt authority."""

    if type(operation_id) is not str or not 16 <= len(operation_id) <= 128:
        return "unknown"
    record = _journal_record(operation_id)
    if record is None:
        return "unknown"
    if record["state"] == "drifted":
        return "drifted"
    state = _observed_snapshot_state(_resolve_td_module(td_module), record)
    if state != "drifted":
        return state
    _mark_known_journal_state(operation_id, "drifted")
    return "drifted"


class TouchDesignerOperationAdapter(ScalarSnapshotAdapter, LiveTransactionAdapter):
    """Stateless live boundary; all retained journal data is bounded JSON."""

    capability = _LIVE_TRANSACTION_CAPABILITY

    def capture(self, canonical_plan, affected_paths, requested_operator_types):
        import td

        return capture_scalar_snapshot(
            td,
            canonical_plan,
            affected_paths,
            requested_operator_types,
        )

    def execute(self, prepared, operation_id, label):
        import td

        return execute_td_transaction(td, prepared, operation_id, label)

    def observe(self, operation_id):
        return observe_operation(operation_id)

    def validate_journal_v2(self, journal):
        return validate_journal_v2(journal)

    def observe_journal(self, journal):
        return observe_journal(journal)

    def execute_revert(self, journal, revert_operation_id, label):
        import td

        return execute_revert_transaction(td, journal, revert_operation_id, label)


__all__ = (
    "OperationTdAdapterError",
    "TouchDesignerOperationAdapter",
    "capture_scalar_snapshot",
    "execute_td_transaction",
    "execute_revert_transaction",
    "observe_journal",
    "observe_operation",
    "operation_journal_callback",
    "validate_journal_v2",
)
