"""Pure, bounded validation for OAuth consent targets displayed in TouchDesigner.

The Node authorization server owns OAuth state, registration, codes and tokens.  This
module accepts only the small display target that Node may send to the authenticated TD
bridge.  It does not import TouchDesigner globals, execute callbacks, retain state or
read ``TDMCP_BRIDGE_ALLOW_EXEC``.

The returned fingerprint binds the exact security-relevant target.  The bridge
recomputes it during exactly-once consumption, and Node issues a code only for the
accepted target-bound result.  No OAuth
secret, code, verifier or state value is accepted by this boundary.
"""

import hashlib
import json
import re
import secrets
import unicodedata
from urllib.parse import parse_qsl, urlsplit


CONSENT_KIND = "oauth_client_consent"
CONSENT_CHOICES = ("Allow", "Deny")
DEFAULT_CHOICE = "Deny"
REQUIRED_SCOPES = ("tdmcp:access",)
CONSENT_TITLE = "Allow OAuth client?"

MAX_TRANSACTION_ID_LENGTH = 128
MIN_TRANSACTION_ID_LENGTH = 32
MAX_CLIENT_ID_LENGTH = 48
MIN_CLIENT_ID_LENGTH = 8
MAX_CLIENT_NAME_INPUT_LENGTH = 256
MAX_CLIENT_NAME_LENGTH = 56
MAX_REDIRECT_URI_LENGTH = 144
MAX_RESOURCE_LENGTH = 144
MAX_REGISTERED_REDIRECT_URIS = 5
MAX_ALLOWED_REDIRECT_ORIGINS = 16
MAX_REDIRECT_QUERY_FIELDS = 16
MAX_PROMPT_LENGTH = 512

_EXPECTED_FIELDS = frozenset(
    (
        "transaction_id",
        "client_id",
        "client_name",
        "redirect_uri",
        "registered_redirect_uris",
        "allowed_redirect_origins",
        "resource",
        "scopes",
    )
)
_FORBIDDEN_FIELD_PARTS = frozenset(
    (
        "token",
        "code",
        "verifier",
        "challenge",
        "state",
        "nonce",
        "secret",
        "password",
        "callable",
        "callback",
        "action",
        "endpoint",
        "payload",
        "python",
        "script",
    )
)
_FORBIDDEN_REDIRECT_QUERY_FIELDS = frozenset(
    (
        "access_token",
        "authorization_code",
        "client_secret",
        "code",
        "code_verifier",
        "refresh_token",
        "secret",
        "state",
        "token",
    )
)
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._~-]{8,48}$")
_TRANSACTION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
_URI_FORBIDDEN_CHARACTERS = frozenset(("\\", "<", ">", '"', "'", "`"))
_BIDI_CONTROL_CLASSES = frozenset(
    ("BN", "LRE", "LRI", "LRO", "PDF", "PDI", "RLE", "RLI", "RLO", "FSI")
)
_RTL_CLASSES = frozenset(("R", "AL", "AN"))
_DISPLAY_TRANSLATION = str.maketrans(
    {
        "<": "‹",
        ">": "›",
        "&": "＆",
        '"': "”",
        "'": "’",
        "`": "ʼ",
    }
)


class OAuthConsentValidationError(ValueError):
    """The proposed consent target is outside the narrow display contract."""


def _is_forbidden_field_name(name):
    normalized = name.lower().replace("-", "_")
    return any(part in normalized for part in _FORBIDDEN_FIELD_PARTS)


def _validated_payload(payload):
    if type(payload) is not dict:
        raise OAuthConsentValidationError("oauth consent payload must be a plain object")
    if any(type(key) is not str for key in payload):
        raise OAuthConsentValidationError("oauth consent payload keys must be strings")
    if any(callable(value) for value in payload.values()):
        raise OAuthConsentValidationError("oauth consent payload cannot contain callables")
    fields = frozenset(payload)
    extras = fields - _EXPECTED_FIELDS
    if extras:
        if any(_is_forbidden_field_name(name) for name in extras):
            raise OAuthConsentValidationError(
                "oauth consent payload contains forbidden security material"
            )
        raise OAuthConsentValidationError("oauth consent payload contains unsupported fields")
    if fields != _EXPECTED_FIELDS:
        raise OAuthConsentValidationError("oauth consent payload is missing required fields")
    return payload


def _bounded_ascii(value, field, minimum, maximum, pattern):
    if type(value) is not str:
        raise OAuthConsentValidationError("%s must be a string" % field)
    if len(value) < minimum or len(value) > maximum or not pattern.fullmatch(value):
        raise OAuthConsentValidationError("%s is not a bounded opaque identifier" % field)
    return value


def _display_client_character(character):
    category = unicodedata.category(character)
    direction = unicodedata.bidirectional(character)
    if direction in _RTL_CLASSES:
        return "?"
    if (
        direction in _BIDI_CONTROL_CLASSES
        or category.startswith("C")
        or not character.isprintable()
    ):
        return " "
    if character.isspace():
        return " "
    return character.translate(_DISPLAY_TRANSLATION)


def _sanitize_client_name(value):
    if type(value) is not str:
        raise OAuthConsentValidationError("client_name must be a string")
    if len(value) > MAX_CLIENT_NAME_INPUT_LENGTH:
        raise OAuthConsentValidationError("client_name exceeds its input limit")
    normalized = unicodedata.normalize("NFKC", value)
    display = "".join(_display_client_character(character) for character in normalized)
    clean = " ".join(display.split()) or "Unnamed client"
    if len(clean) > MAX_CLIENT_NAME_LENGTH:
        clean = clean[: MAX_CLIENT_NAME_LENGTH - 1].rstrip() + "…"
    return clean


def _validated_uri_text(value, field, maximum):
    if type(value) is not str:
        raise OAuthConsentValidationError("%s must be a string" % field)
    if not value or len(value) > maximum:
        raise OAuthConsentValidationError("%s exceeds its bounded URI contract" % field)
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise OAuthConsentValidationError("%s must be an ASCII URI" % field) from exc
    if any(character.isspace() for character in value) or any(
        character in _URI_FORBIDDEN_CHARACTERS for character in value
    ):
        raise OAuthConsentValidationError("%s contains unsafe URI characters" % field)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise OAuthConsentValidationError("%s is not a valid absolute URI" % field) from exc
    if (
        parsed.scheme not in ("http", "https")
        or not value.startswith(parsed.scheme + "://")
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.hostname.lower() == "localhost"
        or "*" in parsed.hostname
        or "%" in parsed.hostname
        or port == 0
    ):
        raise OAuthConsentValidationError("%s is not an allowed absolute URI" % field)
    return parsed


def _origin(parsed):
    hostname = parsed.hostname.lower()
    host = "[%s]" % hostname if ":" in hostname else hostname
    port = parsed.port
    default_port = 443 if parsed.scheme == "https" else 80
    suffix = "" if port is None or port == default_port else ":%d" % port
    return "%s://%s%s" % (parsed.scheme, host, suffix)


def _validated_allowed_origins(values):
    if type(values) not in (list, tuple) or len(values) > MAX_ALLOWED_REDIRECT_ORIGINS:
        raise OAuthConsentValidationError("allowed redirect origins must be a bounded list")
    origins = set()
    for value in values:
        parsed = _validated_uri_text(
            value,
            "allowed_redirect_origin",
            MAX_REDIRECT_URI_LENGTH,
        )
        if (
            parsed.scheme != "https"
            or parsed.path
            or parsed.query
            or parsed.fragment
            or value != _origin(parsed)
        ):
            raise OAuthConsentValidationError(
                "allowed redirect origins must be exact HTTPS origins"
            )
        origins.add(value)
    return frozenset(origins)


def _validated_registered_redirects(values):
    if (
        type(values) not in (list, tuple)
        or not values
        or len(values) > MAX_REGISTERED_REDIRECT_URIS
    ):
        raise OAuthConsentValidationError("registered redirect URIs must be a bounded list")
    registered = []
    for value in values:
        if type(value) is not str or len(value) > MAX_REDIRECT_URI_LENGTH:
            raise OAuthConsentValidationError("registered redirect URI is invalid")
        registered.append(value)
    return tuple(registered)


def _reject_sensitive_redirect_query(parsed):
    try:
        fields = parse_qsl(
            parsed.query,
            keep_blank_values=True,
            max_num_fields=MAX_REDIRECT_QUERY_FIELDS,
        )
    except ValueError as exc:
        raise OAuthConsentValidationError("redirect_uri query is too large") from exc
    if any(name.lower() in _FORBIDDEN_REDIRECT_QUERY_FIELDS for name, _value in fields):
        raise OAuthConsentValidationError("redirect_uri contains OAuth security material")


def _validated_redirect_uri(value, registered_values, allowed_origin_values):
    registered = _validated_registered_redirects(registered_values)
    if type(value) is not str or not value or len(value) > MAX_REDIRECT_URI_LENGTH:
        raise OAuthConsentValidationError("redirect_uri is not a bounded string")
    if not any(secrets.compare_digest(value, candidate) for candidate in registered):
        raise OAuthConsentValidationError("redirect_uri is not exactly registered")
    parsed = _validated_uri_text(value, "redirect_uri", MAX_REDIRECT_URI_LENGTH)
    _reject_sensitive_redirect_query(parsed)
    if parsed.scheme == "http":
        if parsed.hostname not in ("127.0.0.1", "::1"):
            raise OAuthConsentValidationError(
                "HTTP redirect_uri must use a numeric loopback address"
            )
    else:
        allowed = _validated_allowed_origins(allowed_origin_values)
        if _origin(parsed) not in allowed:
            raise OAuthConsentValidationError("HTTPS redirect_uri origin is not allowlisted")
    return value


def _validated_redirect_context(source, registered_values, allowed_origin_values):
    payload_registered = _validated_registered_redirects(
        source["registered_redirect_uris"]
    )
    trusted_registered = _validated_registered_redirects(registered_values)
    if payload_registered != trusted_registered:
        raise OAuthConsentValidationError("registered redirect context mismatch")
    payload_origins = _validated_allowed_origins(source["allowed_redirect_origins"])
    trusted_origins = _validated_allowed_origins(allowed_origin_values)
    if payload_origins != trusted_origins:
        raise OAuthConsentValidationError("allowed redirect origin context mismatch")
    return payload_registered, tuple(sorted(payload_origins))


def _validated_resource(value, canonical_resource):
    canonical = _validated_uri_text(
        canonical_resource,
        "canonical_resource",
        MAX_RESOURCE_LENGTH,
    )
    if (
        canonical.path != "/mcp"
        or canonical.query
        or (canonical.scheme == "http" and canonical.hostname not in ("127.0.0.1", "::1"))
    ):
        raise OAuthConsentValidationError("canonical_resource is not the exact MCP resource")
    if type(value) is not str or not secrets.compare_digest(value, canonical_resource):
        raise OAuthConsentValidationError("resource does not match canonical_resource")
    return value


def _validated_scopes(value):
    if (
        type(value) not in (list, tuple)
        or len(value) != 1
        or type(value[0]) is not str
        or value[0] != REQUIRED_SCOPES[0]
    ):
        raise OAuthConsentValidationError("scopes must be exactly tdmcp:access")
    return REQUIRED_SCOPES


def _target_fingerprint(target):
    canonical = json.dumps(
        target,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _display_safe_uri(value):
    return value.translate(_DISPLAY_TRANSLATION)


def _prompt(client_name, client_id, redirect_uri, resource):
    text = "\n".join(
        (
            "Client (self-asserted): %s" % client_name,
            "ID: %s" % client_id,
            "Redirect: %s" % _display_safe_uri(redirect_uri),
            "Resource: %s" % _display_safe_uri(resource),
            "Scope: tdmcp:access",
            "Allow access to the active tdmcp profile?",
        )
    )
    if len(text) > MAX_PROMPT_LENGTH:
        raise OAuthConsentValidationError("oauth consent prompt exceeds its display limit")
    return text


def prepare_oauth_consent(
    payload,
    *,
    registered_redirect_uris,
    canonical_resource,
    allowed_redirect_origins=(),
):
    """Validate a Node-owned OAuth target and return a display-only descriptor."""
    source = _validated_payload(payload)
    transaction_id = _bounded_ascii(
        source["transaction_id"],
        "transaction_id",
        MIN_TRANSACTION_ID_LENGTH,
        MAX_TRANSACTION_ID_LENGTH,
        _TRANSACTION_ID_RE,
    )
    client_id = _bounded_ascii(
        source["client_id"],
        "client_id",
        MIN_CLIENT_ID_LENGTH,
        MAX_CLIENT_ID_LENGTH,
        _CLIENT_ID_RE,
    )
    client_name = _sanitize_client_name(source["client_name"])
    registered, allowed_origins = _validated_redirect_context(
        source,
        registered_redirect_uris,
        allowed_redirect_origins,
    )
    redirect_uri = _validated_redirect_uri(
        source["redirect_uri"],
        registered,
        allowed_origins,
    )
    resource = _validated_resource(source["resource"], canonical_resource)
    scopes = _validated_scopes(source["scopes"])
    target = {
        "version": 1,
        "transaction_id": transaction_id,
        "client_id": client_id,
        "client_name": client_name,
        "redirect_uri": redirect_uri,
        "registered_redirect_uris": list(registered),
        "allowed_redirect_origins": sorted(allowed_origins),
        "resource": resource,
        "scopes": list(scopes),
    }
    fingerprint = _target_fingerprint(target)
    return {
        "kind": CONSENT_KIND,
        "transaction_id": transaction_id,
        "client_id": client_id,
        "client_name": client_name,
        "redirect_uri": redirect_uri,
        "resource": resource,
        "scopes": scopes,
        "target_fingerprint": fingerprint,
        "title": CONSENT_TITLE,
        "prompt": _prompt(client_name, client_id, redirect_uri, resource),
        "choices": CONSENT_CHOICES,
        "default_choice": DEFAULT_CHOICE,
    }
