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
    api_service,
    batch_service,
    connect_service,
    custom_params_service,
    editor_service,
    log_service,
    param_text_service,
    preview_service,
    project_analysis_service,
    project_load_service,
    system_service,
    transport_service,
)


class _Unauthorized(PermissionError):
    """Authentication failed — missing or invalid bearer token (HTTP 401)."""

    status = 401


class _Forbidden(PermissionError):
    """Request refused regardless of credentials — cross-origin or exec disabled (HTTP 403)."""

    status = 403


def _required_token():
    """The shared bearer token the bridge enforces, or None when auth is off.

    Off by default (zero-config local flow). Launch TouchDesigner with the
    `TDMCP_BRIDGE_TOKEN` environment variable set — to the SAME value the Node
    server uses — to require authentication on every request.
    """
    token = os.environ.get("TDMCP_BRIDGE_TOKEN")
    return token or None


def _exec_allowed():
    """Whether the arbitrary-code endpoints (`/api/exec`, node `method`) are enabled.

    Default-deny unless the bridge is authenticated with TDMCP_BRIDGE_TOKEN or the
    operator explicitly opts in with `TDMCP_BRIDGE_ALLOW_EXEC=1` (also accepts
    true/yes/on). This holds even against a direct network caller, independent of
    the Node server's own `TDMCP_RAW_PYTHON` gate (which only hides the tools
    client-side). Structured endpoints stay available.
    """
    raw = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")
    if raw is None:
        return _required_token() is not None
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
                if isinstance(value, (list, tuple)) and value and isinstance(value[0], str):
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
        raise _Forbidden("Forbidden: cross-origin request rejected (origin %r)." % origin)


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


def _parse_body(request):
    data = request.get("data")
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


def _route_get_root(rest, query, webserver=None):
    if rest == ["info"]:
        return api_service.get_info()
    if rest == ["health"]:
        return api_service.get_health(webserver)
    if rest == ["nodes"]:
        return api_service.get_nodes(_qs(query, "parent"))
    if rest == ["system"]:
        # Combined GPU/monitors/performMode snapshot — survives ALLOW_EXEC=0.
        include_raw = _qs(query, "include")
        include = [s for s in include_raw.split(",") if s] if include_raw else None
        return system_service.get_system_info(include)
    if rest == ["logs"]:
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
    return None


def _route_post_root_core(rest, body):
    if rest == ["nodes"]:
        _require(body, "parent_path", "type")
        return api_service.create_node(
            body["parent_path"], body["type"], body.get("name"), body.get("parameters")
        )

    if rest == ["exec"]:
        if not _exec_allowed():
            raise _Forbidden("Forbidden: arbitrary code execution is disabled (TDMCP_BRIDGE_ALLOW_EXEC=0).")
        _require(body, "script")
        return api_service.exec_script(body["script"], body.get("return_output", True))

    if rest == ["batch"]:
        return batch_service.run(body.get("operations", []))

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

    return None


def _route_post_root_project(rest, body):
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
            continue_on_error=_as_bool(body.get("continue_on_error", True), "continue_on_error"),
        )

    return None


def _route_post_root(rest, body):
    for router in (_route_post_root_core, _route_post_root_controls, _route_post_root_project):
        routed = router(rest, body)
        if routed is not None:
            return routed
    return None


def _route_root(method, rest, query, body, webserver=None):
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
        return project_analysis_service.analyze(_node_path(rest[1:-1]), recursive=recursive)
    return None


def _route_node_special(method, rest, query, body):
    if rest[-1] == "method" and method == "POST":
        if not _exec_allowed():
            raise _Forbidden(
                "Forbidden: arbitrary method calls are disabled (TDMCP_BRIDGE_ALLOW_EXEC=0)."
            )
        _require(body, "method")
        return api_service.call_method(
            _node_path(rest[1:-1]), body["method"], body.get("args", []), body.get("kwargs", {})
        )
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


def _route_node_param_mode(method, rest, body):
    if method == "PATCH" and len(rest) >= 4 and rest[-1] == "mode" and rest[-3] == "params":
        return param_text_service.set_param_mode(
            _node_path(rest[1:-3]),
            unquote(rest[-2]),
            body.get("mode", "expression"),
            body.get("expr"),
            body.get("value"),
        )
    return None


def _route_node_crud(method, rest, query, body):
    node_path = _node_path(rest[1:])
    if method == "GET":
        return api_service.get_node(node_path)
    if method == "PATCH":
        return api_service.update_parameters(node_path, body.get("parameters", {}))
    if method == "DELETE":
        return api_service.delete_node(node_path, _qs(query, "mode", "delete"))
    return None


def _route_nodes(method, rest, query, body):
    if len(rest) < 2:
        return None
    routed = _route_node_special(method, rest, query, body)
    if routed is not None:
        return routed
    routed = _route_node_param_mode(method, rest, body)
    if routed is not None:
        return routed
    if method == "GET" and rest[-1] == "text":
        return _route_dat_text_get(rest)
    if method == "PUT" and rest[-1] == "text":
        _require(body, "text")
        return param_text_service.put_dat_text(_node_path(rest[1:-1]), body["text"])
    return _route_node_crud(method, rest, query, body)


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
    return None


def _route_editor(method, rest, body):
    if method == "POST" and rest == ["editor", "focus"]:
        _require(body, "paths")
        return editor_service.focus(body["paths"], _as_bool(body.get("animate", True), "animate"))
    return None


def _route_network(method, rest, query):
    if method == "GET" and len(rest) >= 3:
        kind = rest[-1]
        node_path = _node_path(rest[1:-1])
        if kind == "errors":
            return analysis_service.errors(node_path)
        if kind == "topology":
            return analysis_service.topology(node_path, recursive=_qs(query, "recursive") == "true")
        if kind == "performance":
            return analysis_service.performance(
                node_path, recursive=_qs(query, "recursive") == "true"
            )
    return None


def _route_second_tier(method, rest, query, body):
    """Dispatch the non-root REST families by their first path segment."""
    if not rest:
        return None
    head = rest[0]
    if head == "projects":
        return _route_projects(method, rest, query)
    if head == "nodes":
        return _route_nodes(method, rest, query, body)
    if head == "preview":
        return _route_preview(method, rest, query, body)
    if head == "preview_job":
        return _route_preview_job(method, rest)
    if head == "editor":
        return _route_editor(method, rest, body)
    if head == "network":
        return _route_network(method, rest, query)
    return None


def _route(method, path, query, body, webserver=None):
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api":
        raise ValueError("Not found: %s" % path)
    rest = parts[1:]
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
        elif method == "DELETE" and len(rest) >= 2 and rest[0] == "nodes" and (data or {}).get("deleted"):
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


# POST routes that don't mutate the project graph and so need no undo block
# (a batched param-mode read; a UI-only editor pan/zoom).
_READ_ONLY_POST = (["param_modes", "batch"], ["editor", "focus"])


def _undo_label(method, path):
    """Undo-block label for a mutating request, or None for a read-only one.

    Every operation that changes the TD network (create/update/delete/connect/exec/…)
    is wrapped in one `ui.undo` block so the artist can Ctrl+Z the whole agent action
    at once. All GETs and the batched param-mode read mutate nothing, so they get no
    block (and never pollute the undo stack).
    """
    if method == "GET":
        return None
    parts = [p for p in path.split("/") if p]
    rest = parts[1:] if parts[:1] == ["api"] else parts
    if method == "POST" and rest in _READ_ONLY_POST:
        return None
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
        yield
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
                "message": "TouchDesigner is recovering from a slow request; retry after %ds." % retry_after,
                "retry_after": retry_after,
            },
        },
    )


def _record_duration(elapsed_seconds):
    if elapsed_seconds * 1000.0 >= _slow_threshold_ms():
        _BACKPRESSURE["cooldown_until"] = time.monotonic() + _cooldown_ms() / 1000.0


def handle(request, response, webserver=None):
    try:
        _check_address_scope(request)
        _check_origin(request)
        _check_host(request)
        _check_auth(request)
        gate = _backpressure_response(response)
        if gate is not None:
            return gate
        method = (request.get("method") or "GET").upper()
        parsed = urlparse(request.get("uri", "/"))
        query = _merge_query(request, parse_qs(parsed.query))
        body = _parse_body(request)
        start = time.monotonic()
        try:
            with _undo_block(_undo_label(method, parsed.path)):
                data = _route(method, parsed.path, query, body, webserver)
                _emit_event(webserver, method, parsed.path, data)
        finally:
            _record_duration(time.monotonic() - start)
        return _send(response, 200, {"ok": True, "data": data})
    except PermissionError as exc:
        return _send(response, getattr(exc, "status", 403), {"ok": False, "error": {"message": str(exc)}})
    except Exception as exc:  # noqa: BLE001
        return _send(response, 400, {"ok": False, "error": {"message": str(exc)}})
