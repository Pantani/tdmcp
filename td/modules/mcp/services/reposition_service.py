"""Bounded, atomic exact Network Editor placement.

Only structured operator geometry is read or written.  TouchDesigner proxies
remain on the synchronous call stack; the bounded idempotency store contains
plain scalar JSON only.  Undo ownership remains with the authenticated REST
request wrapper.
"""

import copy
import hashlib
import json
import math
import re
import time
from collections import OrderedDict


_MAX_PATH = 1024
_MAX_POSITIONS = 256
_MAX_SELECTION = 64
_MAX_AFFECTED = 1024
_MAX_COORDINATE = 1_000_000
_MAX_RECEIPTS = 128
_RECEIPT_TTL_SECONDS = 300.0
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_FINGERPRINT_RE = re.compile(r"^[a-f0-9]{64}$")
_TARGET_SOURCES = {"provided_paths", "active_selection"}


class RepositionError(ValueError):
    """Typed error safe for the bridge envelope."""

    def __init__(self, code, message, report=None):
        super().__init__(message)
        self.code = code
        self.report = report


def _fail(code, message, report=None):
    raise RepositionError(code, message, report)


def _invalid_path_shape(value):
    return (
        not isinstance(value, str)
        or not value.startswith("/")
        or len(value) > _MAX_PATH
        or any(char in value for char in ("\x00", "\r", "\n"))
    )


def _invalid_path_parts(value):
    if value == "/":
        return False
    return value.endswith("/") or any(
        part in ("", ".", "..") for part in value.split("/")[1:]
    )


def _validate_path(value, field, allow_root=True):
    if _invalid_path_shape(value):
        _fail("invalid_reposition_input", "%s is invalid or too long" % field)
    if _invalid_path_parts(value):
        _fail("invalid_reposition_input", "%s must be normalized" % field)
    if value == "/" and not allow_root:
        _fail("invalid_reposition_input", "%s cannot be the TouchDesigner root" % field)
    return value


def _validate_coordinate(value, field):
    if isinstance(value, bool) or not isinstance(value, int):
        _fail("invalid_reposition_input", "%s must be an integer" % field)
    if abs(value) > _MAX_COORDINATE:
        _fail("invalid_reposition_input", "%s exceeds the supported range" % field)
    return value


def _validate_position(item, index):
    if not isinstance(item, dict) or set(item) != {"path", "x", "y"}:
        _fail(
            "invalid_reposition_input",
            "positions[%d] must contain only path, x and y" % index,
        )
    return {
        "path": _validate_path(item.get("path"), "positions[%d].path" % index, False),
        "x": _validate_coordinate(item.get("x"), "positions[%d].x" % index),
        "y": _validate_coordinate(item.get("y"), "positions[%d].y" % index),
    }


def _validate_positions(value):
    if not isinstance(value, list) or not 1 <= len(value) <= _MAX_POSITIONS:
        _fail(
            "invalid_reposition_input",
            "positions must contain between 1 and %d entries" % _MAX_POSITIONS,
        )
    positions = [_validate_position(item, index) for index, item in enumerate(value)]
    paths = [item["path"] for item in positions]
    if len(set(paths)) != len(paths):
        _fail("invalid_reposition_input", "positions contains duplicate paths")
    if paths != sorted(paths):
        _fail("invalid_reposition_input", "positions must be sorted by path")
    return positions


def _validate_context_request(payload):
    if not isinstance(payload, dict):
        _fail("invalid_reposition_input", "reposition context payload must be an object")
    allowed = {"root_path", "target_source", "include_docked", "positions"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail(
            "invalid_reposition_input",
            "unsupported reposition fields: %s" % ", ".join(unknown),
        )
    target_source = payload.get("target_source")
    if target_source not in _TARGET_SOURCES:
        _fail("invalid_reposition_input", "target_source is unsupported")
    include_docked = payload.get("include_docked")
    if type(include_docked) is not bool:  # noqa: E721
        _fail("invalid_reposition_input", "include_docked must be a boolean")
    positions = _validate_positions(payload.get("positions"))
    if target_source == "active_selection" and len(positions) > _MAX_SELECTION:
        _fail(
            "invalid_reposition_input",
            "active_selection supports at most %d paths" % _MAX_SELECTION,
        )
    return {
        "root_path": _validate_path(payload.get("root_path"), "root_path"),
        "target_source": target_source,
        "include_docked": include_docked,
        "positions": positions,
    }


def _validate_editor_context(value, target_source):
    if target_source == "provided_paths":
        if value is not None:
            _fail(
                "invalid_reposition_input",
                "editor_context must be null for provided_paths",
            )
        return None
    required = {"owner_path", "current_path", "selected_paths"}
    if not isinstance(value, dict) or set(value) != required:
        _fail(
            "invalid_reposition_input",
            "editor_context must contain owner_path, current_path and selected_paths",
        )
    selected = value.get("selected_paths")
    if not isinstance(selected, list) or not 1 <= len(selected) <= _MAX_SELECTION:
        _fail("invalid_reposition_input", "selected_paths is outside the supported bounds")
    normalized = [
        _validate_path(path, "editor_context.selected_paths", False) for path in selected
    ]
    if normalized != sorted(set(normalized)):
        _fail("invalid_reposition_input", "selected_paths must be unique and sorted")
    return {
        "owner_path": _validate_path(value.get("owner_path"), "editor_context.owner_path"),
        "current_path": _validate_path(
            value.get("current_path"), "editor_context.current_path", False
        ),
        "selected_paths": normalized,
    }


def _validate_key(value):
    if not isinstance(value, str) or not _KEY_RE.fullmatch(value):
        _fail(
            "invalid_reposition_input",
            "idempotency_key must contain 16 to 128 URL-safe characters",
        )
    return value


def _validate_apply_request(payload):
    if not isinstance(payload, dict):
        _fail("invalid_reposition_input", "reposition payload must be an object")
    allowed = {
        "root_path",
        "target_source",
        "include_docked",
        "positions",
        "fingerprint",
        "editor_context",
        "idempotency_key",
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail(
            "invalid_reposition_input",
            "unsupported reposition fields: %s" % ", ".join(unknown),
        )
    context = _validate_context_request(
        {key: payload.get(key) for key in (
            "root_path",
            "target_source",
            "include_docked",
            "positions",
        )}
    )
    fingerprint = payload.get("fingerprint")
    if not isinstance(fingerprint, str) or not _FINGERPRINT_RE.fullmatch(fingerprint):
        _fail("invalid_reposition_input", "fingerprint must be 64 lowercase hex characters")
    context.update(
        {
            "fingerprint": fingerprint,
            "editor_context": _validate_editor_context(
                payload.get("editor_context"), context["target_source"]
            ),
            "idempotency_key": _validate_key(payload.get("idempotency_key")),
        }
    )
    return context


def _canonical_hash(value):
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _logical_intent(request):
    """Return only stable mutation intent for idempotency comparison.

    ``fingerprint`` and ``editor_context`` are volatile CAS receipts.  A caller
    recovering from a lost response must be able to acquire a fresh context and
    replay the same logical placement under the same key.
    """
    return {
        "root_path": request["root_path"],
        "target_source": request["target_source"],
        "include_docked": request["include_docked"],
        "positions": copy.deepcopy(request["positions"]),
    }


def _path(node):
    try:
        value = node.path
    except Exception:  # noqa: BLE001
        return None
    return str(value) if value else None


def _parent(node):
    try:
        value = node.parent
        return value() if callable(value) else value
    except Exception:  # noqa: BLE001
        return None


def _identity(node, path):
    try:
        native_id = getattr(node, "id")
    except Exception:  # noqa: BLE001
        native_id = id(node)
    return _canonical_hash({"path": path, "native_id": str(native_id)})


def _position(node, path):
    values = []
    for attribute in ("nodeX", "nodeY"):
        try:
            value = getattr(node, attribute)
        except Exception:  # noqa: BLE001
            _fail("invalid_reposition_input", "%s geometry is unavailable" % path)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            _fail("invalid_reposition_input", "%s geometry is not numeric" % path)
        if not math.isfinite(float(value)) or int(value) != value:
            _fail("invalid_reposition_input", "%s geometry must be integral" % path)
        values.append(_validate_coordinate(int(value), "%s.%s" % (path, attribute)))
    return values


def _perform_mode(td_runtime):
    for source in (getattr(td_runtime, "ui", None), getattr(td_runtime, "project", None)):
        if source is None:
            continue
        try:
            return bool(source.performMode)
        except Exception:  # noqa: BLE001
            continue
    return False


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "").upper().replace("_", "")
    except Exception:  # noqa: BLE001
        return ""


def _active_pane(panes):
    for attribute in ("current", "currentPane"):
        try:
            pane = getattr(panes, attribute)
        except Exception:  # noqa: BLE001
            continue
        if pane is not None:
            return pane
    return None


def _active_network_owner(td_runtime, root_path):
    if _perform_mode(td_runtime):
        _fail("perform_mode", "explicit selection placement is unavailable in Perform Mode")
    ui = getattr(td_runtime, "ui", None)
    if ui is None:
        _fail("ui_unavailable", "TouchDesigner UI is unavailable")
    panes = getattr(ui, "panes", None)
    if panes is None:
        _fail("ui_unavailable", "TouchDesigner pane collection is unavailable")
    pane = _active_pane(panes)
    if pane is None or _pane_type(pane) != "NETWORKEDITOR":
        _fail("no_active_network_editor", "the explicit active pane is not a Network Editor")
    owner = getattr(pane, "owner", None)
    if _path(owner) != root_path:
        _fail("selection_mismatch", "active Network Editor owner does not match root_path")
    return owner


def _selected_context(owner, root_path, requested_paths):
    try:
        selected_nodes = list(owner.selectedChildren or [])
    except Exception:  # noqa: BLE001
        _fail("no_selection", "active Network Editor selection is unavailable")
    if not selected_nodes:
        _fail("no_selection", "active Network Editor selection is empty")
    if len(selected_nodes) > _MAX_SELECTION:
        _fail("selection_mismatch", "active selection exceeds the supported bound")
    selected_paths = sorted(_path(node) for node in selected_nodes if _path(node))
    if len(selected_paths) != len(selected_nodes) or len(set(selected_paths)) != len(selected_paths):
        _fail("selection_mismatch", "active selection contains ambiguous operators")
    current_path = _path(getattr(owner, "currentChild", None))
    if current_path not in selected_paths:
        _fail("selection_mismatch", "current operator must be present in the selection")
    if selected_paths != sorted(requested_paths):
        _fail("selection_mismatch", "active selection does not match the requested paths")
    return {
        "owner_path": root_path,
        "current_path": current_path,
        "selected_paths": selected_paths,
    }


def _editor_context(td_runtime, root_path, requested_paths):
    owner = _active_network_owner(td_runtime, root_path)
    return _selected_context(owner, root_path, requested_paths)


def _resolve_root(td_runtime, root_path):
    root = td_runtime.op(root_path)
    if root is None:
        _fail("reposition_root_not_found", "root operator was not found")
    try:
        list(root.children or [])
    except Exception:  # noqa: BLE001
        _fail("invalid_reposition_input", "root_path must identify a COMP network")
    return root


def _resolve_target(td_runtime, root, root_path, path):
    node = td_runtime.op(path)
    if node is None:
        _fail("reposition_target_not_found", "reposition target was not found: %s" % path)
    parent = _parent(node)
    if parent is None or _path(parent) != root_path:
        _fail("cross_parent_reposition", "every target must be an immediate child of root_path")
    if node is root:
        _fail("cross_parent_reposition", "root_path cannot replace a target")
    return node


def _direct_docked(node):
    try:
        return list(node.docked or [])
    except Exception:  # noqa: BLE001
        _fail("unsupported_docking_shape", "direct docking could not be enumerated")


def _validate_no_cycles(edges):
    visiting = set()
    visited = set()

    def visit(path):
        if path in visiting:
            _fail("unsupported_docking_shape", "a direct docking cycle was detected")
        if path in visited:
            return
        visiting.add(path)
        for child in edges.get(path, []):
            visit(child)
        visiting.remove(path)
        visited.add(path)

    for host_path in sorted(edges):
        visit(host_path)


def _docking_claims(td_runtime, root, request, explicit_nodes):
    if not request["include_docked"]:
        return {}, {}
    explicit_paths = set(explicit_nodes)
    claims = {}
    edges = {}
    for host_path in sorted(explicit_nodes):
        edges[host_path] = []
        for child in _direct_docked(explicit_nodes[host_path]):
            child_path = _validate_path(_path(child), "docked path", False)
            resolved = _resolve_target(td_runtime, root, request["root_path"], child_path)
            claims.setdefault(child_path, []).append(host_path)
            edges[host_path].append(child_path)
            nested_paths = [
                _validate_path(_path(nested), "nested docked path", False)
                for nested in _direct_docked(resolved)
            ]
            if any(path not in explicit_paths for path in nested_paths):
                _fail(
                    "unsupported_docking_shape",
                    "nested docked operators must all be explicitly positioned",
                )
    ambiguous = [path for path, hosts in claims.items() if len(set(hosts)) != 1]
    if ambiguous:
        _fail("ambiguous_dock_ownership", "a docked operator has multiple direct hosts")
    _validate_no_cycles(edges)
    return {path: hosts[0] for path, hosts in claims.items()}, edges


def _checked_final(value, path):
    return _validate_coordinate(value, "%s carried coordinate" % path)


def _prepared_nodes(td_runtime, root, request):
    explicit = {}
    requested = {}
    for placement in request["positions"]:
        path = placement["path"]
        explicit[path] = _resolve_target(td_runtime, root, request["root_path"], path)
        requested[path] = [placement["x"], placement["y"]]
    claims, _edges = _docking_claims(td_runtime, root, request, explicit)
    if len(set(explicit) | set(claims)) > _MAX_AFFECTED:
        _fail("invalid_reposition_input", "resolved placement exceeds the affected-node bound")
    prepared = {}
    for path, node in explicit.items():
        before = _position(node, path)
        prepared[path] = {
            "path": path,
            "node": node,
            "identity": _identity(node, path),
            "source": "explicit",
            "host_path": claims.get(path),
            "previous": before,
            "final": requested[path],
        }
    for path, host_path in claims.items():
        if path in prepared:
            continue
        node = _resolve_target(td_runtime, root, request["root_path"], path)
        before = _position(node, path)
        host_before = prepared[host_path]["previous"]
        host_final = prepared[host_path]["final"]
        final = [
            _checked_final(before[0] + host_final[0] - host_before[0], path),
            _checked_final(before[1] + host_final[1] - host_before[1], path),
        ]
        prepared[path] = {
            "path": path,
            "node": node,
            "identity": _identity(node, path),
            "source": "docked_carry",
            "host_path": host_path,
            "previous": before,
            "final": final,
        }
    return [prepared[path] for path in sorted(prepared)]


def _fingerprint(request, root, prepared, editor_context):
    body = {
        "version": 1,
        "root_path": request["root_path"],
        "root_identity": _identity(root, request["root_path"]),
        "target_source": request["target_source"],
        "include_docked": request["include_docked"],
        "requested_paths": [item["path"] for item in request["positions"]],
        "nodes": [
            {
                "path": item["path"],
                "identity": item["identity"],
                "x": item["previous"][0],
                "y": item["previous"][1],
                "host_path": item["host_path"],
            }
            for item in prepared
        ],
        "editor_context": editor_context,
    }
    return _canonical_hash(body)


def _prepare(td_runtime, request):
    root = _resolve_root(td_runtime, request["root_path"])
    requested_paths = [item["path"] for item in request["positions"]]
    editor_context = None
    if request["target_source"] == "active_selection":
        editor_context = _editor_context(td_runtime, request["root_path"], requested_paths)
    prepared = _prepared_nodes(td_runtime, root, request)
    return {
        "root": root,
        "nodes": prepared,
        "editor_context": editor_context,
        "fingerprint": _fingerprint(request, root, prepared, editor_context),
    }


def _public_context(request, prepared):
    return {
        "root_path": request["root_path"],
        "target_source": request["target_source"],
        "include_docked": request["include_docked"],
        "requested_paths": [item["path"] for item in request["positions"]],
        "nodes": [
            dict(
                {
                    "path": item["path"],
                    "position": list(item["previous"]),
                    "source": item["source"],
                },
                **({"host_path": item["host_path"]} if item["host_path"] else {})
            )
            for item in prepared["nodes"]
        ],
        "editor_context": copy.deepcopy(prepared["editor_context"]),
        "fingerprint": prepared["fingerprint"],
    }


def _path_receipt(item):
    receipt = {
        "path": item["path"],
        "source": item["source"],
        "requested": list(item["final"]),
        "previous": list(item["previous"]),
        "final": list(item["final"]),
        "status": "unchanged" if item["previous"] == item["final"] else "applied",
    }
    if item["host_path"]:
        receipt["host_path"] = item["host_path"]
    return receipt


def _overlap_warnings(nodes):
    positions = {}
    for item in nodes:
        positions.setdefault(tuple(item["final"]), []).append(item["path"])
    if any(len(paths) > 1 for paths in positions.values()):
        return ["Explicit placement results include overlapping final coordinates."]
    return []


def _success_receipt(request, prepared, fingerprint_after):
    paths = [_path_receipt(item) for item in prepared["nodes"]]
    applied = sum(item["status"] == "applied" for item in paths)
    report = {
        "mode": "explicit",
        "status": "applied" if applied else "unchanged",
        "idempotency_key": request["idempotency_key"],
        "root_path": request["root_path"],
        "target_source": request["target_source"],
        "fingerprint_before": prepared["fingerprint"],
        "fingerprint_after": fingerprint_after,
        "paths": paths,
        "counts": {
            "explicit": len(request["positions"]),
            "docked_carried": sum(item["source"] == "docked_carry" for item in paths),
            "applied": applied,
            "unchanged": len(paths) - applied,
            "failed": 0,
        },
        "rollback": {"attempted": False, "succeeded": True, "errors": []},
        "warnings": _overlap_warnings(prepared["nodes"]),
    }
    if prepared["editor_context"] is not None:
        report["editor_context"] = copy.deepcopy(prepared["editor_context"])
    return report


def _write_and_readback(item):
    node = item["node"]
    node.nodeX = item["final"][0]
    node.nodeY = item["final"][1]
    if _position(node, item["path"]) != item["final"]:
        raise RuntimeError("placement readback mismatch")


def _verify_final(td_runtime, nodes):
    for item in nodes:
        node = td_runtime.op(item["path"])
        if node is None or _identity(node, item["path"]) != item["identity"]:
            raise RuntimeError("operator identity changed during placement")
        if _position(node, item["path"]) != item["final"]:
            raise RuntimeError("final placement readback mismatch")


def _apply_all(td_runtime, nodes):
    for item in nodes:
        if item["previous"] != item["final"]:
            _write_and_readback(item)
    _verify_final(td_runtime, nodes)


def _transaction_succeeded(td_runtime, nodes):
    try:
        _apply_all(td_runtime, nodes)
        return True
    except Exception:  # noqa: BLE001
        return False


def _restore_one(td_runtime, item):
    path = item["path"]
    node = td_runtime.op(path)
    if node is None or _identity(node, path) != item["identity"]:
        raise RuntimeError("operator identity changed")
    if _position(node, path) != item["previous"]:
        node.nodeX = item["previous"][0]
        node.nodeY = item["previous"][1]
    if _position(node, path) != item["previous"]:
        raise RuntimeError("rollback readback mismatch")


def _restore_result(td_runtime, item):
    try:
        _restore_one(td_runtime, item)
        return True, None
    except Exception:  # noqa: BLE001
        return False, {
            "path": item["path"],
            "message": "Exact position restoration failed.",
        }


def _restore(td_runtime, nodes):
    restored = {}
    errors = []
    for item in reversed(nodes):
        success, error = _restore_result(td_runtime, item)
        restored[item["path"]] = success
        if error is not None and len(errors) < 64:
            errors.append(error)
    return not errors, errors, restored


def _failure_receipt(request, prepared, rollback_ok, rollback_errors, restored, code):
    paths = []
    for item in prepared["nodes"]:
        changed = item["previous"] != item["final"]
        receipt = _path_receipt(item)
        receipt["status"] = "failed" if changed else "unchanged"
        receipt["rollback"] = (
            "not_needed" if not changed else "restored" if restored.get(item["path"]) else "failed"
        )
        paths.append(receipt)
    failed = sum(item["status"] == "failed" for item in paths)
    message = (
        "Explicit placement failed and exact rollback was not confirmed."
        if code == "reposition_rollback_failed"
        else "Explicit placement failed and every affected position was restored."
    )
    return {
        "mode": "explicit",
        "status": "failed",
        "idempotency_key": request["idempotency_key"],
        "root_path": request["root_path"],
        "target_source": request["target_source"],
        "paths": paths,
        "counts": {
            "explicit": len(request["positions"]),
            "docked_carried": sum(item["source"] == "docked_carry" for item in paths),
            "applied": 0,
            "unchanged": len(paths) - failed,
            "failed": failed,
        },
        "rollback": {
            "attempted": True,
            "succeeded": rollback_ok,
            "errors": rollback_errors,
        },
        "error": {"code": code, "message": message},
        "warnings": _overlap_warnings(prepared["nodes"]),
    }


def _state(nodes, use_final):
    coordinate_key = "final" if use_final else "previous"
    return [
        {
            "path": item["path"],
            "identity": item["identity"],
            "position": list(item[coordinate_key]),
        }
        for item in nodes
    ]


class RepositionService:
    """Context/fingerprint CAS plus one-request placement transaction."""

    def __init__(self, td_runtime=None, clock=None):
        self._td_runtime = td_runtime
        self._clock = clock or time.monotonic
        self._receipts = OrderedDict()

    def _td(self):
        if self._td_runtime is not None:
            return self._td_runtime
        import td

        return td

    def context(self, payload):
        request = _validate_context_request(payload)
        return _public_context(request, _prepare(self._td(), request))

    def _prune(self, now):
        expired = [
            key
            for key, value in self._receipts.items()
            if now - value["created_at"] >= _RECEIPT_TTL_SECONDS
        ]
        for key in expired:
            self._receipts.pop(key, None)

    def _live_state_matches(self, td_runtime, state):
        for expected in state:
            node = td_runtime.op(expected["path"])
            if node is None or _identity(node, expected["path"]) != expected["identity"]:
                return False
            if _position(node, expected["path"]) != expected["position"]:
                return False
        return True

    def _lookup(self, td_runtime, request, digest, now):
        self._prune(now)
        receipt = self._receipts.get(request["idempotency_key"])
        if receipt is None:
            return None
        if receipt["digest"] != digest or not self._live_state_matches(td_runtime, receipt["state"]):
            _fail(
                "idempotency_conflict",
                "idempotency key conflicts with the request or observed operator state",
            )
        if receipt["error"] is not None:
            error = receipt["error"]
            _fail(error["code"], error["message"], copy.deepcopy(receipt["report"]))
        report = copy.deepcopy(receipt["report"])
        report["status"] = "replayed"
        return report

    def _store(self, request, digest, report, state, now, error=None):
        while len(self._receipts) >= _MAX_RECEIPTS:
            self._receipts.popitem(last=False)
        self._receipts[request["idempotency_key"]] = {
            "created_at": now,
            "digest": digest,
            "report": copy.deepcopy(report),
            "state": copy.deepcopy(state),
            "error": copy.deepcopy(error),
        }

    def _validate_cas(self, request, prepared):
        if prepared["fingerprint"] != request["fingerprint"]:
            _fail("stale_reposition_context", "operator placement context changed before apply")
        if prepared["editor_context"] != request["editor_context"]:
            _fail("stale_reposition_context", "editor selection context changed before apply")

    def _raise_transaction_failure(
        self, td_runtime, request, prepared, digest, now
    ):
        rollback_ok, rollback_errors, restored = _restore(
            td_runtime, prepared["nodes"]
        )
        code = "reposition_apply_failed" if rollback_ok else "reposition_rollback_failed"
        report = _failure_receipt(
            request, prepared, rollback_ok, rollback_errors, restored, code
        )
        if rollback_ok:
            error = {"code": code, "message": report["error"]["message"]}
            self._store(
                request,
                digest,
                report,
                _state(prepared["nodes"], False),
                now,
                error,
            )
        _fail(code, report["error"]["message"], report)

    def _complete(self, td_runtime, request, prepared, digest, now):
        after = _prepare(td_runtime, request)
        report = _success_receipt(request, prepared, after["fingerprint"])
        self._store(
            request,
            digest,
            report,
            _state(prepared["nodes"], True),
            now,
        )
        return report

    def reposition(self, payload):
        request = _validate_apply_request(payload)
        digest = _canonical_hash(_logical_intent(request))
        now = self._clock()
        td_runtime = self._td()
        replay = self._lookup(td_runtime, request, digest, now)
        if replay is not None:
            return replay
        prepared = _prepare(td_runtime, request)
        self._validate_cas(request, prepared)
        if not _transaction_succeeded(td_runtime, prepared["nodes"]):
            self._raise_transaction_failure(
                td_runtime, request, prepared, digest, now
            )
        return self._complete(td_runtime, request, prepared, digest, now)


_DEFAULT_SERVICE = RepositionService()


def get_reposition_context(payload):
    """Return a bounded scalar placement context and fingerprint."""
    return _DEFAULT_SERVICE.context(payload)


def reposition_operators(payload):
    """Apply one exact structured placement transaction."""
    return _DEFAULT_SERVICE.reposition(payload)
