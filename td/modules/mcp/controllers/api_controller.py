"""HTTP router for the tdmcp bridge.

Maps the REST endpoints the Node MCP server calls onto the service layer and
wraps every response in the standard `{ ok, data | error }` envelope.

Node-path URL segments are percent-encoded by the client (a TD path contains
slashes), so they are `unquote`d here.
"""

import contextlib
import hmac
import json
import math
import os
import time
from urllib.parse import parse_qs, unquote, urlparse

from mcp import events
from mcp.services import (
    analysis_service,
    annotation_layout_service,
    annotation_service,
    api_service,
    batch_service,
    connect_service,
    custom_params_service,
    duplicate_service,
    editor_insert_service,
    editor_service,
    editor_context_service,
    interaction_service,
    log_service,
    metadata_service,
    optypes_service,
    oauth_consent_service,
    operation_plan_service,
    operation_runtime_service,
    package_namespace_service,
    parameter_search_service,
    parameter_service,
    param_text_service,
    preview_service,
    project_analysis_service,
    project_load_service,
    project_service,
    reposition_service,
    save_service,
    search_service,
    system_service,
    tox_export_service,
    transport_service,
    visual_parameter_tuning_service,
    watch_service,
    workspace_service,
    tox_roundtrip_service,
)


class _Unauthorized(PermissionError):
    """Authentication failed — missing or invalid bearer token (HTTP 401)."""

    status = 401


class _Forbidden(PermissionError):
    """Request refused regardless of credentials — cross-origin or exec disabled (HTTP 403)."""

    status = 403


class _PayloadTooLarge(ValueError):
    """A bounded JSON mutation body exceeded its route limit (HTTP 413)."""

    status = 413


def _required_token():
    """The shared bearer token the bridge enforces, or None when auth is off.

    Off by default (zero-config local flow). Launch TouchDesigner with the
    `TDMCP_BRIDGE_TOKEN` environment variable set — to the SAME value the Node
    server uses — to require authentication on every request.
    """
    token = os.environ.get("TDMCP_BRIDGE_TOKEN")
    return token or None


def _exec_allowed():
    """Whether arbitrary and caller-supplied code-bearing writes are enabled.

    Default-deny. Authentication and authorization are separate controls: a
    bearer token proves who may call the bridge, while
    `TDMCP_BRIDGE_ALLOW_EXEC=1` (also accepts true/yes/on) is still required to
    authorize arbitrary code. Structured endpoints stay available unless their
    payload itself carries executable expression/DAT source text.
    """
    raw = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _lan_exposure_enabled():
    """Whether the bridge accepts requests from OFF-HOST (non-loopback) peers.

    Default-DENY. The WebServer DAT binds all interfaces, so without this gate any
    machine that can reach :9980 could drive the bridge — and under the default
    zero-auth + exec config that is drive-by remote code execution. We refuse a
    non-loopback peer address at the earliest point in the request handler, BEFORE
    routing, authentication, or any tool runs, unless the operator explicitly opts
    into LAN exposure by setting `TDMCP_BRIDGE_ALLOW_LAN` to 1/true/yes/on in that
    TouchDesigner's environment (documented for trusted networks, ideally paired
    with `TDMCP_BRIDGE_TOKEN`). Mirrors the official TDMCP "Address Scope" gate.
    """
    raw = os.environ.get("TDMCP_BRIDGE_ALLOW_LAN")
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _quarantine_load_enabled():
    """Whether `POST /api/project/load` may open an artifact in THIS instance.

    Default-DENY. Opening a `.toe`/`.tox` replaces or imports into the running
    project, so it is destructive on the artist's main TD. A bridge must be
    explicitly marked as a throwaway quarantine instance — set
    `TDMCP_PROJECT_RAG_QUARANTINE` to 1/true/yes/on in that TD's environment — to
    honor the route. Without it the route is refused (403), so installing the
    bridge on a normal TD can never let a direct caller load over the open
    project, regardless of `TDMCP_BRIDGE_ALLOW_EXEC`.
    """
    raw = os.environ.get("TDMCP_PROJECT_RAG_QUARANTINE")
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _find_header(request, name):
    """Case-insensitively find an HTTP header in TouchDesigner's request dict.

    TD builds vary in how they expose headers (top-level keys, or nested under a
    'headers'/'header'/'fields' dict), so scan defensively for the first match.
    """
    target = name.lower()

    def scan(node, depth=0):
        if not isinstance(node, dict) or depth > 2:
            return None
        for key, value in node.items():
            if isinstance(key, str) and key.lower() == target:
                # TD builds vary: a header may arrive as a str or as a list of
                # strings (repeated header). Accept a list's first string element
                # so the Origin guard never fails *open* on a list-shaped header.
                if isinstance(value, str):
                    return value
                if (
                    isinstance(value, (list, tuple))
                    and value
                    and isinstance(value[0], str)
                ):
                    return value[0]
        for nested in ("headers", "header", "fields"):
            sub = node.get(nested)
            hit = scan(sub, depth + 1) if isinstance(sub, dict) else None
            if hit is not None:
                return hit
        return None

    return scan(request)


def _check_auth(request):
    token = _required_token()
    if not token:
        return  # auth disabled (default)
    provided = (_find_header(request, "authorization") or "").strip()
    if not hmac.compare_digest(provided, "Bearer " + token):
        raise _Unauthorized("Unauthorized: missing or invalid bearer token.")


def _authorized_operation_principal(path):
    """Return the ephemeral bearer principal for the operation route family.

    Structured commit receipts are capabilities, so this family intentionally
    requires bridge authentication even when unrelated local routes use the
    zero-config mode.  The caller invokes this after `_check_auth` and before
    parsing the body; the raw token is never retained, returned or logged.
    """

    if not path.startswith("/api/operations/"):
        return None
    token = _required_token()
    if token is None:
        raise _Unauthorized(
            "Unauthorized: structured operations require a configured bearer token."
        )
    return token


_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

# Request-meta keys under which TD builds surface the connecting peer's address.
# It is NOT an HTTP header (a client cannot forge it), so it is looked up
# separately from `_find_header`. Builds vary in the exact spelling, so we scan a
# small allowlist and normalize IPv6 / IPv4-mapped forms before comparing.
_CLIENT_ADDRESS_KEYS = (
    "clientAddress",
    "client-address",
    "clientaddress",
    "client_address",
    "remoteAddress",
    "remote-address",
    "remote_address",
    "peerAddress",
    "peer_address",
)


def _strip_brackets(value):
    """Reduce a bracketed IPv6 literal to its bare host, honoring a trailing port.

    `[::1]:9980` -> `::1` and `[::1]` -> `::1`. A plain `strip("[]")` mishandles
    the with-port form (it leaves `::1]:9980`, which fails the loopback check), so
    the bracketed `[host]:port` shape is parsed explicitly. A value without a
    leading bracket is returned unchanged for the caller's other normalizations.
    """
    if not value.startswith("["):
        return value
    end = value.find("]")
    if end == -1:
        return value.strip("[")
    return value[1:end]


def _normalize_address(addr):
    """Reduce a raw peer address to a bare host for loopback comparison.

    Strips an IPv6 zone id (`fe80::1%en0` -> `fe80::1`), brackets with an optional
    port (`[::1]:9980` -> `::1`, `[::1]` -> `::1`), and the IPv4-mapped IPv6 prefix
    (`::ffff:127.0.0.1` -> `127.0.0.1`). A `host:port` pair is left alone unless it
    is an unambiguous IPv4 `a.b.c.d:p`, whose port we drop; bare IPv6 (many colons)
    is never split.
    """
    if not isinstance(addr, str):
        return None
    value = addr.strip()
    if not value:
        return None
    value = _strip_brackets(value)
    if value.startswith("::ffff:") and "." in value:
        value = value[len("::ffff:") :]
    value = value.split("%", 1)[0]
    # Drop a trailing :port only for plain IPv4 (single colon, dotted quad).
    if value.count(":") == 1 and "." in value.split(":", 1)[0]:
        value = value.split(":", 1)[0]
    return value or None


# Only trusted, TouchDesigner-supplied peer info is scanned. HTTP header maps
# (`headers`/`header`/`fields`) are attacker-controlled — scanning them would let a
# remote client spoof `clientAddress: 127.0.0.1` and bypass the loopback-only gate —
# so they are deliberately excluded; only a non-header `meta` container is nested-scanned.
_CLIENT_ADDRESS_NESTED = ("meta",)


def _client_address_here(node):
    """First normalized peer address directly on this dict level, or None."""
    for key in _CLIENT_ADDRESS_KEYS:
        if key in node:
            normalized = _normalize_address(node[key])
            if normalized:
                return normalized
    return None


def _scan_client_address(node, depth=0):
    """Recursively find a normalized peer address (this level, then one nesting)."""
    if not isinstance(node, dict) or depth > 2:
        return None
    here = _client_address_here(node)
    if here is not None:
        return here
    for nested in _CLIENT_ADDRESS_NESTED:
        sub = node.get(nested)
        hit = _scan_client_address(sub, depth + 1) if isinstance(sub, dict) else None
        if hit is not None:
            return hit
    return None


def _client_address(request):
    """Return the connecting peer's address from the request meta, or None.

    Scans the small allowlist of build-specific keys (top level and one nesting
    level, mirroring `_find_header`'s defensiveness). Returns None when the build
    does not surface a peer address at all, in which case the caller falls back to
    the Origin/Host header guards rather than failing open on address scope.
    """
    if not isinstance(request, dict):
        return None
    return _scan_client_address(request)


def _check_address_scope(request):
    """Reject off-host (non-loopback) peers unless LAN exposure is opted in.

    This is the network-layer "Address Scope" gate: it runs FIRST in `handle`,
    before origin/host/auth/routing, so an off-host request is refused immediately
    and never reaches a tool. Enforced on the peer address (which a caller cannot
    forge), independent of the bearer token — even an authenticated remote caller
    is refused unless `TDMCP_BRIDGE_ALLOW_LAN` is set, because binding all
    interfaces without an explicit opt-in is the known drive-by-RCE risk. When the
    TD build does not surface a peer address the check is a no-op and the
    Origin/Host header guards remain the defense.
    """
    if _lan_exposure_enabled():
        return  # operator opted into LAN exposure
    address = _client_address(request)
    if address is None:
        return  # build doesn't expose a peer address; header guards apply
    if address not in _LOOPBACK_HOSTS:
        raise _Forbidden(
            "Forbidden: off-host request from %r rejected. The bridge is "
            "loopback-only by default; set TDMCP_BRIDGE_ALLOW_LAN=1 in "
            "TouchDesigner's environment to allow LAN access." % address
        )


def _check_origin(request):
    """Reject browser-originated cross-origin requests (CSRF / DNS-rebinding).

    The Node MCP server — the only legitimate caller — never sends an `Origin`
    header. Browsers always attach one on cross-site requests, so a request
    bearing a non-loopback `Origin` can only be a web page trying to drive the
    bridge (e.g. a malicious site POSTing to http://127.0.0.1:9980/api/exec).
    Under the default zero-auth + exec-on config that would be drive-by remote
    code execution, so refuse it. Loopback origins stay allowed (a locally
    served tool page still works) and same-origin / no-Origin callers are
    unaffected. Holds even against a direct caller and independent of the
    optional bearer token, mirroring the Node HTTP transport's DNS-rebinding
    guard on its own port.
    """
    origin = _find_header(request, "origin")
    if not origin:
        return
    host = urlparse(origin).hostname
    if host not in _LOOPBACK_HOSTS:
        raise _Forbidden(
            "Forbidden: cross-origin request rejected (origin %r)." % origin
        )


def _check_host(request):
    """Reject non-loopback `Host` headers when auth is off (DNS-rebinding guard).

    The WebServer DAT binds all interfaces, so `_check_origin` alone leaves a
    DNS-rebinding gap: an attacker page on a domain that re-resolves to 127.0.0.1
    can drive a request whose `Host` is the attacker domain. We close it the same
    way the Node HTTP transport does (an `allowedHosts` loopback allowlist) — but
    only in the default zero-token config, which is the one exposed to drive-by
    RCE. When `TDMCP_BRIDGE_TOKEN` is set the operator has opted into authenticated
    use (documented for trusted networks, where `Host` is the machine's LAN name),
    and the bearer token — which a rebinding attacker cannot forge — is the gate,
    so the host is not second-guessed. A missing `Host` is allowed, mirroring the
    Origin logic and older/non-HTTP TD builds.
    """
    if _required_token():
        return  # authenticated use: the token defends against rebinding
    host_header = _find_header(request, "host")
    if not host_header:
        return
    # A real Host header is only `host[:port]`. Reject anything carrying userinfo,
    # a path/query/fragment, whitespace or control chars BEFORE parsing — otherwise
    # a forged value like "evil.com@127.0.0.1" or "127.0.0.1/x" would make urlparse
    # report a loopback hostname and slip the guard. Newlines/tabs are also refused
    # explicitly (clean 403) rather than left to urlparse, whose handling of control
    # characters varies by Python version.
    if any(ch in host_header for ch in "@/\\?# \t\r\n\v\f"):
        raise _Forbidden("Forbidden: malformed Host header %r rejected." % host_header)
    hostname = urlparse("//" + host_header).hostname
    if hostname not in _LOOPBACK_HOSTS:
        raise _Forbidden(
            "Forbidden: non-loopback Host %r rejected (set TDMCP_BRIDGE_TOKEN for "
            "authenticated remote use)." % host_header
        )


def _qs(query, key, default=None):
    values = query.get(key)
    return values[0] if values else default


def _encoded_body_size(data):
    if isinstance(data, (bytes, bytearray)):
        return len(data)
    if isinstance(data, str):
        return len(data.encode("utf-8"))
    if isinstance(data, (dict, list)):
        return len(
            json.dumps(
            data, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        )
    return None


def _reject_oversized_body(data, max_bytes):
    size = _encoded_body_size(data)
    if max_bytes is not None and size is not None and size > max_bytes:
        raise _PayloadTooLarge("Request body exceeds the bounded route limit.")


def _parse_body(request, max_bytes=None):
    data = request.get("data")
    _reject_oversized_body(data, max_bytes)
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8", "ignore")
    if not data:  # None, "", b"" all become an empty body
        return {}
    if isinstance(data, str):
        data = data.strip()
        if not data:
            return {}
        return json.loads(data)
    return data


DEFAULT_MUTATION_BODY_LIMIT = 1024 * 1024


def _bounded_body_limit(method, path):
    """Return a conservative cap for every request that may carry a JSON body."""
    if method not in ("POST", "PATCH", "PUT", "DELETE"):
        return None
    if path in ("/api/editor/reposition", "/api/editor/reposition/context"):
        return 256 * 1024
    if path == "/api/editor/workspaces" or path.startswith(
        "/api/editor/workspaces/"
    ):
        return 32 * 1024
    if path == "/api/interactions" or path.startswith("/api/oauth/consents/"):
        return 32 * 1024
    if path in ("/api/operations/receipt", "/api/operations/revert"):
        return 8 * 1024
    if path.startswith("/api/operations/"):
        return operation_plan_service.MAX_BODY_BYTES
    if path.startswith("/api/editor/visual-parameters/"):
        return visual_parameter_tuning_service.MAX_BODY_BYTES
    return DEFAULT_MUTATION_BODY_LIMIT


def _node_path(segments):
    # TouchDesigner's WebServer DAT decodes %2F into "/", so a node path arrives
    # split across URL segments with its leading slash dropped. Re-join (unquote is
    # a no-op when already decoded) and restore the leading slash.
    raw = "/".join(unquote(s) for s in segments)
    return "/" + raw.lstrip("/")


def _require(body, *keys):
    """Raise a descriptive error when a required body field is absent.

    Without this, `body["script"]`/`body["type"]` etc. raise a bare KeyError whose
    message is only the missing key name — opaque to a direct caller. The Node
    client validates inputs with zod first, so this only fires for raw callers.
    """
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object.")
    missing = [k for k in keys if k not in body]
    if missing:
        raise ValueError("Missing required field(s): %s." % ", ".join(missing))


def _as_bool(value, field_name):
    """Strictly coerce a JSON-decoded value to bool.

    Plain ``bool(value)`` mis-parses strings — ``bool("false")`` is True, so a
    raw caller posting ``{"enabled": "false"}`` would silently flip the flag ON.
    Accept real bools and a small set of canonical string spellings; reject
    everything else with a ValueError, which the controller turns into a 400.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "on"):
            return True
        if v in ("false", "0", "no", "off"):
            return False
    raise ValueError("Field '%s' must be a boolean." % field_name)


def _bridge_error_log_path(webserver):
    """Resolve the installed Error DAT's path from the webserver that serves this
    request. The API is served by the webserver DAT INSIDE the bridge container, so
    the Error DAT is ``webserver.parent().op('error_log')`` regardless of a custom
    ``parent_path``/``container``. Returns None when it can't be resolved (e.g. the
    webserver isn't threaded, as in tests) so the caller falls back to the default."""
    if webserver is None:
        return None
    try:
        bridge = webserver.parent()
        ed = bridge.op("error_log") if bridge is not None else None
        return ed.path if ed is not None else None
    except Exception:  # noqa: BLE001
        return None


def _route_logs(query, webserver):
    # Resolve the Error DAT relative to the webserver's own container so a custom
    # install works; fall back to get_logs' default when tests have no webserver.
    log_kwargs = {}
    error_dat = _bridge_error_log_path(webserver)
    if error_dat:
        log_kwargs["error_dat_path"] = error_dat
    return log_service.get_logs(
        _qs(query, "severity", "all"),
        int(_qs(query, "max_lines", 200)),
        _qs(query, "scope") or None,
        **log_kwargs,
    )


def _route_get_root(rest, query, webserver=None):
    if rest == ["info"]:
        return api_service.get_info()
    if rest == ["health"]:
        return api_service.get_health(webserver)
    if rest == ["nodes"]:
        return api_service.get_nodes(_qs(query, "parent"))
    if rest == ["nodes", "search"]:
        return search_service.search_nodes(
            _qs(query, "root", "/project1"),
            pattern=_qs(query, "pattern") or None,
            name_glob=_qs(query, "name_glob") or None,
            path_glob=_qs(query, "path_glob") or None,
            type_filter=_qs(query, "type") or None,
            type_match=_qs(query, "type_match", "contains"),
            family=_qs(query, "family") or None,
            max_depth=int(_qs(query, "max_depth", 32)),
            limit=int(_qs(query, "limit", search_service.DEFAULT_LIMIT)),
            node_scan_limit=int(
                _qs(query, "node_scan_limit", search_service.DEFAULT_NODE_SCAN_LIMIT)
            ),
            time_limit_ms=int(
                _qs(query, "time_limit_ms", search_service.DEFAULT_TIME_LIMIT_MS)
            ),
        )
    if rest == ["system"]:
        # Combined GPU/monitors/performMode snapshot — survives ALLOW_EXEC=0.
        include_raw = _qs(query, "include")
        include = [s for s in include_raw.split(",") if s] if include_raw else None
        return system_service.get_system_info(include)
    if rest == ["optypes"]:
        # Ground-truth creatable optype list from the live td module — survives
        # ALLOW_EXEC=0. No query params; the full family-grouped enumeration.
        return optypes_service.list_optypes()
    if rest == ["logs"]:
        return _route_logs(query, webserver)
    if rest == ["editor", "context"]:
        return editor_context_service.get_editor_context()
    return None


def _interaction_target(kind, body):
    """Build a server-side target fingerprint and bounded native copy.

    A caller never gets to choose the fingerprint that authorizes the eventual
    mutation.  This keeps an approval bound to the exact operator identity or
    normalized Save As target observed by the bridge.
    """
    target = body.get("target")
    if not isinstance(target, dict):
        raise ValueError("Field 'target' must be a JSON object.")
    if kind == "delete_node":
        _require(target, "path")
        node = api_service.get_node(target["path"])
        path = node["path"]
        type_name = node.get("type") or "operator"
        name = node.get("name") or path.rsplit("/", 1)[-1]
        fingerprint = interaction_service.fingerprint_target(path, type_name, name)
        return (
            fingerprint,
            "Delete, bypass, or keep operator?",
            "%s (%s) at %s. Delete removes this operator and its local wiring; "
            "Bypass preserves it; Keep changes nothing." % (name, type_name, path),
        )
    if kind == "save_overwrite":
        _require(target, "path")
        path = project_service.normalize_project_path(target["path"])
        fingerprint = interaction_service.fingerprint_target("save_overwrite", path)
        return (
            fingerprint,
            "Overwrite existing TouchDesigner project?",
            "%s already exists. Overwrite replaces that file; Keep leaves it unchanged."
            % path,
        )
    if kind == "artifact_overwrite":
        _require(target, "source_path", "target_path")
        descriptor = tox_export_service.build_overwrite_request(
            target["source_path"], target["target_path"]
        )
        return (
            descriptor["target_fingerprint"],
            descriptor["title"],
            descriptor["prompt"],
        )
    if kind == oauth_consent_service.CONSENT_KIND:
        descriptor = _oauth_consent_descriptor(target)
        return (
            descriptor["target_fingerprint"],
            descriptor["title"],
            descriptor["prompt"],
        )
    if kind == "visual_parameter_apply":
        descriptor = visual_parameter_tuning_service.build_interaction_request(target)
        return (
            descriptor["target_fingerprint"],
            descriptor["title"],
            descriptor["prompt"],
        )
    raise ValueError("Unsupported interaction kind: %s" % kind)


def _oauth_consent_descriptor(target):
    """Rebuild the bounded TD display target without trusting a fingerprint."""
    if not isinstance(target, dict):
        raise ValueError("Field 'target' must be a JSON object.")
    resource = target.get("resource")
    registered_redirect_uris = target.get("registered_redirect_uris")
    allowed_redirect_origins = target.get("allowed_redirect_origins")
    return oauth_consent_service.prepare_oauth_consent(
        target,
        registered_redirect_uris=registered_redirect_uris,
        canonical_resource=resource,
        allowed_redirect_origins=allowed_redirect_origins,
    )


def _create_interaction(body):
    _require(body, "kind", "target")
    kind = body["kind"]
    fingerprint, title, prompt = _interaction_target(kind, body)
    return interaction_service.create_interaction(
        kind=kind,
        choices=interaction_service.INTERACTION_CHOICES.get(kind, ()),
        title=title,
        prompt=prompt,
        target_fingerprint=fingerprint,
        ttl_seconds=body.get("ttl_seconds", interaction_service.DEFAULT_TTL_SECONDS),
        dedupe_key=body.get("dedupe_key"),
    )


def _route_interactions(method, rest, body):
    if rest == ["interactions"] and method == "POST":
        return _create_interaction(body)
    if rest == ["interactions", "status"] and method == "GET":
        return interaction_service.interaction_summary()
    if len(rest) == 2 and rest[0] == "interactions" and method == "GET":
        return interaction_service.get_interaction(unquote(rest[1]))
    if (
        len(rest) == 3
        and rest[0] == "interactions"
        and rest[2] == "cancel"
        and method == "POST"
    ):
        return interaction_service.cancel_interaction(
            unquote(rest[1]), body.get("reason", "client_cancelled")
        )
    return None


def _route_oauth_consents(method, rest, body):
    if (
        method == "POST"
        and len(rest) == 4
        and rest[:2] == ["oauth", "consents"]
        and rest[3] == "consume"
    ):
        _require(body, "target")
        descriptor = _oauth_consent_descriptor(body["target"])
        request_id = unquote(rest[2])
        consumed = interaction_service.consume_interaction(
            request_id, descriptor["target_fingerprint"]
        )
        return {
            "request_id": request_id,
            "state": consumed.get("state"),
            "accepted": consumed.get("accepted", False),
            "decision": consumed.get("decision") or "Deny",
            "error": consumed.get("error"),
        }
    return None


def _artifact_overwrite_claim(body):
    interaction_id = body.get("interaction_id")
    if interaction_id is None:
        return None
    descriptor = tox_export_service.build_overwrite_request(
        body.get("source_path"), body.get("target_path")
    )
    consumed = interaction_service.consume_interaction(
        interaction_id, descriptor["target_fingerprint"]
    )
    if not consumed.get("accepted") or consumed.get("decision") != "Overwrite":
        raise tox_export_service.InteractionMismatchError(
            "tox export: overwrite approval was not accepted"
        )
    return {
        "kind": "artifact_overwrite",
        "state": "resolved",
        "choice": "Overwrite",
        "request_id": interaction_id,
        "target_path": descriptor["normalized_target"],
        "target_fingerprint": descriptor["target_fingerprint"],
    }


def _route_tox_roundtrip(method, rest, body):
    roundtrip = ["artifacts", "tox", "roundtrip"]
    if rest[:3] != roundtrip:
        return None
    if not _quarantine_load_enabled():
        raise _Forbidden(
            "Forbidden: TOX roundtrip is available only on an explicitly "
            "configured throwaway quarantine bridge."
        )
    if rest == roundtrip and method == "POST":
        _require(body, "path")
        return tox_roundtrip_service.start_roundtrip(
            body["path"],
            expected_contract=body.get("expected_contract"),
            artifact_sha256=body.get("artifact_sha256"),
            settle_frames=body.get("settle_frames", 4),
            max_nodes=body.get("max_nodes", 500),
            max_errors=body.get("max_errors", 50),
            max_external_refs=body.get("max_external_refs", 50),
            timeout_ms=body.get("timeout_ms", 15000),
        )
    if len(rest) == 4 and method == "GET":
        return tox_roundtrip_service.get_roundtrip(unquote(rest[3]))
    if len(rest) == 5 and rest[4] == "cancel" and method == "POST":
        return tox_roundtrip_service.cancel_roundtrip(
            unquote(rest[3]), body.get("reason", "client_cancelled")
        )
    return None


def _route_tox_exports(method, rest, body):
    prefix = ["artifacts", "tox", "exports"]
    if rest == prefix and method == "POST":
        _require(body, "source_path", "target_path", "idempotency_key")
        return tox_export_service.start_export(
            body["source_path"],
            body["target_path"],
            mode=body.get("mode", "as_is"),
            create_folders=_as_bool(
                body.get("create_folders", False), "create_folders"
            ),
            idempotency_key=body["idempotency_key"],
            overwrite_approval=_artifact_overwrite_claim(body),
        )
    if len(rest) == 5 and rest[:4] == prefix + ["by-key"] and method == "GET":
        return tox_export_service.get_export_by_key(unquote(rest[4]))
    if len(rest) == 4 and rest[:3] == prefix and method == "GET":
        return tox_export_service.get_export(unquote(rest[3]))
    if (
        len(rest) == 5
        and rest[:3] == prefix
        and rest[4] == "cancel"
        and method == "POST"
    ):
        return tox_export_service.cancel_export(
            unquote(rest[3]), body.get("reason", "client_cancelled")
        )
    return None


def _route_artifacts(method, rest, body):
    roundtrip = _route_tox_roundtrip(method, rest, body)
    if roundtrip is not None:
        return roundtrip
    return _route_tox_exports(method, rest, body)


def _save_project(body):
    path = body.get("path")
    interaction_id = body.get("interaction_id")
    if interaction_id is None:
        result = project_service.save_project(path)
        result.update({"saved": True, "action_applied": True})
        return result
    normalized = project_service.normalize_project_path(path)
    fingerprint = interaction_service.fingerprint_target("save_overwrite", normalized)
    consumed = interaction_service.consume_interaction(interaction_id, fingerprint)
    if not consumed.get("accepted") or consumed.get("decision") != "Overwrite":
        return {
            "requested_path": normalized,
            "final_path": None,
            "decision": consumed.get("decision") or "Keep",
            "saved": False,
            "action_applied": False,
            "verified_exists": False,
            "request_id": interaction_id,
        }
    claim = {
        "kind": "save_overwrite",
        "state": "resolved",
        "choice": "Overwrite",
        "target_path": normalized,
    }
    result = project_service.save_project(normalized, overwrite_approval=claim)
    result.update({"saved": True, "action_applied": True, "request_id": interaction_id})
    return result


def _route_post_root_core(rest, body):
    if rest == ["nodes"]:
        _require(body, "parent_path", "type")
        return api_service.create_node(
            body["parent_path"],
            body["type"],
            body.get("name"),
            body.get("parameters"),
            placement=body.get("placement"),
            node_x=body.get("node_x"),
            node_y=body.get("node_y"),
            viewer=body.get("viewer"),
        )

    if rest == ["exec"]:
        if not _exec_allowed():
            raise _Forbidden(
                "Forbidden: arbitrary code execution is disabled (TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        _require(body, "script")
        return api_service.exec_script(body["script"], body.get("return_output", True))

    if rest == ["batch"]:
        return batch_service.run(body.get("operations", []))

    if rest == ["params", "search"]:
        return parameter_search_service.search_parameters(
            body.get("root_path", "/project1"),
            max_depth=body.get("max_depth", parameter_search_service.DEFAULT_MAX_DEPTH),
            node_pattern=body.get("node_pattern"),
            node_name_glob=body.get("node_name_glob"),
            node_path_glob=body.get("node_path_glob"),
            type_filter=body.get("type"),
            type_match=body.get("type_match", "partial"),
            family=body.get("family"),
            parameter_glob=body.get("parameter_glob"),
            value_glob=body.get("value_glob"),
            expression_glob=body.get("expression_glob"),
            mode=body.get("mode"),
            non_default_only=body.get("non_default_only", False),
            limit=body.get("limit", parameter_search_service.DEFAULT_LIMIT),
            node_scan_limit=body.get(
                "node_scan_limit", parameter_search_service.DEFAULT_NODE_SCAN_LIMIT
            ),
            parameter_scan_limit=body.get(
                "parameter_scan_limit",
                parameter_search_service.DEFAULT_PARAMETER_SCAN_LIMIT,
            ),
            time_budget_ms=body.get(
                "time_budget_ms", parameter_search_service.DEFAULT_TIME_BUDGET_MS
            ),
        )

    return None


def _route_post_root_controls(rest, body):
    # Structured wiring + logs endpoints — NO exec gate (they must survive
    # TDMCP_BRIDGE_ALLOW_EXEC=0). Top-level paths, so no collision with nodes/network.
    if rest == ["connect"]:
        _require(body, "source_path", "target_path")
        return connect_service.connect(
            body["source_path"],
            body["target_path"],
            int(body.get("source_output", 0)),
            int(body.get("target_input", 0)),
        )
    if rest == ["disconnect"]:
        _require(body, "to_path")
        return connect_service.disconnect(
            body["to_path"], body.get("from_path"), body.get("to_input")
        )
    if rest == ["transport"]:
        # First-class timeline transport — survives ALLOW_EXEC=0, mirrors
        # control_timeline_transport's verb set. Validation errors raise ValueError
        # and become the standard 400 envelope.
        _require(body, "action")
        return transport_service.control(
            body["action"],
            frame=body.get("frame"),
            rate=body.get("rate"),
            cue_name=body.get("cueName") or body.get("cue_name"),
        )
    if rest == ["perform"]:
        # Perform-mode write — survives ALLOW_EXEC=0; read side lives in /api/system.
        _require(body, "enabled")
        return system_service.set_perform_mode(_as_bool(body["enabled"], "enabled"))
    if rest == ["duplicate"]:
        # Node/subtree duplicate preserving wires+params — survives ALLOW_EXEC=0.
        # TD's own parent.copy(), not arbitrary Python.
        _require(body, "source_path")
        return duplicate_service.duplicate(
            body["source_path"], body.get("name"), body.get("parent_path")
        )

    return None


def _route_post_root_project(rest, body):
    if rest == ["project", "save"]:
        return _save_project(body)

    if rest == ["project", "load"]:
        # Load a .toe/.tox for the Project RAG quarantine analyzer. NOT exec-gated
        # (TD's own loaders, not arbitrary Python), but gated behind an explicit
        # quarantine opt-in: opening an artifact is destructive to the running
        # project, so a bridge on the artist's main TD (no opt-in) refuses it (403)
        # even though the Node side already rejects the main port 9980.
        if not _quarantine_load_enabled():
            raise _Forbidden(
                "Forbidden: project load is disabled on this bridge. Loading a "
                ".toe/.tox replaces the running project, so it is only allowed on a "
                "throwaway quarantine instance — set TDMCP_PROJECT_RAG_QUARANTINE=1 "
                "in that TouchDesigner's environment to enable it."
            )
        _require(body, "path")
        return project_load_service.load(body["path"], body.get("timeout_ms"))

    # Batched read_parameter_modes — must match before the nodes/<path…>/params
    # branch (no <path> segments here so no real conflict, but be explicit).
    if rest == ["param_modes", "batch"]:
        _require(body, "items")
        return param_text_service.read_param_modes_batch(
            body["items"],
            continue_on_error=_as_bool(
                body.get("continue_on_error", True), "continue_on_error"
            ),
        )

    return None


def _route_post_root(rest, body):
    for router in (
        _route_post_root_core,
        _route_post_root_controls,
        _route_post_root_project,
    ):
        routed = router(rest, body)
        if routed is not None:
            return routed
    return None


def _route_watch(method, rest, body, webserver=None):
    """Opt-in parameter-change watch registry — survives ALLOW_EXEC=0.

    `POST /api/params/watch`   {path, pars?} -> register a watch
    `DELETE /api/params/watch` {path, pars?} -> unregister
    `GET /api/params/watch`                  -> list active watches

    Registering is structured (a subscription in `watch_service`), not arbitrary
    Python, so it is intentionally NOT exec-gated. The change events themselves are
    emitted by the `events_hook` onFrameEnd poller and surface on the existing
    WebSocket stream as `param.changed` — no extra DAT install on register.
    """
    if rest != ["params", "watch"]:
        return None
    if method == "GET":
        return watch_service.list_watches()
    if method == "POST":
        _require(body, "path")
        return watch_service.register(body["path"], body.get("pars"))
    if method == "DELETE":
        _require(body, "path")
        return watch_service.unregister(body["path"], body.get("pars"))
    return None


def _route_root(method, rest, query, body, webserver=None):
    interacted = _route_interactions(method, rest, body)
    if interacted is not None:
        return interacted
    watched = _route_watch(method, rest, body, webserver)
    if watched is not None:
        return watched
    if method == "GET":
        return _route_get_root(rest, query, webserver)
    if method == "POST":
        return _route_post_root(rest, body)
    return None


def _route_projects(method, rest, query):
    if method == "GET" and len(rest) >= 3 and rest[-1] == "analysis":
        # /api/projects/<path…>/analysis — diagnostic scan, survives ALLOW_EXEC=0.
        recursive_raw = _qs(query, "recursive")
        recursive = True if recursive_raw is None else (recursive_raw == "true")
        return project_analysis_service.analyze(
            _node_path(rest[1:-1]), recursive=recursive
        )
    return None


def _route_node_post_special(rest, body):
    # POST sub-resources on a node (/method, /save). Split out so the combined
    # special-route dispatch stays under the cognitive-complexity ratchet.
    if rest[-1] == "method":
        if not _exec_allowed():
            raise _Forbidden(
                "Forbidden: arbitrary method calls are disabled (TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        _require(body, "method")
        return api_service.call_method(
            _node_path(rest[1:-1]),
            body["method"],
            body.get("args", []),
            body.get("kwargs", {}),
        )
    if rest[-1] == "save":
        # Structured node save (COMP -> .tox, TOP -> image). NO exec gate: it must
        # survive TDMCP_BRIDGE_ALLOW_EXEC=0. TD's own .save(), not arbitrary Python.
        _require(body, "file")
        return save_service.save_node(
            _node_path(rest[1:-1]),
            body["file"],
            _as_bool(body.get("create_folders", True), "create_folders"),
        )
    return None


def _route_node_special(method, rest, query, body):
    if method == "POST":
        return _route_node_post_special(rest, body)
    if rest[-1] == "errors" and method == "GET":
        return api_service.get_node_errors(_node_path(rest[1:-1]), recursive=False)
    if rest[-1] == "custom_params" and method == "GET":
        return custom_params_service.get_custom_params(_node_path(rest[1:-1]))
    if rest[-1] == "params" and method == "GET" and _qs(query, "modes") == "true":
        return param_text_service.read_param_modes(
            _node_path(rest[1:-1]),
            (_qs(query, "keys").split(",") if _qs(query, "keys") else None),
            _qs(query, "non_default_only") == "true",
        )
    return None


def _route_node_mutation_primitive(method, rest, body):
    if method == "POST" and rest[-1] == "custom_params":
        if _custom_params_contains_caller_code(body) and not _exec_allowed():
            raise _Forbidden(
                "Forbidden: custom-parameter expression/bind assignment is disabled "
                "(TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        return custom_params_service.apply_custom_parameter_lifecycle(
            _node_path(rest[1:-1]), body
        )
    if method == "PATCH" and rest[-1] == "metadata":
        return metadata_service.edit_node_metadata(_node_path(rest[1:-1]), body)
    if method == "PATCH" and rest[-1] == "annotation":
        return annotation_service.edit_annotation(_node_path(rest[1:-1]), body)
    return None


def _custom_param_fields_contain_caller_code(fields):
    if not isinstance(fields, dict):
        return False
    mode = str(fields.get("mode") or "").strip().upper()
    return mode in ("EXPRESSION", "BIND") or any(
        key in fields for key in ("expression", "bind_expression")
    )


def _custom_param_operation_contains_caller_code(operation):
    return (
        isinstance(operation, dict)
        and operation.get("action") == "edit_parameter"
        and _custom_param_fields_contain_caller_code(operation.get("fields"))
    )


def _custom_params_contains_caller_code(body):
    operations = body.get("operations") if isinstance(body, dict) else None
    if not isinstance(operations, list):
        return False
    return any(_custom_param_operation_contains_caller_code(item) for item in operations)


def _route_node_parameter_primitive(method, rest, body):
    if len(rest) >= 4 and rest[-2:] == ["params", "sequences"]:
        node_path = _node_path(rest[1:-2])
        if method == "GET":
            return parameter_service.read_parameter_sequences(node_path)
        if method == "PATCH":
            return parameter_service.update_parameter_sequences(
                node_path,
                body.get("sequences", {}),
                body.get("parameters", {}),
            )
        return None
    if (
        method == "GET"
        and len(rest) >= 5
        and rest[-1] == "menu"
        and rest[-3] == "params"
    ):
        return parameter_service.read_parameter_menu(
            _node_path(rest[1:-3]), unquote(rest[-2])
        )
    if (
        method == "POST"
        and len(rest) >= 5
        and rest[-1] == "pulse"
        and rest[-3] == "params"
    ):
        return parameter_service.pulse_parameter(
            _node_path(rest[1:-3]), unquote(rest[-2])
        )
    return None


def _route_node_editor_primitive(method, rest, body):
    routed = _route_node_mutation_primitive(method, rest, body)
    if routed is not None:
        return routed
    return _route_node_parameter_primitive(method, rest, body)


def _route_node_param_mode(method, rest, body):
    if (
        method == "PATCH"
        and len(rest) >= 4
        and rest[-1] == "mode"
        and rest[-3] == "params"
    ):
        mode = str(body.get("mode") or "expression").strip().lower() or "expression"
        if mode in ("expression", "bind") and not _exec_allowed():
            raise _Forbidden(
                "Forbidden: parameter expression/bind assignment is disabled "
                "(TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        return param_text_service.set_param_mode(
            _node_path(rest[1:-3]),
            unquote(rest[-2]),
            mode,
            body.get("expr"),
            body.get("value"),
        )
    return None


def _delete_with_ticket(node_path, request_id):
    node = api_service.get_node(node_path)
    fingerprint = interaction_service.fingerprint_target(
        node["path"], node.get("type") or "operator", node.get("name") or ""
    )
    consumed = interaction_service.consume_interaction(request_id, fingerprint)
    decision = consumed.get("decision") if consumed.get("accepted") else "Keep"
    chosen_mode = "bypass" if decision == "Bypass" else "delete"
    return api_service.delete_node(
        node_path,
        mode=chosen_mode,
        decision=decision,
        confirmation_policy="native",
        request_id=request_id,
    )


def _route_node_delete(node_path, query):
    mode = _qs(query, "mode", "delete")
    policy = _qs(query, "confirmation_policy")
    request_id = _qs(query, "interaction_id")
    if mode == "bypass" and request_id is None:
        return api_service.delete_node(
            node_path, mode="bypass", confirmation_policy=policy or "explicit_mode"
        )
    if policy == "yolo":
        return api_service.delete_node(
            node_path, mode="delete", confirmation_policy="yolo"
        )
    if request_id is None:
        return api_service.delete_node(
            node_path, mode="delete", confirmation_policy="native"
        )
    return _delete_with_ticket(node_path, request_id)


def _route_node_crud(method, rest, query, body):
    node_path = _node_path(rest[1:])
    if method == "GET":
        return api_service.get_node(node_path)
    if method == "PATCH":
        return api_service.update_parameters(node_path, body.get("parameters", {}))
    if method == "DELETE":
        return _route_node_delete(node_path, query)
    return None


def _route_nodes(method, rest, query, body):
    if len(rest) < 2:
        return None
    routed = _route_node_editor_primitive(method, rest, body)
    if routed is not None:
        return routed
    routed = _route_node_special(method, rest, query, body)
    if routed is not None:
        return routed
    routed = _route_node_param_mode(method, rest, body)
    if routed is not None:
        return routed
    routed = _route_dat_text(method, rest, body)
    if routed is not None:
        return routed
    return _route_node_crud(method, rest, query, body)


def _route_dat_text(method, rest, body):
    if len(rest) >= 4 and rest[-2:] == ["text", "edit"]:
        if method != "POST":
            return None
        if not _exec_allowed():
            raise _Forbidden(
                "Forbidden: DAT text mutation is disabled "
                "(TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        _require(body, "old_string", "new_string")
        return param_text_service.edit_dat_text(
            _node_path(rest[1:-2]),
            body["old_string"],
            body["new_string"],
            _as_bool(body.get("replace_all", False), "replace_all"),
            body.get("source", "auto"),
        )
    if rest[-1] != "text":
        return None
    if method == "GET":
        return _route_dat_text_get(rest)
    if method != "PUT":
        return None
    if not _exec_allowed():
        raise _Forbidden(
            "Forbidden: DAT text mutation is disabled "
            "(TDMCP_BRIDGE_ALLOW_EXEC=0)."
        )
    _require(body, "text")
    return param_text_service.put_dat_text(
        _node_path(rest[1:-1]),
        body["text"],
        body.get("source_path"),
        body.get("language"),
        body.get("newline", "preserve"),
        body.get("bom", "preserve"),
    )


def _route_dat_text_get(rest):
    # Disambiguate a node literally named "text": the /text suffix only means
    # "read this DAT's text" when the PARENT is actually a DAT. Otherwise the
    # WebServer DAT decoded the path's slashes and "text" is the node's own name.
    txt_parent = _node_path(rest[1:-1])
    if param_text_service.is_dat(txt_parent):
        return param_text_service.get_dat_text(txt_parent)
    return api_service.get_node(_node_path(rest[1:]))


def _preview_get(node_path, query):
    grid = _qs(query, "sample_grid")
    if grid is not None:
        # Cheap JSON stats instead of an encoded image (10–50× cheaper).
        return preview_service.sample_grid(node_path, int(grid))
    return preview_service.capture(
        node_path, int(_qs(query, "width", 640)), int(_qs(query, "height", 360))
    )


def _preview_post(node_path, body):
    # Advanced capture: same-tick pre-pulses + optional deferred (delay_frames) job.
    return preview_service.capture_advanced(
        node_path,
        width=int(body.get("width", 640)),
        height=int(body.get("height", 360)),
        pre_pulses=body.get("pre_pulses"),
        delay_frames=int(body.get("delay_frames", 0) or 0),
        sample_grid_n=body.get("sample_grid"),
    )


def _route_preview(method, rest, query, body):
    if len(rest) < 2:
        return None
    node_path = _node_path(rest[1:])
    if method == "GET":
        return _preview_get(node_path, query)
    if method == "POST":
        return _preview_post(node_path, body)
    return None


def _route_preview_job(method, rest):
    if method == "GET" and len(rest) >= 2:
        return preview_service.collect_preview_job(unquote(rest[1]))
    if method == "POST" and len(rest) == 3 and rest[2] == "cancel":
        return preview_service.cancel_preview_job(unquote(rest[1]))
    return None


def _route_annotation_layout(method, rest, body):
    if method == "POST" and rest == ["editor", "annotation-layout", "context"]:
        _require(body, "root_path")
        return annotation_layout_service.get_layout_context(
            body["root_path"],
            recursive=_as_bool(body.get("recursive", False), "recursive"),
        )
    if method == "POST" and rest == ["editor", "annotation-layout", "apply"]:
        return annotation_layout_service.apply_layout(body)
    return None


def _route_editor_insert(method, rest, body):
    if method == "POST" and rest == ["editor", "insert"]:
        _require(body, "type", "expected_context", "idempotency_key")
        return editor_insert_service.insert_operator_at_selection(body)
    return None


def _route_editor_focus(method, rest, body):
    if method == "POST" and rest == ["editor", "focus"]:
        _require(body, "paths")
        return editor_service.start_follow(
            body["paths"],
            animate=_as_bool(body.get("animate", True), "animate"),
            action=body.get("action", "view"),
            framing=body.get("framing", "auto"),
            enabled=_as_bool(body.get("enabled", True), "enabled"),
            request_id=body.get("request_id"),
        )
    if method == "GET" and len(rest) == 3 and rest[:2] == ["editor", "focus"]:
        return editor_service.get_follow_status(unquote(rest[2]))
    if (
        method == "POST"
        and len(rest) == 4
        and rest[:2] == ["editor", "focus"]
        and rest[3] == "cancel"
    ):
        return editor_service.cancel_follow(unquote(rest[2]))
    return None


def _route_editor_reposition(method, rest, body):
    if method == "POST" and rest == ["editor", "reposition", "context"]:
        return reposition_service.get_reposition_context(body)
    if method == "POST" and rest == ["editor", "reposition"]:
        return reposition_service.reposition_operators(body)
    return None


def _route_editor_visual_parameters(method, rest, body):
    if method != "POST" or rest[:2] != ["editor", "visual-parameters"]:
        return None
    if rest == ["editor", "visual-parameters", "inspect"]:
        return visual_parameter_tuning_service.inspect_visual_parameters(body)
    if rest == ["editor", "visual-parameters", "commit"]:
        return visual_parameter_tuning_service.commit_visual_parameters(body)
    if rest == ["editor", "visual-parameters", "restore"]:
        return visual_parameter_tuning_service.restore_visual_parameters(body)
    return None


def _route_editor_workspace_item(method, rest, body):
    if len(rest) < 3 or rest[:2] != ["editor", "workspaces"]:
        return None
    workspace_id = unquote(rest[2])
    if method == "GET" and len(rest) == 3:
        return workspace_service.get_workspace_status(workspace_id)
    if method == "POST" and len(rest) == 4 and rest[3] == "restore":
        return workspace_service.restore_workspace(workspace_id, body)
    if method == "POST" and len(rest) == 4 and rest[3] == "cancel":
        return workspace_service.cancel_workspace(workspace_id, body)
    return None


def _route_editor_workspaces(method, rest, body):
    if method == "POST" and rest == ["editor", "workspaces"]:
        return workspace_service.open_workspace(body)
    return _route_editor_workspace_item(method, rest, body)


def _route_editor(method, rest, body):
    for router in (
        _route_annotation_layout,
        _route_editor_insert,
        _route_editor_focus,
        _route_editor_reposition,
        _route_editor_visual_parameters,
        _route_editor_workspaces,
    ):
        routed = router(method, rest, body)
        if routed is not None:
            return routed
    return None


def _route_packages(method, rest, body):
    if method == "POST" and rest == ["packages", "reconcile", "check"]:
        _require(
            body,
            "project_path",
            "package_id",
            "source_url",
            "recorded_ref",
            "scope",
            "intent",
        )
        return package_namespace_service.check_package_namespace(
            project_path=body["project_path"],
            package_id=body["package_id"],
            source_url=body["source_url"],
            recorded_ref=body["recorded_ref"],
            recorded_target_path=body.get("recorded_target_path"),
            scope=body["scope"],
            intent=body["intent"],
        )
    if method == "POST" and rest == ["packages", "reconcile", "apply"]:
        _require(body, "plan_id", "choice", "confirmation_policy")
        return package_namespace_service.apply_package_namespace(
            plan_id=body["plan_id"],
            choice=body["choice"],
            confirmation_policy=body["confirmation_policy"],
            interaction_id=body.get("interaction_id"),
        )
    return None


def _route_network(method, rest, query):
    if method == "GET" and len(rest) >= 3:
        kind = rest[-1]
        node_path = _node_path(rest[1:-1])
        if kind == "errors":
            return analysis_service.errors(node_path)
        if kind == "topology":
            return analysis_service.topology(
                node_path, recursive=_qs(query, "recursive") == "true"
            )
        if kind == "performance":
            return analysis_service.performance(
                node_path, recursive=_qs(query, "recursive") == "true"
            )
    return None


def _route_second_tier(method, rest, query, body):
    """Dispatch the non-root REST families by their first path segment."""
    if not rest:
        return None
    routed = _route_second_tier_core(method, rest, query, body)
    if routed is not None:
        return routed
    return _route_second_tier_extended(method, rest, query, body)


def _route_second_tier_core(method, rest, query, body):
    head = rest[0]
    if head == "projects":
        return _route_projects(method, rest, query)
    if head == "nodes":
        return _route_nodes(method, rest, query, body)
    if head == "preview":
        return _route_preview(method, rest, query, body)
    if head == "preview_job":
        return _route_preview_job(method, rest)
    return None


def _route_operations(method, rest, body, principal):
    """Authenticated structured-operation boundary; never exec-gated."""

    if rest[:1] != ["operations"]:
        return None
    if principal is None:
        raise _Unauthorized(
            "Unauthorized: structured operations require a configured bearer token."
        )
    if method != "POST":
        return None
    if rest == ["operations", "preview"]:
        return operation_runtime_service.preview(body, principal)
    if rest == ["operations", "commit"]:
        return operation_runtime_service.commit(body, principal)
    if rest == ["operations", "receipt"]:
        return operation_runtime_service.receipt(body, principal)
    return None


def _route_second_tier_extended(method, rest, query, body):
    head = rest[0]
    if head == "editor":
        return _route_editor(method, rest, body)
    if head == "network":
        return _route_network(method, rest, query)
    if head == "interactions":
        return _route_interactions(method, rest, body)
    if head == "oauth":
        return _route_oauth_consents(method, rest, body)
    if head in ("artifacts", "packages"):
        return _route_wave7_foundations(method, rest, body)
    return None


def _route_wave7_foundations(method, rest, body):
    if rest[0] == "artifacts":
        return _route_artifacts(method, rest, body)
    return _route_packages(method, rest, body)


def _route(method, path, query, body, webserver=None, operation_principal=None):
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api":
        raise ValueError("Not found: %s" % path)
    rest = parts[1:]
    routed = _route_operations(method, rest, body, operation_principal)
    if routed is not None:
        return routed
    routed = _route_root(method, rest, query, body, webserver)
    if routed is None:
        routed = _route_second_tier(method, rest, query, body)
    if routed is not None:
        return routed
    raise ValueError("Unsupported %s %s" % (method, path))


def _send(response, status, payload):
    response["statusCode"] = status
    response["statusReason"] = "OK" if status < 400 else "Error"
    response["content-type"] = "application/json"
    response["data"] = json.dumps(payload)
    return response


def _merge_query(request, query):
    # TD may surface query params separately from the uri; merge defensively.
    for key in ("pars", "params", "queryString", "query", "args"):
        extra = request.get(key)
        if isinstance(extra, dict):
            for k, v in extra.items():
                query.setdefault(k, v if isinstance(v, list) else [v])
        elif isinstance(extra, str) and extra:
            for k, v in parse_qs(extra).items():
                query.setdefault(k, v)
    return query


def _emit_node_errors(webserver, path):
    if not path:
        return
    try:
        report = api_service.get_node_errors(path, recursive=False)
    except Exception:  # noqa: BLE001
        return
    for err in report.get("errors", []):
        events.broadcast(webserver, "node.error", err)


def _emit_batch_events(webserver, data):
    for result in (data or {}).get("results", []):
        if not result.get("ok"):
            continue
        if result.get("action") == "create":
            node = result.get("data")
            events.broadcast(webserver, "node.created", node)
            _emit_node_errors(webserver, (node or {}).get("path"))
        elif result.get("action") == "delete":
            events.broadcast(webserver, "node.deleted", {"path": result.get("path")})


def _emit_event(webserver, method, path, data):
    if webserver is None:
        return
    parts = [p for p in path.split("/") if p]
    rest = parts[1:] if parts[:1] == ["api"] else []
    try:
        if method == "POST" and rest == ["nodes"]:
            events.broadcast(webserver, "node.created", data)
            _emit_node_errors(webserver, (data or {}).get("path"))
        elif method == "PATCH" and len(rest) >= 2 and rest[0] == "nodes":
            _emit_node_errors(webserver, (data or {}).get("path"))
        elif (
            method == "DELETE"
            and len(rest) >= 2
            and rest[0] == "nodes"
            and (data or {}).get("deleted")
        ):
            # A bypass (mode='bypass') reports {bypassed}, not {deleted}: not a deletion.
            events.broadcast(webserver, "node.deleted", data)
        elif method == "POST" and rest == ["batch"]:
            _emit_batch_events(webserver, data)
    except Exception:  # noqa: BLE001
        pass


def _get_ui():
    """The TouchDesigner `ui` global, or None when unavailable (tests, old builds).

    `ui` is only injected into TD script scope, so reach it via the `td` module the
    same way the services reach `op`/`app`. Absent off-TD, which disables undo
    wrapping (a no-op) rather than failing the request.
    """
    try:
        import td

        return getattr(td, "ui", None)
    except Exception:  # noqa: BLE001
        return None


def _undo_stack_receipt(ui):
    """Return a bounded newest-first native stack receipt, or ``None``."""
    try:
        stack = ui.undo.undoStack
        count = len(stack)
        top = None if count == 0 else str(stack[0])
    except Exception:  # noqa: BLE001 - optional runtime receipt
        return None
    if count < 0 or count > 100_000:
        return None
    if top is not None and (
        not top or len(top) > 256 or any(char in top for char in ("\x00", "\r", "\n"))
    ):
        return None
    return {"count": count, "top": top}


def _attach_undo_receipt(data, wrapper_label, before, after):
    """Expose the actual artist-visible item, not merely the requested label."""
    if not isinstance(data, dict):
        return
    data.pop("undo_label", None)
    data.pop("undo_wrapper_label", None)
    if before is None or after is None or after["count"] != before["count"] + 1:
        return
    actual_label = after.get("top")
    if actual_label is None:
        return
    data["undo_label"] = actual_label
    if actual_label != wrapper_label:
        data["undo_wrapper_label"] = wrapper_label


# POST routes excluded from the generic request wrapper: read/UI/file operations
# plus structured operations whose transaction adapter owns its callback journal.
_UNDO_EXCLUDED_POST = (
    ["param_modes", "batch"],
    ["params", "search"],
    ["editor", "focus"],
    ["editor", "annotation-layout", "context"],
    ["editor", "reposition", "context"],
    ["project", "save"],
    ["packages", "reconcile", "check"],
    ["operations", "preview"],
    ["operations", "commit"],
    ["operations", "receipt"],
)


def _undo_label(method, path, body=None):
    """Undo-block label for a mutating request, or None for a read-only one.

    Every REST request that changes the TD network is wrapped in one `ui.undo`
    block. This is intentionally *not* described as a whole MCP-tool transaction:
    a high-level tool may issue several HTTP requests, and cross-request nesting is
    held behind live validation. Reads and broker traffic never pollute the stack.
    """
    parts = [p for p in path.split("/") if p]
    rest = parts[1:] if parts[:1] == ["api"] else parts
    if _undo_excluded(method, rest):
        return None
    return _specific_undo_label(method, path, rest, body or {})


def _undo_excluded(method, rest):
    if method == "GET":
        return True
    if rest[:2] == ["editor", "focus"]:
        return True
    if rest[:3] == ["artifacts", "tox", "exports"]:
        return True
    if rest[:3] == ["artifacts", "tox", "roundtrip"]:
        return True
    if rest[:2] == ["editor", "workspaces"]:
        return True
    if rest[:2] == ["oauth", "consents"]:
        return True
    if rest == ["editor", "visual-parameters", "inspect"]:
        return True
    return method == "POST" and (
        rest in _UNDO_EXCLUDED_POST or rest[:1] == ["interactions"]
    )


def _post_node_undo_label(rest):
    if rest == ["nodes"]:
        return "MCP create_td_node"
    if len(rest) >= 5 and rest[:1] == ["nodes"] and rest[-1] == "pulse":
        return "MCP pulse_td_parameter %s" % _node_path(rest[1:-3])
    if rest[:1] == ["nodes"] and rest[-1:] == ["custom_params"]:
        return "MCP custom_parameter_lifecycle %s" % _node_path(rest[1:-1])
    return None


def _node_specific_undo_label(method, rest):
    if method == "POST":
        return _post_node_undo_label(rest)
    if method == "DELETE" and rest[:1] == ["nodes"]:
        return "MCP delete_td_node %s" % _node_path(rest[1:])
    if method == "PATCH" and rest[-1:] == ["metadata"] and rest[:1] == ["nodes"]:
        return "MCP edit_td_node_metadata %s" % _node_path(rest[1:-1])
    if method == "PATCH" and rest[-1:] == ["annotation"] and rest[:1] == ["nodes"]:
        return "MCP manage_annotation edit %s" % _node_path(rest[1:-1])
    return None


def _visual_parameter_undo_label(method, rest, body):
    if method != "POST" or rest[:2] != ["editor", "visual-parameters"]:
        return None
    if rest[-1:] == ["commit"]:
        return "MCP enhance_build visual parameters %s" % body.get(
            "scope_path", "unknown"
        )
    if rest[-1:] == ["restore"]:
        return visual_parameter_tuning_service.restore_undo_label(body)
    return None


def _editor_undo_label(method, rest, body):
    if method != "POST":
        return None
    visual_label = _visual_parameter_undo_label(method, rest, body)
    if visual_label is not None:
        return visual_label
    if method == "POST" and rest == ["editor", "insert"]:
        expected = body.get("expected_context") or {}
        return "MCP insert_operator_at_selection %s" % expected.get(
            "selected_path", "unknown"
        )
    if method == "POST" and rest == ["editor", "annotation-layout", "apply"]:
        return "MCP arrange_network annotation-aware %s" % body.get(
            "root_path", "unknown"
        )
    if method == "POST" and rest == ["editor", "reposition"]:
        return "MCP arrange_network explicit %s" % body.get(
            "root_path", "unknown"
        )
    return None


def _specific_undo_label(method, path, rest, body=None):
    node_label = _node_specific_undo_label(method, rest)
    if node_label is not None:
        return node_label
    if method == "POST" and rest == ["packages", "reconcile", "apply"]:
        return package_namespace_service.package_namespace_undo_label(
            (body or {}).get("plan_id", "unknown")
        )
    editor_label = _editor_undo_label(method, rest, body or {})
    if editor_label is not None:
        return editor_label
    return "MCP %s %s" % (method, path)


@contextlib.contextmanager
def _undo_block(label):
    """Wrap a mutating request in ui.undo.startBlock/endBlock (endBlock in finally).

    Best-effort: if `ui` is missing or startBlock throws we skip the block entirely
    rather than fail the request; endBlock only runs when the block actually started.
    """
    ui = _get_ui() if label is not None else None
    started = False
    if ui is not None:
        try:
            ui.undo.startBlock(label)
            started = True
        except Exception:  # noqa: BLE001
            started = False
    try:
        yield started
    finally:
        if started:
            try:
                ui.undo.endBlock()
            except Exception:  # noqa: BLE001
                pass


# Back-pressure: after one request runs slower than the threshold, TD's cook loop
# needs a moment to recover, so the bridge sheds subsequent requests with 503 +
# retry_after for a short cooldown window instead of piling more work on.
_BACKPRESSURE = {"cooldown_until": 0.0}


def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _slow_threshold_ms():
    return _env_int("TDMCP_SLOW_THRESHOLD_MS", 5000)


def _cooldown_ms():
    return _env_int("TDMCP_COOLDOWN_MS", 2000)


def _backpressure_response(response):
    """A 503 + retry_after while cooling down from a slow request, else None."""
    remaining = _BACKPRESSURE["cooldown_until"] - time.monotonic()
    if remaining <= 0:
        return None
    retry_after = max(1, int(math.ceil(remaining)))
    return _send(
        response,
        503,
        {
            "ok": False,
            "error": {
                "code": "backpressure",
                "message": "TouchDesigner is recovering from a slow request; retry after %ds."
                % retry_after,
                "retry_after": retry_after,
            },
        },
    )


def _record_duration(elapsed_seconds):
    if elapsed_seconds * 1000.0 >= _slow_threshold_ms():
        _BACKPRESSURE["cooldown_until"] = time.monotonic() + _cooldown_ms() / 1000.0


_DOMAIN_ERROR_CODES = (
    (_Unauthorized, "unauthorized"),
    (PermissionError, "forbidden"),
    (interaction_service.InteractionNotFoundError, "interaction_not_found"),
    (interaction_service.InteractionCapacityError, "interaction_capacity"),
    (interaction_service.InteractionConflictError, "interaction_conflict"),
)

_CODED_DOMAIN_ERRORS = (
    annotation_layout_service.AnnotationLayoutError,
    tox_export_service.ToxExportError,
    tox_roundtrip_service.ToxRoundtripError,
    package_namespace_service.PackageNamespaceError,
    visual_parameter_tuning_service.VisualParameterTuningError,
    editor_insert_service.EditorInsertError,
    reposition_service.RepositionError,
    workspace_service.WorkspaceError,
    operation_plan_service.OperationPlanError,
)


def _coded_domain_error_code(exc):
    for error_type in _CODED_DOMAIN_ERRORS:
        if isinstance(exc, error_type):
            return exc.code


def _static_domain_error_code(exc):
    for error_type, code in _DOMAIN_ERROR_CODES:
        if isinstance(exc, error_type):
            return code
    return None


def _domain_error_code(exc):
    return _coded_domain_error_code(exc) or _static_domain_error_code(exc)


def _error_code(exc):
    if isinstance(exc, _PayloadTooLarge):
        return "payload_too_large"
    domain_code = _domain_error_code(exc)
    if domain_code is not None:
        return domain_code
    if isinstance(exc, KeyError):
        return "parameter_not_found"
    if isinstance(exc, LookupError):
        return "operator_not_found"
    if isinstance(exc, TypeError):
        return "invalid_parameter_type"
    if isinstance(exc, ValueError):
        return "invalid_input"
    return "bridge_error"


def _error_payload(exc):
    error = {"code": _error_code(exc), "message": str(exc)}
    report = getattr(exc, "report", None)
    if isinstance(report, dict):
        error["details"] = report
    return {"ok": False, "error": error}


def _operation_error_status(exc):
    if not isinstance(exc, operation_plan_service.OperationPlanError):
        return 400
    if exc.code == "operation_authority":
        return 403
    if exc.code in ("preview_expired", "receipt_unavailable"):
        return 410
    if exc.code in (
        "stale_plan",
        "idempotency_conflict",
        "operation_busy",
        "undo_busy",
    ):
        return 409
    return 400


def _attach_started_undo_receipt(data, undo_label, undo_ui, undo_before, started):
    if not started or not undo_label or undo_ui is None:
        return
    _attach_undo_receipt(
        data,
        undo_label,
        undo_before,
        _undo_stack_receipt(undo_ui),
    )


def _dispatch_with_undo(
    method,
    path,
    query,
    body,
    webserver,
    operation_principal=None,
):
    undo_label = _undo_label(method, path, body)
    undo_ui = _get_ui() if undo_label is not None else None
    undo_before = _undo_stack_receipt(undo_ui) if undo_ui is not None else None
    with _undo_block(undo_label) as undo_started:
        data = _route(
            method,
            path,
            query,
            body,
            webserver,
            operation_principal,
        )
    _attach_started_undo_receipt(
        data,
        undo_label,
        undo_ui,
        undo_before,
        undo_started,
    )
    _emit_event(webserver, method, path, data)
    return data


def _authorized_response(request, response, webserver):
    _check_address_scope(request)
    _check_origin(request)
    _check_host(request)
    _check_auth(request)
    method = (request.get("method") or "GET").upper()
    parsed = urlparse(request.get("uri", "/"))
    operation_principal = _authorized_operation_principal(parsed.path)
    gate = _backpressure_response(response)
    if gate is not None:
        return gate
    query = _merge_query(request, parse_qs(parsed.query))
    body_limit = _bounded_body_limit(method, parsed.path)
    body = _parse_body(request, body_limit)
    start = time.monotonic()
    try:
        data = _dispatch_with_undo(
            method,
            parsed.path,
            query,
            body,
            webserver,
            operation_principal,
        )
    finally:
        _record_duration(time.monotonic() - start)
    return _send(response, 200, {"ok": True, "data": data})


def handle(request, response, webserver=None):
    try:
        return _authorized_response(request, response, webserver)
    except PermissionError as exc:
        return _send(
            response,
            getattr(exc, "status", 403),
            {"ok": False, "error": {"code": _error_code(exc), "message": str(exc)}},
        )
    except _PayloadTooLarge as exc:
        return _send(response, exc.status, _error_payload(exc))
    except Exception as exc:  # noqa: BLE001
        return _send(response, _operation_error_status(exc), _error_payload(exc))
