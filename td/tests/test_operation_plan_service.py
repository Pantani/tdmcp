import copy
import os
import sys
import threading
import unittest


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import operation_plan_service as service  # noqa: E402


PRINCIPAL = "oauth-client-wave14"
OTHER_PRINCIPAL = "oauth-client-other"


def plan(value=0.5, label="Build insert"):
    return {
        "schema_version": 1,
        "label": label,
        "owner_path": "/project1/show",
        "intents": [
            {
                "kind": "create_operator",
                "ref": "insert",
                "type": "nullTOP",
                "name": "insert1",
                "parent": {"path": "/project1/show"},
                "position": {"x": 200, "y": 100},
                "viewer": False,
            },
            {
                "kind": "set_constant_parameters",
                "target": {"ref": "insert"},
                "values": {"opacity": value, "name": "safe"},
            },
        ],
    }


def mixed_plan():
    return {
        "schema_version": 1,
        "label": "Bounded mixed operation",
        "owner_path": "/project1/show",
        "intents": [
            {
                "kind": "create_operator",
                "ref": "created",
                "type": "nullTOP",
                "name": "created1",
                "parent": {"path": "/project1/show"},
                "position": {"x": 100, "y": 200},
            },
            {
                "kind": "create_annotation",
                "ref": "note",
                "name": "note1",
                "parent": {"path": "/project1/show"},
                "bounds": {"x": 20, "y": 30, "w": 240, "h": 120},
                "title": "Safe note",
            },
            {
                "kind": "set_constant_parameters",
                "target": {"path": "/project1/show/a"},
                "values": {"gain": 0.5},
            },
            {
                "kind": "edit_metadata",
                "target": {"path": "/project1/show/a"},
                "position": {"x": 10, "y": 20},
                "viewer": False,
            },
            {
                "kind": "disconnect",
                "source": {"path": "/project1/show/a"},
                "source_output": 0,
                "target": {"path": "/project1/show/b"},
                "target_input": 0,
            },
            {
                "kind": "connect",
                "source": {"path": "/project1/show/c"},
                "source_output": 0,
                "target": {"path": "/project1/show/d"},
                "target_input": 0,
            },
        ],
    }


class SnapshotDouble(service.ScalarSnapshotAdapter):
    def __init__(self):
        self.revision = 1
        self.context = None
        self.calls = 0
        self.write_count = 0
        self.force_absent = set()
        self.edges = set()
        self.parameter_facts = {}
        self.metadata_facts = {}

    @staticmethod
    def _metadata_value(field_name):
        if field_name == "position":
            return {"x": 0, "y": 0}
        if field_name == "color":
            return [0.0, 0.0, 0.0]
        if field_name == "comment":
            return ""
        return False

    def _existing_state(self, path, required):
        parameters = {
            name: copy.deepcopy(
                self.parameter_facts.get(
                    (path, name),
                    {"style": "Float", "mode": "CONSTANT", "value": 0.0, "writable": True},
                )
            )
            for name in sorted(required["parameters"])
        }
        metadata = {
            name: copy.deepcopy(
                self.metadata_facts.get(
                    (path, name),
                    {"value": self._metadata_value(name), "writable": True},
                )
            )
            for name in sorted(required["metadata"])
        }
        inputs = {}
        for index in sorted(required["inputs"]):
            occupants = [
                {"source_path": source, "source_output": source_output}
                for source, source_output, target, target_input in sorted(self.edges)
                if target == path and target_input == index
            ]
            inputs[str(index)] = {"occupants": occupants}
        outputs = {}
        for index in sorted(required["outputs"]):
            targets = [
                {"target_path": target, "target_input": target_input}
                for source, source_output, target, target_input in sorted(self.edges)
                if source == path and source_output == index
            ]
            outputs[str(index)] = {"targets": targets}
        return {
            "parameters": parameters,
            "metadata": metadata,
            "connectors": {"inputs": inputs, "outputs": outputs},
        }

    def capture(self, canonical_plan, affected_paths, requested_operator_types):
        self.calls += 1
        aliases = service._simulate_aliases_and_scope(
            canonical_plan["intents"], canonical_plan["owner_path"]
        )
        created_paths = {fact["path"] for fact in aliases.values()}
        state_contract = service._derive_state_contract(
            canonical_plan, aliases, affected_paths
        )
        return {
            "schema_version": 1,
            "td_build": "2025.32820",
            "project_identity": "fixture-project-%d" % self.revision,
            "owner": {
                "path": canonical_plan["owner_path"],
                "identity": "owner-native-id",
                "type": "baseCOMP",
            },
            "context": copy.deepcopy(self.context),
            "runtime_types": {
                name: {"resolved_name": name, "creatable": True}
                for name in requested_operator_types
            },
            "entities": [
                self._entity(path, path in created_paths or path in self.force_absent, state_contract)
                for path in affected_paths
            ],
        }

    def _entity(self, path, absent, state_contract):
        return {
            "path": path,
            "exists": not absent,
            "identity": None if absent else "native:%s" % path,
            "type": None if absent else "nullTOP",
            "state": {} if absent else self._existing_state(path, state_contract[path]),
        }


class TransactionDouble(service.LiveTransactionAdapter):
    capability = service._LIVE_TRANSACTION_CAPABILITY

    def __init__(self, snapshot, raises=False):
        self.snapshot = snapshot
        self.raises = raises
        self.calls = 0

    def execute(self, prepared, operation_id, label):
        self.calls += 1
        self.snapshot.write_count += 1
        if self.raises:
            raise RuntimeError("sensitive fixture failure")
        results = tuple(
            {
                "index": index,
                "kind": intent["kind"],
                "status": "applied",
                "final_paths": list(prepared.effects[index]["target_paths"]),
            }
            for index, intent in enumerate(prepared.canonical_plan["intents"])
        )
        return service.TransactionOutcome(
            status="applied",
            operation_id=operation_id,
            results=results,
            verification_status="PASS",
            verification_snapshot="after",
            journal=service.JournalReport(
                registered=True,
                operation_id=operation_id,
                label=label,
                native_stack_delta=1,
                observed_state="applied",
            ),
            private_journal={"schema_version": 2},
        )


class OperationPlanValidationTests(unittest.TestCase):
    def test_canonicalization_is_strict_and_deterministic(self):
        first = service.canonicalize_operation_plan(plan())
        reversed_values = plan()
        reversed_values["intents"][1]["values"] = {"name": "safe", "opacity": 0.5}
        second = service.canonicalize_operation_plan(reversed_values)
        self.assertEqual(first, second)
        invalid = plan()
        invalid["extra"] = True
        with self.assertRaisesRegex(service.OperationPlanError, "unsupported fields"):
            service.canonicalize_operation_plan(invalid)

    def test_rejects_unsafe_types_forward_refs_and_cross_parent_targets(self):
        unsafe = plan()
        unsafe["intents"][0]["type"] = "moviefileinTOP"
        with self.assertRaises(service.OperationPlanError) as caught:
            service.canonicalize_operation_plan(unsafe)
        self.assertEqual(caught.exception.code, "unsupported_operator_type")

        forward = plan()
        forward["intents"] = [forward["intents"][1], forward["intents"][0]]
        with self.assertRaisesRegex(service.OperationPlanError, "prior create"):
            service.canonicalize_operation_plan(forward)

        outside = plan()
        outside["intents"][1]["target"] = {"path": "/project1/other/node1"}
        with self.assertRaisesRegex(service.OperationPlanError, "immediate"):
            service.canonicalize_operation_plan(outside)

    def test_enforces_create_parameter_value_and_payload_caps(self):
        too_many_creates = plan()
        too_many_creates["intents"] = [
            {
                **too_many_creates["intents"][0],
                "ref": "node%d" % index,
                "name": "node%d" % index,
            }
            for index in range(17)
        ]
        with self.assertRaises(service.OperationPlanError) as caught:
            service.canonicalize_operation_plan(too_many_creates)
        self.assertEqual(caught.exception.code, "operation_capacity")

    def test_public_unicode_limits_are_utf8_bytes(self):
        accepted = plan(label="é" * 48)
        self.assertEqual(service.canonicalize_operation_plan(accepted)["label"], "é" * 48)

        rejected = plan(label="é" * 49)
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(rejected)

        accepted_parameter = plan("🙂" * 512)
        service.canonicalize_operation_plan(accepted_parameter)
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(plan("🙂" * 513))

        annotation = plan()
        annotation["intents"] = [
            {
                "kind": "create_annotation",
                "ref": "note",
                "name": "note1",
                "parent": {"path": "/project1/show"},
                "bounds": {"x": 0, "y": 0, "w": 100, "h": 100},
                "body": "🙂" * 2_048,
            }
        ]
        service.canonicalize_operation_plan(annotation)
        annotation["intents"][0]["body"] += "🙂"
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(annotation)

        oversized = plan("x" * 4_097)
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(oversized)

        body = plan()
        body["label"] = "x" * 140_000
        with self.assertRaises(service.OperationPlanError) as caught:
            service.canonicalize_operation_plan(body)
        self.assertEqual(caught.exception.code, "operation_capacity")

        with self.assertRaises(service.OperationPlanError) as caught:
            service.canonicalize_operation_plan(plan("\ud800"))
        self.assertEqual(caught.exception.code, "invalid_operation_plan")

    def test_context_is_exact_sorted_and_owner_bounded(self):
        context_plan = plan()
        context_plan["expected_context"] = {
            "owner_path": "/project1/show",
            "current_path": "/project1/show/source",
            "selected_paths": ["/project1/show/z", "/project1/show/a"],
        }
        canonical = service.canonicalize_operation_plan(context_plan)
        self.assertEqual(
            canonical["expected_context"]["selected_paths"],
            ["/project1/show/a", "/project1/show/z"],
        )
        context_plan["expected_context"]["selected_paths"][0] = "/project1/other/z"
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(context_plan)

    def test_rejects_unsafe_schema_paths_direct_created_paths_and_metadata_cap(self):
        boolean_version = plan()
        boolean_version["schema_version"] = True
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(boolean_version)

        wildcard = plan()
        wildcard["owner_path"] = "/project1/*"
        with self.assertRaises(service.OperationPlanError):
            service.canonicalize_operation_plan(wildcard)

        direct_created = plan()
        direct_created["intents"][1]["target"] = {"path": "/project1/show/insert1"}
        with self.assertRaisesRegex(service.OperationPlanError, "addressed by ref"):
            service.canonicalize_operation_plan(direct_created)

        metadata_heavy = plan()
        metadata_intent = {
            "kind": "edit_metadata",
            "target": {"ref": "insert"},
            "position": {"x": 1, "y": 2},
            "color": [0.1, 0.2, 0.3],
            "comment": "safe",
            "viewer": False,
            "bypass": False,
            "display": False,
            "render": False,
        }
        metadata_heavy["intents"] = [metadata_heavy["intents"][0]] + [
            copy.deepcopy(metadata_intent) for _ in range(19)
        ]
        with self.assertRaises(service.OperationPlanError) as caught:
            service.canonicalize_operation_plan(metadata_heavy)
        self.assertEqual(caught.exception.code, "operation_capacity")


class OperationPlanPreviewTests(unittest.TestCase):
    def setUp(self):
        self.now = [1_700_000_000.0]
        self.snapshot = SnapshotDouble()
        self.service = service.OperationPlanService(
            self.snapshot,
            secret=b"s" * 32,
            bridge_instance_id="bridge-instance-wave12",
            clock=lambda: self.now[0],
        )

    def test_preview_is_bounded_redacted_and_private_hmac_is_value_sensitive(self):
        first = self.service.preview(plan("secret-one"), PRINCIPAL)
        second = self.service.preview(plan("secret-two"), PRINCIPAL)
        self.assertEqual(first["plan_digest"], second["plan_digest"])
        self.assertNotEqual(first["preview_token"], second["preview_token"])
        rendered = repr(first)
        self.assertNotIn("secret-one", rendered)
        self.assertEqual(first["counts"]["creates"], 1)
        self.assertEqual(first["counts"]["parameter_writes"], 2)
        self.assertEqual(first["affected_paths"], ["/project1/show/insert1"])
        self.assertEqual(first["rollback_coverage"], "unverified_for_allowlist")
        self.assertFalse(first["journal_eligible"])

    def test_preview_capability_is_principal_bound_without_disclosing_principal(self):
        preview = self.service.preview(plan(), PRINCIPAL)
        commit = {
            **plan(),
            "preview_token": preview["preview_token"],
            "idempotency_key": "wave14-principal-key-01",
        }
        self.assertNotIn(PRINCIPAL, repr(preview))
        calls_before = self.snapshot.calls
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.prepare_commit(commit, OTHER_PRINCIPAL)
        self.assertEqual(caught.exception.code, "operation_authority")
        self.assertEqual(self.snapshot.calls, calls_before)

        for invalid in ("", "bad\nprincipal", "x" * 257):
            with self.subTest(principal=repr(invalid)), self.assertRaises(
                service.OperationPlanError
            ):
                self.service.preview(plan(), invalid)

    def test_prepare_commit_rejects_expiry_tamper_instance_and_cas_drift_without_writes(self):
        preview = self.service.preview(plan(), PRINCIPAL)
        commit = {**plan(), "preview_token": preview["preview_token"], "idempotency_key": "wave12-safe-key-0001"}
        self.snapshot.revision = 2
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.prepare_commit(commit, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")
        self.assertEqual(self.snapshot.write_count, 0)

        self.snapshot.revision = 1
        tampered = {**commit, "preview_token": preview["preview_token"][:-1] + "A"}
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.prepare_commit(tampered, PRINCIPAL)
        self.assertEqual(caught.exception.code, "operation_authority")

        other = service.OperationPlanService(
            self.snapshot,
            secret=b"o" * 32,
            bridge_instance_id="bridge-instance-other",
            clock=lambda: self.now[0],
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            other.prepare_commit(commit, PRINCIPAL)
        self.assertEqual(caught.exception.code, "preview_instance_mismatch")

        self.now[0] += 31
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.prepare_commit(commit, PRINCIPAL)
        self.assertEqual(caught.exception.code, "preview_expired")

    def test_context_absence_or_drift_fails_closed(self):
        context_plan = plan()
        context_plan["expected_context"] = {
            "owner_path": "/project1/show",
            "current_path": "/project1/show/source",
            "selected_paths": ["/project1/show/source"],
        }
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.preview(context_plan, PRINCIPAL)
        self.assertEqual(caught.exception.code, "ui_unavailable")
        self.snapshot.context = copy.deepcopy(context_plan["expected_context"])
        self.assertEqual(
            self.service.preview(context_plan, PRINCIPAL)["status"],
            "preview",
        )
        self.snapshot.context["current_path"] = "/project1/show/other"
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.preview(context_plan, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

    def test_snapshot_rejects_runtime_proxy_and_unresolved_allowlisted_type(self):
        class ProxySnapshot(SnapshotDouble):
            def capture(self, canonical_plan, affected_paths, requested_operator_types):
                result = super().capture(canonical_plan, affected_paths, requested_operator_types)
                result["entities"][0]["state"] = object()
                return result

        invalid = service.OperationPlanService(
            ProxySnapshot(), secret=b"p" * 32, bridge_instance_id="bridge-instance-proxy"
        )
        with self.assertRaisesRegex(service.OperationPlanError, "runtime proxy"):
            invalid.preview(plan(), PRINCIPAL)

        class MissingTypeSnapshot(SnapshotDouble):
            def capture(self, canonical_plan, affected_paths, requested_operator_types):
                result = super().capture(canonical_plan, affected_paths, requested_operator_types)
                result["runtime_types"] = {}
                return result

        invalid = service.OperationPlanService(
            MissingTypeSnapshot(), secret=b"m" * 32, bridge_instance_id="bridge-instance-missing"
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            invalid.preview(plan(), PRINCIPAL)
        self.assertEqual(caught.exception.code, "unsupported_operator_type")

    def test_snapshot_enforces_expected_existence_and_unique_native_identity(self):
        existing = {
            "schema_version": 1,
            "label": "Edit existing",
            "owner_path": "/project1/show",
            "intents": [
                {
                    "kind": "edit_metadata",
                    "target": {"path": "/project1/show/source"},
                    "viewer": False,
                }
            ],
        }
        self.snapshot.force_absent.add("/project1/show/source")
        with self.assertRaises(service.OperationPlanError) as caught:
            self.service.preview(existing, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

        class DuplicateIdentitySnapshot(SnapshotDouble):
            def capture(self, canonical_plan, affected_paths, requested_operator_types):
                snapshot = super().capture(
                    canonical_plan, affected_paths, requested_operator_types
                )
                for entity in snapshot["entities"]:
                    entity.update(
                        {
                            "exists": True,
                            "identity": "same-native-id",
                            "type": "nullTOP",
                        }
                    )
                return snapshot

        edge = {
            "schema_version": 1,
            "label": "Disconnect existing",
            "owner_path": "/project1/show",
            "intents": [
                {
                    "kind": "disconnect",
                    "source": {"path": "/project1/show/a"},
                    "source_output": 0,
                    "target": {"path": "/project1/show/b"},
                    "target_input": 0,
                }
            ],
        }
        duplicate_service = service.OperationPlanService(
            DuplicateIdentitySnapshot(),
            secret=b"s" * 32,
            bridge_instance_id="bridge-instance-wave12",
            clock=lambda: self.now[0],
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            duplicate_service.preview(edge, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

    def test_snapshot_rejects_invalid_header_scalars_and_owner_child_identity_collision(self):
        class HeaderSnapshot(SnapshotDouble):
            def __init__(self, field, value):
                super().__init__()
                self.field = field
                self.value = value

            def capture(self, canonical_plan, affected_paths, requested_operator_types):
                snapshot = super().capture(
                    canonical_plan, affected_paths, requested_operator_types
                )
                if self.field.startswith("owner."):
                    snapshot["owner"][self.field.split(".", 1)[1]] = self.value
                else:
                    snapshot[self.field] = self.value
                return snapshot

        invalid_headers = (
            ("td_build", None),
            ("project_identity", True),
            ("owner.identity", []),
            ("owner.type", "x" * 129),
        )
        for field, value in invalid_headers:
            invalid = service.OperationPlanService(
                HeaderSnapshot(field, value),
                secret=b"h" * 32,
                bridge_instance_id="bridge-instance-header",
            )
            with self.subTest(field=field), self.assertRaises(service.OperationPlanError):
                invalid.preview(plan(), PRINCIPAL)

        class OwnerCollisionSnapshot(SnapshotDouble):
            def capture(self, canonical_plan, affected_paths, requested_operator_types):
                snapshot = super().capture(
                    canonical_plan, affected_paths, requested_operator_types
                )
                snapshot["entities"][0]["identity"] = snapshot["owner"]["identity"]
                return snapshot

        edit_existing = {
            "schema_version": 1,
            "label": "Edit existing",
            "owner_path": "/project1/show",
            "intents": [
                {
                    "kind": "edit_metadata",
                    "target": {"path": "/project1/show/source"},
                    "viewer": False,
                }
            ],
        }
        collision = service.OperationPlanService(
            OwnerCollisionSnapshot(),
            secret=b"c" * 32,
            bridge_instance_id="bridge-instance-collision",
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            collision.preview(edit_existing, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

    def test_exact_state_contract_covers_every_intent(self):
        self.snapshot.edges.add(
            ("/project1/show/a", 0, "/project1/show/b", 0)
        )
        preview = self.service.preview(mixed_plan(), PRINCIPAL)
        self.assertEqual(preview["counts"]["intents"], 6)
        self.assertEqual(preview["counts"]["creates"], 2)
        self.assertEqual(preview["counts"]["parameter_writes"], 1)
        self.assertEqual(preview["counts"]["metadata_writes"], 2)
        self.assertEqual(preview["counts"]["connects"], 1)
        self.assertEqual(preview["counts"]["disconnects"], 1)

    def test_parameter_state_rejects_missing_extra_type_and_readonly_facts(self):
        target_plan = {
            "schema_version": 1,
            "label": "Set existing parameter",
            "owner_path": "/project1/show",
            "intents": [
                {
                    "kind": "set_constant_parameters",
                    "target": {"path": "/project1/show/a"},
                    "values": {"gain": 0.5},
                }
            ],
        }
        mutations = (
            ({"mode": "CONSTANT", "value": 0.0, "writable": True}, "invalid_operation_plan"),
            (
                {
                    "style": "Float",
                    "mode": "CONSTANT",
                    "value": 0.0,
                    "writable": True,
                    "extra": True,
                },
                "invalid_operation_plan",
            ),
            ({"style": 1, "mode": "CONSTANT", "value": 0.0, "writable": True}, "invalid_operation_plan"),
            ({"style": "Float", "mode": "CONSTANT", "value": 0.0, "writable": False}, "stale_plan"),
        )
        for fact, code in mutations:
            with self.subTest(fact=fact):
                snapshot = SnapshotDouble()
                snapshot.parameter_facts[("/project1/show/a", "gain")] = fact
                instance = service.OperationPlanService(
                    snapshot,
                    secret=b"p" * 32,
                    bridge_instance_id="bridge-instance-parameter-contract",
                )
                with self.assertRaises(service.OperationPlanError) as caught:
                    instance.preview(target_plan, PRINCIPAL)
                self.assertEqual(caught.exception.code, code)

    def test_metadata_state_rejects_missing_extra_type_and_readonly_facts(self):
        target_plan = {
            "schema_version": 1,
            "label": "Edit existing metadata",
            "owner_path": "/project1/show",
            "intents": [
                {
                    "kind": "edit_metadata",
                    "target": {"path": "/project1/show/a"},
                    "position": {"x": 10, "y": 20},
                }
            ],
        }
        mutations = (
            ({"writable": True}, "invalid_operation_plan"),
            ({"value": {"x": 0, "y": 0}, "writable": True, "extra": True}, "invalid_operation_plan"),
            ({"value": {"x": 0, "y": "bad"}, "writable": True}, "invalid_operation_plan"),
            ({"value": {"x": 0, "y": 0}, "writable": False}, "stale_plan"),
        )
        for fact, code in mutations:
            with self.subTest(fact=fact):
                snapshot = SnapshotDouble()
                snapshot.metadata_facts[("/project1/show/a", "position")] = fact
                instance = service.OperationPlanService(
                    snapshot,
                    secret=b"m" * 32,
                    bridge_instance_id="bridge-instance-metadata-contract",
                )
                with self.assertRaises(service.OperationPlanError) as caught:
                    instance.preview(target_plan, PRINCIPAL)
                self.assertEqual(caught.exception.code, code)

    def test_connector_occupancy_and_presence_are_exact_and_sequential(self):
        snapshot = SnapshotDouble()
        snapshot.edges.add(("/project1/show/a", 0, "/project1/show/b", 0))
        sequential = {
            "schema_version": 1,
            "label": "Replace one exact edge",
            "owner_path": "/project1/show",
            "intents": [mixed_plan()["intents"][4], mixed_plan()["intents"][5]],
        }
        instance = service.OperationPlanService(
            snapshot,
            secret=b"e" * 32,
            bridge_instance_id="bridge-instance-edge-contract",
        )
        self.assertEqual(instance.preview(sequential, PRINCIPAL)["status"], "preview")

        snapshot.edges.clear()
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.preview(sequential, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

        connect_only = {**sequential, "intents": [mixed_plan()["intents"][5]]}
        snapshot.edges.add(("/project1/show/x", 0, "/project1/show/d", 0))
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.preview(connect_only, PRINCIPAL)
        self.assertEqual(caught.exception.code, "stale_plan")

    def test_private_cas_detects_existence_parameter_metadata_and_connector_drift(self):
        drift_cases = ("existence", "parameter", "metadata", "connector")
        for drift in drift_cases:
            with self.subTest(drift=drift):
                snapshot = SnapshotDouble()
                snapshot.edges.add(("/project1/show/a", 0, "/project1/show/b", 0))
                instance = service.OperationPlanService(
                    snapshot,
                    secret=b"d" * 32,
                    bridge_instance_id="bridge-instance-drift-contract",
                )
                source = mixed_plan()
                preview = instance.preview(source, PRINCIPAL)
                commit = {
                    **source,
                    "preview_token": preview["preview_token"],
                    "idempotency_key": "wave13-drift-key-%s" % drift,
                }
                if drift == "existence":
                    snapshot.force_absent.add("/project1/show/a")
                elif drift == "parameter":
                    snapshot.parameter_facts[("/project1/show/a", "gain")] = {
                        "style": "Float",
                        "mode": "CONSTANT",
                        "value": 0.75,
                        "writable": True,
                    }
                elif drift == "metadata":
                    snapshot.metadata_facts[("/project1/show/a", "position")] = {
                        "value": {"x": 1, "y": 2},
                        "writable": True,
                    }
                else:
                    snapshot.edges.clear()
                with self.assertRaises(service.OperationPlanError) as caught:
                    instance.prepare_commit(commit, PRINCIPAL)
                self.assertEqual(caught.exception.code, "stale_plan")
                self.assertEqual(snapshot.write_count, 0)


class OperationPlanCommitFoundationTests(unittest.TestCase):
    def setUp(self):
        self.now = [1_700_000_000.0]
        self.snapshot = SnapshotDouble()

    def _service(self, transaction=None, store=None):
        return service.OperationPlanService(
            self.snapshot,
            transaction_adapter=transaction,
            secret=b"c" * 32,
            bridge_instance_id="bridge-instance-commit",
            clock=lambda: self.now[0],
            receipt_store=store,
        )

    def _commit(self, instance, source=None, key="wave12-safe-key-0001"):
        source = source or plan()
        preview = instance.preview(source, PRINCIPAL)
        return {**source, "preview_token": preview["preview_token"], "idempotency_key": key}

    @staticmethod
    def _reservation(marker):
        return {
            "dedupe_id": marker.lower() * 64,
            "fingerprint": ("c" if marker.lower() == "a" else "d") * 64,
            "operation_id": "operation-store-%s" % (marker.lower() * 8),
            "receipt_capability": marker.upper() * 43,
            "authority_binding": "e" * 64,
            "bridge_instance_id": "bridge-instance-store",
        }

    @staticmethod
    def _store_receipt(reservation, status):
        return {
            "status": status,
            "operation_id": reservation["operation_id"],
            "receipt_capability": reservation["receipt_capability"],
        }

    def test_default_commit_is_explicitly_unverified_and_never_writes(self):
        instance = self._service()
        preview = instance.preview(plan(), PRINCIPAL)
        self.assertEqual(preview["rollback_coverage"], "unverified_for_allowlist")
        self.assertFalse(preview["journal_eligible"])
        self.assertEqual(len(preview["warnings"]), 1)
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.commit(self._commit(instance), PRINCIPAL)
        self.assertEqual(caught.exception.code, "unverified_live_boundary")
        self.assertEqual(self.snapshot.write_count, 0)

    def test_preview_reports_live_callback_journal_without_stale_warning(self):
        instance = self._service(TransactionDouble(self.snapshot))
        preview = instance.preview(plan(), PRINCIPAL)
        self.assertEqual(preview["rollback_coverage"], "complete_for_allowlist")
        self.assertTrue(preview["journal_eligible"])
        self.assertEqual(preview["warnings"], [])

    def test_string_capability_spoof_is_rejected_before_writes(self):
        class SpoofAdapter:
            capability = "td-main-thread-callback-journal-live-verified-v1"

            def execute(self, prepared, operation_id, label):
                self.snapshot.write_count += 1

        spoof = SpoofAdapter()
        spoof.snapshot = self.snapshot
        instance = self._service(spoof)
        payload = self._commit(instance)
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.commit(payload, PRINCIPAL)
        self.assertEqual(caught.exception.code, "unverified_live_boundary")
        self.assertEqual(self.snapshot.write_count, 0)

    def test_live_capability_double_exercises_terminal_receipt_and_exact_replay(self):
        transaction = TransactionDouble(self.snapshot)
        instance = self._service(transaction)
        payload = self._commit(instance, plan("secret-runtime-value"))
        receipt = instance.commit(payload, PRINCIPAL)
        self.assertEqual(receipt["status"], "applied")
        self.assertTrue(receipt["journal"]["registered"])
        self.assertRegex(receipt["receipt_capability"], r"^[A-Za-z0-9_-]{43}$")
        self.assertNotIn("idempotency_key", receipt)
        self.assertNotIn("secret-runtime-value", repr(receipt))
        self.assertNotIn(PRINCIPAL, repr(receipt))
        self.assertEqual(transaction.calls, 1)

        self.snapshot.revision = 99
        self.now[0] += 31
        replay = instance.commit(payload, PRINCIPAL)
        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(replay["operation_id"], receipt["operation_id"])
        self.assertEqual(replay["receipt_capability"], receipt["receipt_capability"])
        self.assertEqual(transaction.calls, 1)

    def test_commit_and_receipt_lookup_require_independent_matching_authorities(self):
        transaction = TransactionDouble(self.snapshot)
        instance = self._service(transaction)
        payload = self._commit(instance)

        with self.assertRaises(service.OperationPlanError) as caught:
            instance.commit(payload, OTHER_PRINCIPAL)
        self.assertEqual(caught.exception.code, "operation_authority")
        self.assertEqual(transaction.calls, 0)

        receipt = instance.commit(payload, PRINCIPAL)
        operation_id = receipt["operation_id"]
        capability = receipt["receipt_capability"]
        wrong_capability = ("A" if capability[0] != "A" else "B") + capability[1:]
        denied = (
            (operation_id, wrong_capability, PRINCIPAL),
            (operation_id, capability, OTHER_PRINCIPAL),
            (payload["idempotency_key"], capability, PRINCIPAL),
        )
        for lookup in denied:
            with self.subTest(lookup=lookup[:1]), self.assertRaises(
                service.OperationPlanError
            ) as caught:
                instance.get_terminal_receipt(*lookup)
            self.assertEqual(caught.exception.code, "receipt_unavailable")

        reloaded = service.OperationPlanService(
            self.snapshot,
            secret=b"c" * 32,
            bridge_instance_id="bridge-instance-reloaded",
            receipt_store=instance._receipts,
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            reloaded.get_terminal_receipt(operation_id, capability, PRINCIPAL)
        self.assertEqual(caught.exception.code, "receipt_unavailable")
        self.assertNotIn(PRINCIPAL, repr(receipt))

    def test_terminal_lookup_expires_fail_closed_without_using_idempotency_authority(self):
        store_now = [0.0]
        store = service.TerminalReceiptStore(
            clock=lambda: store_now[0],
            ttl_seconds=31,
            capacity=2,
        )
        instance = self._service(TransactionDouble(self.snapshot), store)
        payload = self._commit(instance)
        receipt = instance.commit(payload, PRINCIPAL)
        store_now[0] = 32
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.get_terminal_receipt(
                receipt["operation_id"],
                receipt["receipt_capability"],
                PRINCIPAL,
            )
        self.assertEqual(caught.exception.code, "receipt_unavailable")

    def test_idempotency_conflict_and_unknown_outcome_are_terminal_and_sanitized(self):
        transaction = TransactionDouble(self.snapshot, raises=True)
        instance = self._service(transaction)
        payload = self._commit(instance)
        receipt = instance.commit(payload, PRINCIPAL)
        self.assertEqual(receipt["status"], "outcome_unknown")
        self.assertNotIn("sensitive fixture failure", repr(receipt))
        self.assertEqual(
            instance.get_terminal_receipt(
                receipt["operation_id"],
                receipt["receipt_capability"],
                PRINCIPAL,
            ),
            receipt,
        )
        replay = instance.commit(payload, PRINCIPAL)
        self.assertEqual(replay["status"], "outcome_unknown")
        self.assertIn("error", replay)

        changed = plan(0.75)
        changed_payload = self._commit(instance, changed, payload["idempotency_key"])
        with self.assertRaises(service.OperationPlanError) as caught:
            instance.commit(changed_payload, PRINCIPAL)
        self.assertEqual(caught.exception.code, "idempotency_conflict")

    def test_receipt_store_capacity_ttl_and_rollback_types_are_bounded(self):
        now = [0.0]
        for unsafe_ttl in (0, 29, 30):
            with self.subTest(ttl=unsafe_ttl), self.assertRaises(
                service.OperationPlanError
            ):
                service.TerminalReceiptStore(
                    clock=lambda: now[0],
                    ttl_seconds=unsafe_ttl,
                    capacity=1,
                )
        store = service.TerminalReceiptStore(clock=lambda: now[0], ttl_seconds=31, capacity=1)
        first = self._reservation("a")
        second = self._reservation("b")
        store.begin(**first)
        store.complete(
            first["dedupe_id"],
            first["fingerprint"],
            self._store_receipt(first, "outcome_unknown"),
        )
        with self.assertRaises(service.OperationPlanError) as caught:
            store.begin(**second)
        self.assertEqual(caught.exception.code, "operation_capacity")
        now[0] = 32
        store.begin(**second)
        store.complete(
            second["dedupe_id"],
            second["fingerprint"],
            self._store_receipt(second, "failed_rolled_back"),
        )
        self.assertIsNone(
            store.lookup(
                first["operation_id"],
                first["receipt_capability"],
                first["authority_binding"],
                first["bridge_instance_id"],
            )
        )
        self.assertEqual(
            store.lookup(
                second["operation_id"],
                second["receipt_capability"],
                second["authority_binding"],
                second["bridge_instance_id"],
            )["status"],
            "failed_rolled_back",
        )
        now[0] = 64
        self.assertIsNone(
            store.lookup(
                second["operation_id"],
                second["receipt_capability"],
                second["authority_binding"],
                second["bridge_instance_id"],
            )
        )

        rollback = service.RollbackReport(
            attempted=True,
            succeeded=False,
            errors=(service.RollbackError(1, "rollback_conflict", "x" * 400),),
        ).public()
        self.assertFalse(rollback["succeeded"])
        self.assertLessEqual(len(rollback["errors"][0]["message"]), 256)
        self.assertNotIn("x" * 20, rollback["errors"][0]["message"])

    def test_receipt_store_rejects_runtime_proxies_and_preserves_active_reservation(self):
        store = service.TerminalReceiptStore(capacity=1)
        reservation = self._reservation("a")
        store.begin(**reservation)
        unsafe = self._store_receipt(reservation, "outcome_unknown")
        unsafe["runtime_proxy"] = object()
        with self.assertRaises(service.OperationPlanError):
            store.complete(
                reservation["dedupe_id"],
                reservation["fingerprint"],
                unsafe,
            )
        with self.assertRaises(service.OperationPlanError) as caught:
            store.replay(
                reservation["dedupe_id"],
                reservation["fingerprint"],
                reservation["authority_binding"],
                reservation["bridge_instance_id"],
            )
        self.assertEqual(caught.exception.code, "operation_busy")

    def test_adapter_output_rejects_duplicate_paths_and_unmatched_rollback_errors(self):
        class Prepared:
            canonical_plan = {"intents": [{"kind": "connect"}]}
            effects = ({"target_paths": ["/project1/show/a", "/project1/show/b"]},)

        with self.assertRaises(service.OperationPlanError):
            service.OperationPlanService._public_result(
                Prepared(),
                {
                    "index": 0,
                    "kind": "connect",
                    "status": "applied",
                    "final_paths": ["/project1/show/a", "/project1/show/a"],
                },
                {"applied"},
                set(),
            )
        with self.assertRaises(service.OperationPlanError):
            service.OperationPlanService._public_result(
                Prepared(),
                {
                    "index": 0,
                    "kind": "connect",
                    "status": "applied",
                    "final_paths": [],
                },
                {"applied"},
                set(),
            )

        base = {
            "status": "failed_rollback",
            "operation_id": "operation-wave13",
            "results": (
                {
                    "index": 0,
                    "kind": "connect",
                    "status": "rollback_failed",
                    "final_paths": ["/project1/show/a"],
                },
            ),
            "verification_status": "FAIL",
            "verification_snapshot": "unknown",
            "journal": service.JournalReport(),
        }
        for errors in (
            (),
            (service.RollbackError(31, "rollback_failed", "outside result"),),
        ):
            outcome = service.TransactionOutcome(
                **base,
                rollback=service.RollbackReport(
                    attempted=True,
                    succeeded=False,
                    errors=errors,
                ),
            )
            with self.subTest(errors=errors), self.assertRaises(service.OperationPlanError):
                service.OperationPlanService._validate_outcome_report_shapes(outcome)

        coherent = service.TransactionOutcome(
            **base,
            rollback=service.RollbackReport(
                attempted=True,
                succeeded=False,
                errors=(service.RollbackError(0, "rollback_failed", "matching result"),),
            ),
        )
        service.OperationPlanService._validate_outcome_report_shapes(coherent)

    def test_active_receipt_reservations_do_not_expire_or_get_evicted(self):
        now = [0.0]
        store = service.TerminalReceiptStore(clock=lambda: now[0], ttl_seconds=31, capacity=1)
        first = self._reservation("a")
        second = self._reservation("b")
        store.begin(**first)
        now[0] = 10
        with self.assertRaises(service.OperationPlanError) as caught:
            store.begin(**second)
        self.assertEqual(caught.exception.code, "operation_busy")
        with self.assertRaises(service.OperationPlanError) as caught:
            store.replay(
                first["dedupe_id"],
                first["fingerprint"],
                first["authority_binding"],
                first["bridge_instance_id"],
            )
        self.assertEqual(caught.exception.code, "operation_busy")
        store.complete(
            first["dedupe_id"],
            first["fingerprint"],
            self._store_receipt(first, "outcome_unknown"),
        )
        self.assertEqual(
            store.lookup(
                first["operation_id"],
                first["receipt_capability"],
                first["authority_binding"],
                first["bridge_instance_id"],
            )["status"],
            "outcome_unknown",
        )

    def test_same_key_reservation_race_has_exactly_one_winner(self):
        store = service.TerminalReceiptStore(capacity=2)
        barrier = threading.Barrier(3)
        results = []
        result_lock = threading.Lock()
        reservation = self._reservation("a")

        def reserve():
            barrier.wait()
            try:
                store.begin(**reservation)
                result = "reserved"
            except service.OperationPlanError as exc:
                result = exc.code
            with result_lock:
                results.append(result)

        workers = [threading.Thread(target=reserve) for _ in range(2)]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join()
        self.assertCountEqual(results, ["reserved", "operation_busy"])

    def test_inconsistent_sensitive_adapter_outcome_becomes_generic_unknown(self):
        class UnsafeOutcomeAdapter(service.LiveTransactionAdapter):
            capability = service._LIVE_TRANSACTION_CAPABILITY

            def execute(self, prepared, operation_id, label):
                return service.TransactionOutcome(
                    status="applied",
                    operation_id=operation_id,
                    results=(),
                    verification_status="FAIL",
                    verification_snapshot="unknown",
                    journal=service.JournalReport(),
                    warnings=("secret-project-value",),
                    error_code="apply_failed",
                    error_message="secret-project-value",
                )

        instance = self._service(UnsafeOutcomeAdapter())
        payload = self._commit(instance)
        receipt = instance.commit(payload, PRINCIPAL)
        self.assertEqual(receipt["status"], "outcome_unknown")
        self.assertNotIn("secret-project-value", repr(receipt))


if __name__ == "__main__":
    unittest.main()
