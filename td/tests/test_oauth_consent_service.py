"""Offline tests for the pure OAuth consent target boundary."""

import os
import re
import sys
import unicodedata
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import oauth_consent_service as oauth_consent  # noqa: E402


class OAuthConsentServiceTests(unittest.TestCase):
    def setUp(self):
        self.resource = "https://tdmcp.example/mcp"
        self.redirect = "https://client.example/callback"
        self.allowed_origins = ("https://client.example",)
        self.registered = (self.redirect,)
        self.payload = {
            "transaction_id": "T" * 32,
            "client_id": "client_0123456789",
            "client_name": "Visual Client",
            "redirect_uri": self.redirect,
            "registered_redirect_uris": [self.redirect],
            "allowed_redirect_origins": list(self.allowed_origins),
            "resource": self.resource,
            "scopes": ["tdmcp:access"],
        }

    def prepare(self, overrides=None, **context):
        payload = dict(self.payload)
        if overrides:
            payload.update(overrides)
        if "registered" in context:
            payload["registered_redirect_uris"] = list(context["registered"])
        if "origins" in context:
            payload["allowed_redirect_origins"] = list(context["origins"])
        return oauth_consent.prepare_oauth_consent(
            payload,
            registered_redirect_uris=context.get("registered", self.registered),
            canonical_resource=context.get("resource", self.resource),
            allowed_redirect_origins=context.get("origins", self.allowed_origins),
        )

    def test_builds_exact_fail_closed_display_contract(self):
        descriptor = self.prepare()

        self.assertEqual(descriptor["kind"], "oauth_client_consent")
        self.assertEqual(descriptor["choices"], ("Allow", "Deny"))
        self.assertEqual(descriptor["default_choice"], "Deny")
        self.assertEqual(descriptor["scopes"], ("tdmcp:access",))
        self.assertEqual(descriptor["redirect_uri"], self.redirect)
        self.assertEqual(descriptor["resource"], self.resource)
        self.assertEqual(descriptor["title"], "Allow OAuth client?")
        self.assertIn("Client (self-asserted): Visual Client", descriptor["prompt"])
        self.assertLessEqual(len(descriptor["prompt"]), oauth_consent.MAX_PROMPT_LENGTH)
        self.assertRegex(descriptor["target_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertNotIn(self.payload["transaction_id"], descriptor["prompt"])

    def test_rejects_redirect_context_drift_between_payload_and_trusted_adapter(self):
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(
                {
                    "registered_redirect_uris": [
                        "https://client.example/different-callback"
                    ]
                }
            )
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare({"allowed_redirect_origins": ["https://other.example"]})

    def test_fingerprint_is_deterministic_and_changes_on_visible_target_drift(self):
        base = self.prepare()["target_fingerprint"]
        replay = self.prepare()["target_fingerprint"]
        changed_client = self.prepare(
            {"client_id": "client_9876543210"}
        )["target_fingerprint"]
        changed_name = self.prepare(
            {"client_name": "Different Client"}
        )["target_fingerprint"]
        second_redirect = "https://client.example/other-callback"
        changed_redirect = self.prepare(
            {"redirect_uri": second_redirect},
            registered=(self.redirect, second_redirect),
        )["target_fingerprint"]
        second_resource = "https://other-tdmcp.example/mcp"
        changed_resource = self.prepare(
            {"resource": second_resource},
            resource=second_resource,
        )["target_fingerprint"]
        changed_transaction = self.prepare(
            {"transaction_id": "U" * 32}
        )["target_fingerprint"]

        self.assertEqual(base, replay)
        self.assertEqual(
            len(
                {
                    base,
                    changed_client,
                    changed_name,
                    changed_redirect,
                    changed_resource,
                    changed_transaction,
                }
            ),
            6,
        )

    def test_sanitizes_controls_markup_and_rtl_without_retaining_raw_name(self):
        raw_name = "\x00<script>\u202eevil\u2066\nאבג & 'quoted'`"
        descriptor = self.prepare({"client_name": raw_name})
        clean = descriptor["client_name"]

        self.assertNotIn("<", clean)
        self.assertNotIn(">", clean)
        self.assertNotIn("&", clean)
        self.assertNotIn("'", clean)
        self.assertNotIn("`", clean)
        self.assertNotIn(raw_name, descriptor["prompt"])
        self.assertLessEqual(len(clean), oauth_consent.MAX_CLIENT_NAME_LENGTH)
        for character in clean:
            self.assertFalse(unicodedata.category(character).startswith("C"))
            self.assertNotIn(unicodedata.bidirectional(character), ("R", "AL", "AN"))
        self.assertNotIn("<script>", str(descriptor))

    def test_long_printable_client_name_is_clipped_but_input_is_bounded(self):
        clipped = self.prepare({"client_name": "A" * 200})["client_name"]
        self.assertEqual(len(clipped), oauth_consent.MAX_CLIENT_NAME_LENGTH)
        self.assertTrue(clipped.endswith("…"))

        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(
                {"client_name": "A" * (oauth_consent.MAX_CLIENT_NAME_INPUT_LENGTH + 1)}
            )

    def test_accepts_only_exact_registered_redirect(self):
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(registered=("https://client.example/other",))

        descriptor = self.prepare(
            registered=("https://client.example/other", self.redirect)
        )
        self.assertEqual(descriptor["redirect_uri"], self.redirect)

    def test_accepts_numeric_loopback_http_redirects(self):
        redirects = (
            "http://127.0.0.1:43123/callback",
            "http://[::1]:43124/callback",
        )
        for redirect in redirects:
            with self.subTest(redirect=redirect):
                descriptor = self.prepare(
                    {"redirect_uri": redirect},
                    registered=(redirect,),
                    origins=(),
                )
                self.assertEqual(descriptor["redirect_uri"], redirect)

    def test_rejects_unsafe_redirect_variants(self):
        variants = (
            "http://localhost:43123/callback",
            "http://192.0.2.4:43123/callback",
            "https://user:pass@client.example/callback",
            "https://client.example/callback#fragment",
            "custom://client.example/callback",
            "//client.example/callback",
            "https://*.client.example/callback",
            "https://client.example/<callback>",
        )
        for redirect in variants:
            with self.subTest(redirect=redirect):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare(
                        {"redirect_uri": redirect},
                        registered=(redirect,),
                    )

    def test_https_redirect_origin_must_be_exactly_allowlisted(self):
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(origins=("https://other.example",))
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(origins=("https://client.example/path",))
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(origins=("https://*.example",))

    def test_rejects_oauth_security_material_in_redirect_query(self):
        sentinel = "never-print-this-secret"
        for field in ("code", "state", "token", "code_verifier", "client_secret"):
            redirect = "https://client.example/callback?%s=%s" % (field, sentinel)
            with self.subTest(field=field):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError) as caught:
                    self.prepare(
                        {"redirect_uri": redirect},
                        registered=(redirect,),
                    )
                self.assertNotIn(sentinel, str(caught.exception))

    def test_resource_must_match_exact_canonical_mcp_resource(self):
        for resource in (
            "https://tdmcp.example/mcp/",
            "https://tdmcp.example/other",
            "https://tdmcp.example/mcp?tenant=1",
            "http://tdmcp.example/mcp",
        ):
            with self.subTest(resource=resource):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare({"resource": resource})

        loopback = "http://127.0.0.1:3939/mcp"
        descriptor = self.prepare({"resource": loopback}, resource=loopback)
        self.assertEqual(descriptor["resource"], loopback)

    def test_scopes_must_be_the_one_exact_wave_scope(self):
        for scopes in (
            [],
            ["tdmcp:read"],
            ["tdmcp:access", "tdmcp:write"],
            "tdmcp:access",
            ["TDMCP:ACCESS"],
        ):
            with self.subTest(scopes=scopes):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare({"scopes": scopes})

    def test_transaction_and_client_ids_are_opaque_ascii_and_bounded(self):
        bad_transaction_ids = ("short", "T" * 129, "T" * 31 + "/", "é" * 32)
        for value in bad_transaction_ids:
            with self.subTest(transaction_id=value):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare({"transaction_id": value})

        bad_client_ids = ("short", "C" * 49, "client/id", "client id", "clïent_123")
        for value in bad_client_ids:
            with self.subTest(client_id=value):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare({"client_id": value})

    def test_rejects_forbidden_and_arbitrary_payload_fields_without_leakage(self):
        sentinel = "never-print-this-secret"
        fields = (
            "access_token",
            "refresh_token",
            "authorization_code",
            "code_verifier",
            "state",
            "client_secret",
            "callback",
            "endpoint",
            "python_script",
            "payload",
            "unrelated",
        )
        for field in fields:
            with self.subTest(field=field):
                payload = dict(self.payload)
                payload[field] = sentinel
                with self.assertRaises(oauth_consent.OAuthConsentValidationError) as caught:
                    oauth_consent.prepare_oauth_consent(
                        payload,
                        registered_redirect_uris=self.registered,
                        canonical_resource=self.resource,
                        allowed_redirect_origins=self.allowed_origins,
                    )
                self.assertNotIn(sentinel, str(caught.exception))

    def test_rejects_callables_at_every_boundary(self):
        def callable_value():
            return None

        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare({"client_name": callable_value})
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare({"scopes": [callable_value]})
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(registered=(callable_value,))
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            self.prepare(origins=(callable_value,))

    def test_rejects_arbitrary_nested_values_without_invoking_them(self):
        class HostileValue:
            def __eq__(self, _other):
                raise AssertionError("untrusted equality must not run")

        for field, value in (
            ("transaction_id", HostileValue()),
            ("client_id", HostileValue()),
            ("client_name", HostileValue()),
            ("redirect_uri", HostileValue()),
            ("resource", HostileValue()),
            ("scopes", [HostileValue()]),
        ):
            with self.subTest(field=field):
                with self.assertRaises(oauth_consent.OAuthConsentValidationError):
                    self.prepare({field: value})

    def test_missing_field_and_non_plain_payload_fail_closed(self):
        payload = dict(self.payload)
        del payload["client_id"]
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            oauth_consent.prepare_oauth_consent(
                payload,
                registered_redirect_uris=self.registered,
                canonical_resource=self.resource,
                allowed_redirect_origins=self.allowed_origins,
            )
        with self.assertRaises(oauth_consent.OAuthConsentValidationError):
            oauth_consent.prepare_oauth_consent(
                (("client_id", "client_0123456789"),),
                registered_redirect_uris=self.registered,
                canonical_resource=self.resource,
                allowed_redirect_origins=self.allowed_origins,
            )

    def test_allow_exec_environment_does_not_change_the_contract(self):
        with mock.patch.dict(os.environ, {"TDMCP_BRIDGE_ALLOW_EXEC": "0"}):
            locked = self.prepare()
        with mock.patch.dict(os.environ, {"TDMCP_BRIDGE_ALLOW_EXEC": "1"}):
            unlocked = self.prepare()

        self.assertEqual(locked, unlocked)
        self.assertNotIn("allow_exec", str(locked).lower())

    def test_descriptor_contains_no_oauth_secret_slots(self):
        descriptor = self.prepare()
        serialized = str(descriptor).lower()
        for forbidden in (
            "access_token",
            "refresh_token",
            "authorization_code",
            "code_verifier",
            "client_secret",
            "oauth_state",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", descriptor["target_fingerprint"]))


if __name__ == "__main__":
    unittest.main()
