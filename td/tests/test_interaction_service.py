"""Offline tests for the TD-native interaction broker.

These tests use only stdlib fakes.  The fake scheduler retains callbacks so the
HTTP enqueue path and the following-frame inbox presentation remain separate.
No TouchDesigner UI or ``/api/exec`` surface is required.
"""

import os
import re
import sys
import threading
import types
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = sys.modules.setdefault("td", types.ModuleType("td"))
for _name in ("op", "app", "project"):
    if not hasattr(_td_stub, _name):
        setattr(_td_stub, _name, mock.MagicMock(name=_name))

from mcp.services import interaction_service as interaction  # noqa: E402


DELETE_CHOICES = ["Delete", "Bypass", "Keep"]
SAVE_CHOICES = ["Overwrite", "Keep"]
OAUTH_CHOICES = ["Allow", "Deny"]


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class DeferredScheduler:
    def __init__(self):
        self.callbacks = []

    def __call__(self, callback):
        self.callbacks.append(callback)

    def run_next(self):
        callback = self.callbacks.pop(0)
        return callback()


class Inbox:
    def __init__(self, available=True, error=None):
        self.available = available
        self.error = error
        self.payloads = []

    def __call__(self, payload):
        self.payloads.append(payload)
        if self.error is not None:
            raise self.error
        return self.available


class ClearInbox:
    def __init__(self):
        self.request_ids = []

    def __call__(self, request_id):
        self.request_ids.append(request_id)
        return True


class RaisingScheduler:
    def __call__(self, _callback):
        raise RuntimeError("scheduler unavailable")


class BrokerTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.scheduler = DeferredScheduler()
        self.inbox = Inbox()
        self.broker = interaction.InteractionBroker(
            scheduler=self.scheduler,
            inbox_adapter=self.inbox,
            clock=self.clock,
        )
        self.fingerprint = interaction.fingerprint_target(
            "/project1/moviefilein1",
            "moviefileinTOP",
            "moviefilein1",
        )

    def create_delete(self, **overrides):
        values = {
            "kind": "delete_node",
            "choices": DELETE_CHOICES,
            "title": "Delete operator?",
            "prompt": "Choose what should happen to the selected operator.",
            "target_fingerprint": self.fingerprint,
            "ttl_seconds": 30,
            "dedupe_key": None,
        }
        values.update(overrides)
        return self.broker.create(**values)

    def create_save(self, **overrides):
        values = {
            "kind": "save_overwrite",
            "choices": SAVE_CHOICES,
            "title": "Overwrite project?",
            "prompt": "The target exists. Choose Overwrite or Keep.",
            "target_fingerprint": interaction.fingerprint_target("/tmp/show.toe"),
            "ttl_seconds": 30,
            "dedupe_key": None,
        }
        values.update(overrides)
        return self.broker.create(**values)

    def create_artifact_overwrite(self, **overrides):
        values = {
            "kind": "artifact_overwrite",
            "choices": SAVE_CHOICES,
            "title": "Overwrite component?",
            "prompt": "The target exists. Choose Overwrite or Keep.",
            "target_fingerprint": interaction.fingerprint_target("/tmp/widget.tox"),
            "ttl_seconds": 30,
            "dedupe_key": None,
        }
        values.update(overrides)
        return self.broker.create(**values)

    def create_oauth(self, **overrides):
        values = {
            "kind": "oauth_client_consent",
            "choices": OAUTH_CHOICES,
            "title": "Allow OAuth client?",
            "prompt": "Allow this bounded client connection?",
            "target_fingerprint": interaction.fingerprint_target("oauth", "client"),
            "ttl_seconds": 30,
            "dedupe_key": None,
        }
        values.update(overrides)
        return self.broker.create(**values)


class ValidationTests(BrokerTestCase):
    def test_only_allowlisted_kinds_are_accepted(self):
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_delete(kind="panic", choices=["Run", "Keep"])

    def test_delete_choices_must_be_exact_and_ordered(self):
        for choices in (
            ["Delete", "Keep"],
            ["Keep", "Bypass", "Delete"],
            ["Delete", "Bypass", "Keep", "Force"],
        ):
            with self.subTest(choices=choices):
                with self.assertRaises(interaction.InteractionValidationError):
                    self.create_delete(choices=choices)

    def test_save_choices_must_be_exact(self):
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_save(choices=["Overwrite", "Cancel"])

    def test_artifact_overwrite_is_allowlisted_with_exact_safe_choices(self):
        created = self.create_artifact_overwrite()
        self.assertEqual(created["kind"], "artifact_overwrite")
        self.assertEqual(created["choices"], SAVE_CHOICES)
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_artifact_overwrite(choices=["Overwrite"])

    def test_oauth_consent_is_allowlisted_with_exact_allow_deny(self):
        created = self.create_oauth()
        self.assertEqual(created["kind"], "oauth_client_consent")
        self.assertEqual(created["choices"], OAUTH_CHOICES)
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_oauth(choices=["Allow", "Keep"])

    def test_ttl_is_bounded_and_finite(self):
        for ttl in (4.99, 120.01, True, "30", float("nan"), float("inf")):
            with self.subTest(ttl=ttl):
                with self.assertRaises(interaction.InteractionValidationError):
                    self.create_delete(ttl_seconds=ttl)
        minimum = self.create_delete(ttl_seconds=5)
        self.assertEqual(minimum["state"], interaction.PENDING)
        self.broker.resolve(minimum["request_id"], "Keep")
        self.assertEqual(
            self.create_save(ttl_seconds=120)["state"], interaction.PENDING
        )

    def test_display_and_dedupe_fields_are_bounded(self):
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_delete(title="x" * (interaction.MAX_TITLE_LENGTH + 1))
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_delete(prompt="x" * (interaction.MAX_PROMPT_LENGTH + 1))
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_delete(dedupe_key="x" * (interaction.MAX_DEDUPE_KEY_LENGTH + 1))

    def test_target_must_be_an_opaque_fingerprint(self):
        with self.assertRaises(interaction.InteractionValidationError):
            self.create_delete(target_fingerprint="/project1/secret_operator")
        fingerprint = interaction.fingerprint_target("path", "type", "name")
        self.assertRegex(fingerprint, r"^[a-f0-9]{64}$")

    def test_invalid_terminal_reasons_are_rejected(self):
        request_id = self.create_delete()["request_id"]
        with self.assertRaises(interaction.InteractionValidationError):
            self.broker.cancel(request_id, "Bearer secret")
        with self.assertRaises(interaction.InteractionValidationError):
            self.broker.fail(request_id, "raw exception text")


class RequestPrivacyAndDeliveryTests(BrokerTestCase):
    def test_generated_id_is_opaque_and_public_status_excludes_content(self):
        secret_prompt = "Delete operator containing token=top-secret"
        created = self.create_delete(
            prompt=secret_prompt, dedupe_key="retry/top-secret"
        )
        request_id = created["request_id"]
        self.assertRegex(request_id, re.compile(r"^[A-Za-z0-9_-]{24,}$"))
        self.assertNotIn("moviefilein1", request_id)
        public_text = repr(created)
        self.assertNotIn(secret_prompt, public_text)
        self.assertNotIn(self.fingerprint, public_text)
        self.assertNotIn("retry/top-secret", public_text)
        self.assertNotIn("title", created)
        self.assertNotIn("prompt", created)

    def test_inbox_payload_contains_only_display_contract(self):
        self.create_delete(dedupe_key="delete-once")
        self.assertEqual(len(self.scheduler.callbacks), 1)
        self.assertTrue(self.scheduler.run_next())
        payload = self.inbox.payloads[0]
        self.assertEqual(
            set(payload),
            {
                "request_id",
                "kind",
                "title",
                "prompt",
                "choices",
                "default_choice",
                "expires_at",
            },
        )
        self.assertEqual(payload["default_choice"], "Keep")
        self.assertNotIn(self.fingerprint, repr(payload))
        self.assertNotIn("delete-once", repr(payload))

    def test_oauth_close_timeout_disconnect_and_ui_failure_all_deny(self):
        closed = self.create_oauth()
        self.assertEqual(
            self.broker.cancel(closed["request_id"], "closed")["result"]["choice"],
            "Deny",
        )

        expired = self.create_oauth(
            target_fingerprint=interaction.fingerprint_target("oauth", "expired")
        )
        self.clock.advance(31)
        self.assertEqual(self.broker.get(expired["request_id"])["result"]["choice"], "Deny")

        self.create_oauth(
            target_fingerprint=interaction.fingerprint_target("oauth", "disconnect")
        )
        self.assertEqual(self.broker.disconnect()[0]["result"]["choice"], "Deny")

        unavailable = interaction.InteractionBroker(clock=self.clock)
        failed = unavailable.create(
            kind="oauth_client_consent",
            choices=OAUTH_CHOICES,
            title="Allow OAuth client?",
            prompt="Allow this bounded client connection?",
            target_fingerprint=interaction.fingerprint_target("oauth", "unavailable"),
            ttl_seconds=30,
        )
        self.assertEqual(failed["state"], interaction.FAILED)
        self.assertEqual(failed["result"]["choice"], "Deny")

    def test_only_one_request_is_scheduled_at_a_time_fifo(self):
        first = self.create_delete(title="first")
        second = self.create_save(title="second")
        third = self.create_delete(
            title="third",
            target_fingerprint=interaction.fingerprint_target("third"),
        )
        self.assertEqual(len(self.scheduler.callbacks), 1)
        self.scheduler.run_next()
        self.assertEqual([item["title"] for item in self.inbox.payloads], ["first"])
        self.broker.resolve(first["request_id"], "Keep")
        self.assertEqual(len(self.scheduler.callbacks), 1)
        self.scheduler.run_next()
        self.assertEqual(
            [item["title"] for item in self.inbox.payloads], ["first", "second"]
        )
        self.broker.resolve(second["request_id"], "Keep")
        self.scheduler.run_next()
        self.assertEqual(
            [item["title"] for item in self.inbox.payloads],
            ["first", "second", "third"],
        )
        self.assertEqual(
            self.broker.get(third["request_id"])["state"], interaction.PENDING
        )

    def test_missing_ui_fails_immediately_to_keep(self):
        broker = interaction.InteractionBroker(clock=self.clock)
        created = broker.create(
            kind="delete_node",
            choices=DELETE_CHOICES,
            title="Delete?",
            prompt="Delete target?",
            target_fingerprint=self.fingerprint,
        )
        self.assertEqual(created["state"], interaction.FAILED)
        self.assertEqual(created["result"]["choice"], "Keep")
        self.assertEqual(created["result"]["reason"], "ui_unavailable")

    def test_explicit_headless_failure_is_failed_keep(self):
        request_id = self.create_delete()["request_id"]
        failed = self.broker.fail(request_id, "headless")
        self.assertTrue(failed["accepted"])
        self.assertEqual(failed["state"], interaction.FAILED)
        self.assertEqual(failed["result"]["choice"], "Keep")
        self.assertEqual(failed["result"]["reason"], "headless")

    def test_scheduler_exception_fails_closed(self):
        broker = interaction.InteractionBroker(
            scheduler=RaisingScheduler(),
            inbox_adapter=self.inbox,
            clock=self.clock,
        )
        created = broker.create(
            kind="save_overwrite",
            choices=SAVE_CHOICES,
            title="Overwrite?",
            prompt="Overwrite target?",
            target_fingerprint=interaction.fingerprint_target("save"),
        )
        self.assertEqual(created["state"], interaction.FAILED)
        self.assertEqual(created["result"]["choice"], "Keep")
        self.assertEqual(created["result"]["reason"], "scheduling_error")

    def test_inbox_false_or_exception_fails_closed(self):
        for inbox, reason in (
            (Inbox(available=False), "ui_unavailable"),
            (Inbox(error=RuntimeError("TD UI unavailable")), "inbox_error"),
        ):
            with self.subTest(reason=reason):
                scheduler = DeferredScheduler()
                broker = interaction.InteractionBroker(
                    scheduler=scheduler,
                    inbox_adapter=inbox,
                    clock=self.clock,
                )
                created = broker.create(
                    kind="delete_node",
                    choices=DELETE_CHOICES,
                    title="Delete?",
                    prompt="Delete target?",
                    target_fingerprint=self.fingerprint,
                )
                self.assertFalse(scheduler.run_next())
                status = broker.get(created["request_id"])
                self.assertEqual(status["state"], interaction.FAILED)
                self.assertEqual(status["result"]["choice"], "Keep")
                self.assertEqual(status["result"]["reason"], reason)


class StateTransitionTests(BrokerTestCase):
    def test_terminal_transition_schedules_native_inbox_cleanup(self):
        clear = ClearInbox()
        broker = interaction.InteractionBroker(
            scheduler=self.scheduler,
            inbox_adapter=self.inbox,
            clear_adapter=clear,
            clock=self.clock,
        )
        created = broker.create(
            kind="delete_node",
            choices=DELETE_CHOICES,
            title="Sensitive project node",
            prompt="/show/private/project1/secret",
            target_fingerprint=self.fingerprint,
        )
        self.scheduler.run_next()  # presentation
        broker.resolve(created["request_id"], "Keep")
        self.assertEqual(len(self.scheduler.callbacks), 1)
        self.scheduler.run_next()
        self.assertEqual(clear.request_ids, [created["request_id"]])
        retained = broker._records[created["request_id"]]
        self.assertEqual(retained["title"], "")
        self.assertEqual(retained["prompt"], "")

    def test_timeout_and_disconnect_also_schedule_cleanup(self):
        for terminal in ("timeout", "disconnect"):
            with self.subTest(terminal=terminal):
                scheduler = DeferredScheduler()
                clear = ClearInbox()
                broker = interaction.InteractionBroker(
                    scheduler=scheduler,
                    inbox_adapter=self.inbox,
                    clear_adapter=clear,
                    clock=self.clock,
                )
                created = broker.create(
                    kind="delete_node",
                    choices=DELETE_CHOICES,
                    title="Delete?",
                    prompt="Private path",
                    target_fingerprint=self.fingerprint,
                    ttl_seconds=5,
                )
                scheduler.run_next()
                if terminal == "timeout":
                    self.clock.advance(5)
                    broker.get(created["request_id"])
                else:
                    broker.disconnect()
                scheduler.run_next()
                self.assertEqual(clear.request_ids, [created["request_id"]])

    def test_resolve_accepts_exactly_once(self):
        request_id = self.create_delete()["request_id"]
        first = self.broker.resolve(request_id, "Delete")
        second = self.broker.resolve(request_id, "Bypass")
        self.assertTrue(first["accepted"])
        self.assertEqual(first["state"], interaction.RESOLVED)
        self.assertEqual(first["result"]["choice"], "Delete")
        self.assertFalse(second["accepted"])
        self.assertEqual(second["result"], first["result"])

    def test_concurrent_resolution_has_one_winner(self):
        request_id = self.create_delete()["request_id"]
        barrier = threading.Barrier(3)
        results = []

        def resolve(choice):
            barrier.wait()
            results.append(self.broker.resolve(request_id, choice))

        threads = [
            threading.Thread(target=resolve, args=("Delete",)),
            threading.Thread(target=resolve, args=("Bypass",)),
        ]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(sum(result["accepted"] for result in results), 1)
        decisions = {result["result"]["choice"] for result in results}
        self.assertEqual(len(decisions), 1)

    def test_invalid_choice_leaves_request_pending(self):
        request_id = self.create_delete()["request_id"]
        with self.assertRaises(interaction.InteractionValidationError):
            self.broker.resolve(request_id, "Force")
        self.assertEqual(self.broker.get(request_id)["state"], interaction.PENDING)

    def test_close_and_cancel_are_cancelled_keep(self):
        request_id = self.create_delete()["request_id"]
        closed = self.broker.cancel(request_id, "closed")
        duplicate = self.broker.cancel(request_id)
        self.assertEqual(closed["state"], interaction.CANCELLED)
        self.assertEqual(closed["result"]["choice"], "Keep")
        self.assertEqual(closed["result"]["reason"], "closed")
        self.assertTrue(closed["accepted"])
        self.assertFalse(duplicate["accepted"])

    def test_timeout_is_expired_keep_and_late_resolution_is_rejected(self):
        request_id = self.create_delete(ttl_seconds=5)["request_id"]
        self.clock.advance(5)
        expired = self.broker.get(request_id)
        late = self.broker.resolve(request_id, "Delete")
        self.assertEqual(expired["state"], interaction.EXPIRED)
        self.assertEqual(expired["result"]["choice"], "Keep")
        self.assertEqual(expired["result"]["reason"], "timeout")
        self.assertFalse(late["accepted"])
        self.assertEqual(late["result"], expired["result"])

    def test_expiring_active_request_schedules_next_live_request(self):
        first = self.create_delete(ttl_seconds=5)
        self.clock.advance(1)
        second = self.create_save(ttl_seconds=10)
        self.assertEqual(len(self.scheduler.callbacks), 1)
        self.clock.advance(4)
        self.assertEqual(
            self.broker.get(first["request_id"])["state"], interaction.EXPIRED
        )
        self.assertEqual(
            self.broker.get(second["request_id"])["state"], interaction.PENDING
        )
        self.assertEqual(len(self.scheduler.callbacks), 2)
        self.assertFalse(self.scheduler.run_next())  # stale first-frame callback
        self.assertTrue(self.scheduler.run_next())
        self.assertEqual(self.inbox.payloads[-1]["request_id"], second["request_id"])

    def test_disconnect_fails_every_pending_request_to_keep(self):
        first = self.create_delete()
        second = self.create_save()
        changed = self.broker.disconnect()
        self.assertEqual(len(changed), 2)
        for request in (first, second):
            status = self.broker.get(request["request_id"])
            self.assertEqual(status["state"], interaction.FAILED)
            self.assertEqual(status["result"]["choice"], "Keep")
            self.assertEqual(status["result"]["reason"], "disconnect")


class DedupeCapacityAndConsumptionTests(BrokerTestCase):
    def test_retry_with_same_dedupe_key_returns_same_request(self):
        first = self.create_delete(dedupe_key="delete:/project1/node")
        second = self.create_delete(dedupe_key="delete:/project1/node")
        self.assertFalse(first["deduplicated"])
        self.assertTrue(second["deduplicated"])
        self.assertEqual(first["request_id"], second["request_id"])
        self.assertEqual(len(self.scheduler.callbacks), 1)

    def test_dedupe_key_conflict_is_rejected(self):
        self.create_delete(dedupe_key="operation-1")
        with self.assertRaises(interaction.InteractionConflictError):
            self.create_delete(
                dedupe_key="operation-1",
                target_fingerprint=interaction.fingerprint_target("different target"),
            )
        with self.assertRaises(interaction.InteractionConflictError):
            self.create_save(dedupe_key="operation-1")

    def test_pending_cap_is_global_and_duplicate_does_not_consume_capacity(self):
        first = self.create_delete(dedupe_key="one")
        self.create_save(dedupe_key="two")
        self.create_delete(
            dedupe_key="three",
            target_fingerprint=interaction.fingerprint_target("three"),
        )
        duplicate = self.create_delete(dedupe_key="one")
        self.assertEqual(duplicate["request_id"], first["request_id"])
        with self.assertRaises(interaction.InteractionCapacityError):
            self.create_delete(
                dedupe_key="four",
                target_fingerprint=interaction.fingerprint_target("four"),
            )

    def test_snapshot_is_bounded_content_free_and_prunes_expired_requests(self):
        summary = self.broker.snapshot()
        self.assertEqual(
            summary,
            {
                "pending_count": 0,
                "pending_limit": interaction.DEFAULT_PENDING_CAP,
                "active": False,
                "delivery_configured": True,
            },
        )
        self.create_delete(prompt="sensitive project detail", ttl_seconds=5)
        summary = self.broker.snapshot()
        self.assertEqual(summary["pending_count"], 1)
        self.assertTrue(summary["active"])
        self.assertNotIn("prompt", summary)
        self.assertNotIn("request_id", summary)

        self.clock.advance(6)
        expired = self.broker.snapshot()
        self.assertEqual(expired["pending_count"], 0)
        self.assertFalse(expired["active"])

    def test_snapshot_reports_missing_delivery_without_exposing_records(self):
        broker = interaction.InteractionBroker(clock=self.clock)
        summary = broker.snapshot()
        self.assertFalse(summary["delivery_configured"])
        self.assertEqual(set(summary), {
            "pending_count",
            "pending_limit",
            "active",
            "delivery_configured",
        })

    def test_consume_requires_terminal_matching_fingerprint_and_is_one_time(self):
        request_id = self.create_delete()["request_id"]
        pending = self.broker.consume(request_id, self.fingerprint)
        self.assertFalse(pending["accepted"])
        self.assertEqual(pending["error"], "pending")
        self.broker.resolve(request_id, "Bypass")
        mismatch = self.broker.consume(
            request_id, interaction.fingerprint_target("other")
        )
        self.assertFalse(mismatch["accepted"])
        self.assertEqual(mismatch["error"], "fingerprint_mismatch")
        consumed = self.broker.consume(request_id, self.fingerprint)
        repeated = self.broker.consume(request_id, self.fingerprint)
        self.assertTrue(consumed["accepted"])
        self.assertEqual(consumed["decision"], "Bypass")
        self.assertFalse(repeated["accepted"])
        self.assertEqual(repeated["error"], "already_consumed")
        self.assertTrue(self.broker.get(request_id)["consumed"])

    def test_failed_and_cancelled_results_can_be_consumed_as_keep(self):
        failed_broker = interaction.InteractionBroker(clock=self.clock)
        failed = failed_broker.create(
            kind="delete_node",
            choices=DELETE_CHOICES,
            title="Delete?",
            prompt="Delete target?",
            target_fingerprint=self.fingerprint,
        )
        consumed = failed_broker.consume(failed["request_id"], self.fingerprint)
        self.assertTrue(consumed["accepted"])
        self.assertEqual(consumed["decision"], "Keep")

        cancelled = self.create_save()
        self.broker.cancel(cancelled["request_id"])
        save_fingerprint = interaction.fingerprint_target("/tmp/show.toe")
        consumed_cancel = self.broker.consume(cancelled["request_id"], save_fingerprint)
        self.assertTrue(consumed_cancel["accepted"])
        self.assertEqual(consumed_cancel["decision"], "Keep")

    def test_unknown_request_id_is_not_found(self):
        with self.assertRaises(interaction.InteractionNotFoundError):
            self.broker.get("opaque-request-id-000000000000")


if __name__ == "__main__":
    unittest.main()
