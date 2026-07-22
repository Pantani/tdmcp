"""Process-local composition root for authenticated structured operations.

The service owns one random bridge-instance identity, preview signing key and
bounded receipt store for the lifetime of this imported module.  It retains no
bearer token: the controller supplies the already-authenticated principal for
each call and :class:`OperationPlanService` immediately HMAC-binds it.
"""

import copy
import secrets
import threading

from .operation_plan_service import (
    OperationMutationGate,
    OperationPlanError,
    OperationPlanService,
    OperationRecordStore,
)
from .operation_revert_service import OperationRevertService
from .operation_td_adapter import TouchDesignerOperationAdapter


_SERVICE = None
_REVERT_SERVICE = None
_SERVICE_LOCK = threading.RLock()


def _service():
    global _REVERT_SERVICE, _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            adapter = TouchDesignerOperationAdapter()
            secret = secrets.token_bytes(32)
            bridge_instance_id = secrets.token_urlsafe(18)
            records = OperationRecordStore()
            gate = OperationMutationGate()
            _SERVICE = OperationPlanService(
                adapter,
                adapter,
                secret=secret,
                bridge_instance_id=bridge_instance_id,
                receipt_store=records,
                mutation_gate=gate,
            )
            _REVERT_SERVICE = OperationRevertService(
                adapter,
                records,
                gate,
                secret,
                bridge_instance_id,
            )
        return _SERVICE


def _revert_service():
    _service()
    return _REVERT_SERVICE


def reset_for_tests():
    """Drop process-local capabilities. Tests only; a reset invalidates them."""

    global _REVERT_SERVICE, _SERVICE
    with _SERVICE_LOCK:
        _SERVICE = None
        _REVERT_SERVICE = None


def preview(payload, principal):
    return _service().preview(payload, principal)


def commit(payload, principal):
    return _service().commit(payload, principal)


def _receipt_request(payload):
    if type(payload) is not dict or set(payload) != {
        "schema_version",
        "operation_id",
        "receipt_capability",
    }:
        raise OperationPlanError(
            "invalid_operation_plan",
            "operation receipt request must contain only its schema and authority fields",
        )
    if payload["schema_version"] != 1:
        raise OperationPlanError(
            "invalid_operation_plan",
            "operation receipt schema version is unsupported",
        )
    return payload["operation_id"], payload["receipt_capability"]


def _unavailable_observation(reason):
    return {
        "available": False,
        "state": "unknown",
        "verification": "UNVERIFIED",
        "snapshot": "unknown",
        "reason": reason,
    }


def _live_observation(service, receipt, private_record):
    journal = receipt.get("journal")
    if receipt.get("status") not in ("applied", "replayed"):
        return _unavailable_observation("not_applicable")
    if (
        type(journal) is not dict
        or journal.get("registered") is not True
        or journal.get("operation_id") != receipt.get("operation_id")
    ):
        return _unavailable_observation("journal_unavailable")
    adapter = service._transaction_adapter
    private_journal = private_record.get("private_journal")
    observer = getattr(adapter, "observe_journal", None)
    if private_journal is None:
        return _unavailable_observation("journal_unavailable")
    if not callable(observer):
        return _unavailable_observation("journal_unavailable")
    try:
        state = observer(private_journal)
    except Exception:  # noqa: BLE001 - observation never leaks project/runtime text.
        state = "unknown"
    if state in ("applied", "redone"):
        return {
            "available": True,
            "state": state,
            "verification": "PASS",
            "snapshot": "after",
        }
    if state == "undone":
        return {
            "available": True,
            "state": "undone",
            "verification": "PASS",
            "snapshot": "before",
        }
    if state == "drifted":
        return {
            "available": True,
            "state": "drifted",
            "verification": "FAIL",
            "snapshot": "unknown",
        }
    return _unavailable_observation("journal_unavailable")


def receipt(payload, principal):
    operation_id, capability = _receipt_request(payload)
    service = _service()
    private_record = service.get_private_operation_record(
        operation_id,
        capability,
        principal,
    )
    terminal = private_record["receipt"]
    return {
        "status": "receipt",
        "receipt": copy.deepcopy(terminal),
        "observation": _live_observation(service, terminal, private_record),
    }


__all__ = ("commit", "preview", "receipt", "reset_for_tests")
