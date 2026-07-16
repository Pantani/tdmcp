"""Bounded, fail-closed broker for native TouchDesigner decisions.

The broker is deliberately transport- and UI-agnostic.  The REST controller can
enqueue a request and return immediately; an injected scheduler presents the next
request to an injected, non-modal inbox adapter.  Neither callback receives the
target fingerprint or dedupe token, and this module never logs prompt content.

The allowlisted interaction kinds are deliberately narrow:

* ``delete_node`` with ``Delete / Bypass / Keep``;
* ``save_overwrite`` with ``Overwrite / Keep``.
* ``artifact_overwrite`` with ``Overwrite / Keep``.
* ``oauth_client_consent`` with ``Allow / Deny``.
* ``visual_parameter_apply`` with ``Apply / Keep``.

Every non-user terminal path resolves to the kind's safe choice (``Keep`` or
``Deny``).  No code, endpoint, callable,
or arbitrary action is accepted as request data, so this service cannot become an
execution side channel and remains independent of ``TDMCP_BRIDGE_ALLOW_EXEC``.
"""

import hashlib
import math
import re
import secrets
import threading
import time


PENDING = "pending"
RESOLVED = "resolved"
EXPIRED = "expired"
CANCELLED = "cancelled"
FAILED = "failed"
TERMINAL_STATES = frozenset((RESOLVED, EXPIRED, CANCELLED, FAILED))

DEFAULT_TTL_SECONDS = 30.0
MIN_TTL_SECONDS = 5.0
MAX_TTL_SECONDS = 120.0
DEFAULT_PENDING_CAP = 3
DEFAULT_RECORD_CAP = 128
DEFAULT_TERMINAL_RETENTION_SECONDS = 300.0

MAX_TITLE_LENGTH = 120
MAX_PROMPT_LENGTH = 512
MAX_DEDUPE_KEY_LENGTH = 128
MAX_FINGERPRINT_LENGTH = 128

INTERACTION_CHOICES = {
    "delete_node": ("Delete", "Bypass", "Keep"),
    "save_overwrite": ("Overwrite", "Keep"),
    "artifact_overwrite": ("Overwrite", "Keep"),
    "oauth_client_consent": ("Allow", "Deny"),
    "visual_parameter_apply": ("Apply", "Keep"),
}
SAFE_CHOICE = {
    kind: ("Deny" if kind == "oauth_client_consent" else "Keep")
    for kind in INTERACTION_CHOICES
}
CANCEL_REASONS = frozenset(("cancelled", "closed", "client_cancelled"))
FAIL_REASONS = frozenset(
    ("ui_unavailable", "headless", "inbox_error", "scheduling_error")
)

_FINGERPRINT_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


class InteractionValidationError(ValueError):
    """The request is outside the broker's allowlisted, bounded contract."""


class InteractionNotFoundError(LookupError):
    """The opaque request id does not identify a retained interaction."""


class InteractionCapacityError(RuntimeError):
    """The global pending-request cap has been reached."""


class InteractionConflictError(RuntimeError):
    """A dedupe token was reused for a different target or interaction kind."""


def fingerprint_target(*parts):
    """Return a stable opaque fingerprint without retaining raw target content."""
    if not parts:
        raise InteractionValidationError(
            "fingerprint requires at least one target part"
        )
    digest = hashlib.sha256()
    for part in parts:
        value = str(part).encode("utf-8")
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    return digest.hexdigest()


def _bounded_text(value, field, maximum, allow_empty=False):
    if not isinstance(value, str):
        raise InteractionValidationError("%s must be a string" % field)
    text = value.strip()
    if not text and not allow_empty:
        raise InteractionValidationError("%s must not be empty" % field)
    if len(text) > maximum:
        raise InteractionValidationError("%s exceeds %d characters" % (field, maximum))
    return text


def _validated_fingerprint(value):
    text = _bounded_text(value, "target_fingerprint", MAX_FINGERPRINT_LENGTH)
    if not _FINGERPRINT_RE.fullmatch(text):
        raise InteractionValidationError(
            "target_fingerprint must be an opaque 32-128 character token",
        )
    return text


def _validated_ttl(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InteractionValidationError("ttl_seconds must be a number")
    ttl = float(value)
    if not math.isfinite(ttl) or ttl < MIN_TTL_SECONDS or ttl > MAX_TTL_SECONDS:
        raise InteractionValidationError(
            "ttl_seconds must be between %s and %s"
            % (int(MIN_TTL_SECONDS), int(MAX_TTL_SECONDS)),
        )
    return ttl


def _validated_choices(kind, choices):
    if kind not in INTERACTION_CHOICES:
        raise InteractionValidationError("unsupported interaction kind")
    if not isinstance(choices, (list, tuple)):
        raise InteractionValidationError("choices must be an ordered list")
    normalized = tuple(choices)
    expected = INTERACTION_CHOICES[kind]
    if normalized != expected:
        raise InteractionValidationError(
            "%s choices must be exactly: %s" % (kind, ", ".join(expected)),
        )
    return expected


def _dedupe_token(key):
    if key is None:
        return None
    text = _bounded_text(key, "dedupe_key", MAX_DEDUPE_KEY_LENGTH)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class InteractionBroker:
    """In-memory, exactly-once decision broker with bounded queue and retention.

    ``scheduler`` receives a zero-argument callable and must arrange for it to run
    later (the bridge uses the following TD frame). ``inbox_adapter`` receives a
    display-only dictionary and should show/update the non-modal native inbox.  A
    missing callback, callback exception, or explicit ``False`` return fails the
    affected request closed.
    """

    def __init__(
        self,
        scheduler=None,
        inbox_adapter=None,
        clear_adapter=None,
        clock=None,
        pending_cap=DEFAULT_PENDING_CAP,
        record_cap=DEFAULT_RECORD_CAP,
        terminal_retention_seconds=DEFAULT_TERMINAL_RETENTION_SECONDS,
        id_factory=None,
    ):
        if (
            isinstance(pending_cap, bool)
            or not isinstance(pending_cap, int)
            or pending_cap < 1
        ):
            raise InteractionValidationError("pending_cap must be a positive integer")
        if (
            isinstance(record_cap, bool)
            or not isinstance(record_cap, int)
            or record_cap < pending_cap
        ):
            raise InteractionValidationError(
                "record_cap must be an integer >= pending_cap"
            )
        if terminal_retention_seconds < 0:
            raise InteractionValidationError(
                "terminal_retention_seconds must be non-negative"
            )
        self._scheduler = scheduler
        self._inbox_adapter = inbox_adapter
        self._clear_adapter = clear_adapter
        self._clock = clock or time.monotonic
        self._pending_cap = pending_cap
        self._record_cap = record_cap
        self._terminal_retention_seconds = float(terminal_retention_seconds)
        self._id_factory = id_factory or (lambda: secrets.token_urlsafe(24))
        self._records = {}
        self._dedupe = {}
        self._active_request_id = None
        self._next_sequence = 0
        self._lock = threading.RLock()

    def configure_delivery(self, scheduler, inbox_adapter, clear_adapter=None):
        """Replace the delivery hooks and attempt to present the oldest request."""
        with self._lock:
            self._scheduler = scheduler
            self._inbox_adapter = inbox_adapter
            self._clear_adapter = clear_adapter
            self._prune_locked()
            self._schedule_next_locked()

    def create(
        self,
        *,
        kind,
        choices,
        title,
        prompt,
        target_fingerprint,
        ttl_seconds=DEFAULT_TTL_SECONDS,
        dedupe_key=None,
    ):
        """Validate, deduplicate, enqueue and schedule a native decision request."""
        expected_choices = _validated_choices(kind, choices)
        clean_title = _bounded_text(title, "title", MAX_TITLE_LENGTH)
        clean_prompt = _bounded_text(prompt, "prompt", MAX_PROMPT_LENGTH)
        fingerprint = _validated_fingerprint(target_fingerprint)
        ttl = _validated_ttl(ttl_seconds)
        token = _dedupe_token(dedupe_key)

        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            duplicate = self._deduplicated_locked(
                token, kind, expected_choices, fingerprint
            )
            if duplicate is not None:
                return self._response(duplicate, deduplicated=True)
            if self._pending_count_locked() >= self._pending_cap:
                raise InteractionCapacityError("interaction pending limit reached")
            self._make_room_locked()
            request_id = self._new_request_id_locked()
            record = {
                "request_id": request_id,
                "kind": kind,
                "choices": expected_choices,
                "title": clean_title,
                "prompt": clean_prompt,
                "target_fingerprint": fingerprint,
                "dedupe_token": token,
                "state": PENDING,
                "created_at": now,
                "expires_at": now + ttl,
                "terminal_at": None,
                "result": None,
                "consumed_at": None,
                "sequence": self._next_sequence,
            }
            self._next_sequence += 1
            self._records[request_id] = record
            if token is not None:
                self._dedupe[token] = request_id
            self._schedule_next_locked()
            return self._response(record, deduplicated=False)

    def get(self, request_id):
        """Return a content-free status snapshot, expiring TTLs first."""
        clean_id = self._validated_request_id(request_id)
        with self._lock:
            self._prune_locked()
            return self._response(self._require_locked(clean_id))

    def snapshot(self):
        """Return bounded broker readiness without exposing request content."""
        with self._lock:
            self._prune_locked()
            active = self._records.get(self._active_request_id)
            return {
                "pending_count": self._pending_count_locked(),
                "pending_limit": self._pending_cap,
                "active": active is not None and active["state"] == PENDING,
                "delivery_configured": (
                    self._scheduler is not None and self._inbox_adapter is not None
                ),
            }

    def resolve(self, request_id, choice):
        """Resolve a pending request once; duplicate/late attempts are rejected."""
        clean_id = self._validated_request_id(request_id)
        if not isinstance(choice, str):
            raise InteractionValidationError("choice must be a string")
        with self._lock:
            self._prune_locked()
            record = self._require_locked(clean_id)
            if choice not in record["choices"]:
                raise InteractionValidationError(
                    "choice is not allowed for this interaction"
                )
            if record["state"] != PENDING:
                return self._response(record, accepted=False)
            self._transition_locked(record, RESOLVED, choice, "user_choice")
            return self._response(record, accepted=True)

    def cancel(self, request_id, reason="cancelled"):
        """Cancel/close a request exactly once and choose its safe decision."""
        if reason not in CANCEL_REASONS:
            raise InteractionValidationError("unsupported cancellation reason")
        return self._terminal_request(request_id, CANCELLED, reason)

    def fail(self, request_id, reason="ui_unavailable"):
        """Fail a request exactly once and choose its safe decision."""
        if reason not in FAIL_REASONS:
            raise InteractionValidationError("unsupported failure reason")
        return self._terminal_request(request_id, FAILED, reason)

    def disconnect(self):
        """Fail every pending interaction closed after loss of the UI surface."""
        with self._lock:
            self._prune_locked()
            changed = []
            for record in list(self._records.values()):
                if record["state"] == PENDING:
                    self._transition_locked(
                        record,
                        FAILED,
                        SAFE_CHOICE[record["kind"]],
                        "disconnect",
                        schedule_next=False,
                    )
                    changed.append(self._response(record, accepted=True))
            self._active_request_id = None
            return changed

    def consume(self, request_id, target_fingerprint):
        """Consume one terminal result once when the target fingerprint matches."""
        clean_id = self._validated_request_id(request_id)
        fingerprint = _validated_fingerprint(target_fingerprint)
        with self._lock:
            self._prune_locked()
            record = self._require_locked(clean_id)
            if record["state"] == PENDING:
                return self._consume_response(record, False, "pending")
            if not secrets.compare_digest(record["target_fingerprint"], fingerprint):
                return self._consume_response(record, False, "fingerprint_mismatch")
            if record["consumed_at"] is not None:
                return self._consume_response(record, False, "already_consumed")
            record["consumed_at"] = self._clock()
            return self._consume_response(record, True, None)

    def clear(self):
        """Clear in-memory state. Intended for bridge teardown and focused tests."""
        with self._lock:
            self._records.clear()
            self._dedupe.clear()
            self._active_request_id = None
            self._next_sequence = 0

    def _terminal_request(self, request_id, state, reason):
        clean_id = self._validated_request_id(request_id)
        clean_reason = _bounded_text(reason, "reason", 64)
        with self._lock:
            self._prune_locked()
            record = self._require_locked(clean_id)
            if record["state"] != PENDING:
                return self._response(record, accepted=False)
            self._transition_locked(
                record,
                state,
                SAFE_CHOICE[record["kind"]],
                clean_reason,
            )
            return self._response(record, accepted=True)

    def _transition_locked(
        self,
        record,
        state,
        choice,
        reason,
        schedule_next=True,
        terminal_at=None,
    ):
        if record["state"] != PENDING:
            return False
        when = self._clock() if terminal_at is None else terminal_at
        record["state"] = state
        record["terminal_at"] = when
        record["result"] = {"choice": choice, "reason": reason, "at": when}
        record["title"] = ""
        record["prompt"] = ""
        was_active = self._active_request_id == record["request_id"]
        if was_active:
            self._active_request_id = None
            self._schedule_clear_locked(record["request_id"])
        if schedule_next:
            self._schedule_next_locked()
        return True

    def _schedule_clear_locked(self, request_id):
        if self._scheduler is None or self._clear_adapter is None:
            return
        try:
            self._scheduler(
                lambda request_id=request_id: self._clear_adapter(request_id)
            )
        except Exception:  # noqa: BLE001 - cleanup failure cannot reopen a decision
            pass

    def _prune_locked(self, now=None):
        current = self._clock() if now is None else now
        expired_active = self._expire_pending_locked(current)
        self._drop_stale_terminal_locked(current)
        if expired_active or self._active_request_id is None:
            self._schedule_next_locked()

    def _expire_pending_locked(self, current):
        expired_active = False
        for record in list(self._records.values()):
            if record["state"] != PENDING or current < record["expires_at"]:
                continue
            expired_active = (
                expired_active or self._active_request_id == record["request_id"]
            )
            self._transition_locked(
                record,
                EXPIRED,
                SAFE_CHOICE[record["kind"]],
                "timeout",
                schedule_next=False,
                terminal_at=current,
            )
        return expired_active

    def _drop_stale_terminal_locked(self, now):
        stale = []
        for request_id, record in self._records.items():
            terminal_at = record["terminal_at"]
            if terminal_at is None:
                continue
            if now - terminal_at >= self._terminal_retention_seconds:
                stale.append(request_id)
        for request_id in stale:
            self._drop_record_locked(request_id)

    def _make_room_locked(self):
        while len(self._records) >= self._record_cap:
            terminal = [
                record
                for record in self._records.values()
                if record["state"] in TERMINAL_STATES
            ]
            if not terminal:
                raise InteractionCapacityError("interaction record limit reached")
            terminal.sort(
                key=lambda item: (
                    item["consumed_at"] is None,
                    item["terminal_at"],
                    item["created_at"],
                ),
            )
            self._drop_record_locked(terminal[0]["request_id"])

    def _drop_record_locked(self, request_id):
        record = self._records.pop(request_id, None)
        if record is None:
            return
        token = record["dedupe_token"]
        if token is not None and self._dedupe.get(token) == request_id:
            self._dedupe.pop(token, None)

    def _deduplicated_locked(self, token, kind, choices, fingerprint):
        if token is None:
            return None
        request_id = self._dedupe.get(token)
        if request_id is None:
            return None
        record = self._records.get(request_id)
        if record is None:
            self._dedupe.pop(token, None)
            return None
        if (
            record["kind"] != kind
            or record["choices"] != choices
            or not secrets.compare_digest(record["target_fingerprint"], fingerprint)
        ):
            raise InteractionConflictError(
                "dedupe key conflicts with an existing interaction"
            )
        return record

    def _new_request_id_locked(self):
        for _attempt in range(8):
            request_id = self._id_factory()
            if not isinstance(request_id, str) or len(request_id) < 16:
                raise InteractionValidationError(
                    "id_factory must return an opaque string"
                )
            if request_id not in self._records:
                return request_id
        raise InteractionCapacityError("could not allocate a unique interaction id")

    def _schedule_next_locked(self):
        active = self._records.get(self._active_request_id)
        if active is not None and active["state"] == PENDING:
            return
        self._active_request_id = None
        while True:
            pending = [
                record
                for record in self._records.values()
                if record["state"] == PENDING
            ]
            if not pending:
                return
            pending.sort(key=lambda item: item["sequence"])
            record = pending[0]
            self._active_request_id = record["request_id"]
            if self._scheduler is None or self._inbox_adapter is None:
                self._transition_locked(
                    record,
                    FAILED,
                    SAFE_CHOICE[record["kind"]],
                    "ui_unavailable",
                    schedule_next=False,
                )
                continue
            try:
                self._scheduler(
                    lambda request_id=record["request_id"]: self._present(request_id),
                )
                return
            except Exception:  # noqa: BLE001 - a scheduler error must fail closed
                self._transition_locked(
                    record,
                    FAILED,
                    SAFE_CHOICE[record["kind"]],
                    "scheduling_error",
                    schedule_next=False,
                )

    def _present(self, request_id):
        with self._lock:
            self._prune_locked()
            record = self._records.get(request_id)
            if record is None or record["state"] != PENDING:
                return False
            if self._active_request_id != request_id:
                return False
            payload = {
                "request_id": record["request_id"],
                "kind": record["kind"],
                "title": record["title"],
                "prompt": record["prompt"],
                "choices": list(record["choices"]),
                "default_choice": SAFE_CHOICE[record["kind"]],
                "expires_at": record["expires_at"],
            }
            adapter = self._inbox_adapter
        try:
            available = adapter(payload)
        except Exception:  # noqa: BLE001 - UI callback failures are terminal and safe
            self.fail(request_id, "inbox_error")
            return False
        if available is False:
            self.fail(request_id, "ui_unavailable")
            return False
        return True

    def _pending_count_locked(self):
        return sum(1 for record in self._records.values() if record["state"] == PENDING)

    def _require_locked(self, request_id):
        record = self._records.get(request_id)
        if record is None:
            raise InteractionNotFoundError("interaction not found")
        return record

    @staticmethod
    def _validated_request_id(request_id):
        return _bounded_text(request_id, "request_id", 128)

    @staticmethod
    def _response(record, accepted=None, deduplicated=None):
        result = record["result"]
        response = {
            "request_id": record["request_id"],
            "kind": record["kind"],
            "state": record["state"],
            "choices": list(record["choices"]),
            "created_at": record["created_at"],
            "expires_at": record["expires_at"],
            "consumed": record["consumed_at"] is not None,
            "result": None if result is None else dict(result),
        }
        if accepted is not None:
            response["accepted"] = accepted
        if deduplicated is not None:
            response["deduplicated"] = deduplicated
        return response

    @staticmethod
    def _consume_response(record, accepted, error):
        result = record["result"]
        response = {
            "request_id": record["request_id"],
            "kind": record["kind"],
            "state": record["state"],
            "accepted": accepted,
            "decision": None if result is None else result["choice"],
        }
        if error is not None:
            response["error"] = error
        return response


_DEFAULT_BROKER = InteractionBroker()


def configure_delivery(scheduler, inbox_adapter, clear_adapter=None):
    return _DEFAULT_BROKER.configure_delivery(scheduler, inbox_adapter, clear_adapter)


def create_interaction(**kwargs):
    return _DEFAULT_BROKER.create(**kwargs)


def get_interaction(request_id):
    return _DEFAULT_BROKER.get(request_id)


def interaction_summary():
    return _DEFAULT_BROKER.snapshot()


def resolve_interaction(request_id, choice):
    return _DEFAULT_BROKER.resolve(request_id, choice)


def cancel_interaction(request_id, reason="cancelled"):
    return _DEFAULT_BROKER.cancel(request_id, reason)


def fail_interaction(request_id, reason="ui_unavailable"):
    return _DEFAULT_BROKER.fail(request_id, reason)


def consume_interaction(request_id, target_fingerprint):
    return _DEFAULT_BROKER.consume(request_id, target_fingerprint)


def disconnect_interactions():
    return _DEFAULT_BROKER.disconnect()
