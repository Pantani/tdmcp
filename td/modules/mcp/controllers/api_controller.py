"""HTTP router for the tdmcp bridge.

Maps the REST endpoints the Node MCP server calls onto the service layer and
wraps every response in the standard `{ ok, data | error }` envelope.

Node-path URL segments are percent-encoded by the client (a TD path contains
slashes), so they are `unquote`d here.
"""

import hmac
import json
import os
from urllib.parse import parse_qs, unquote, urlparse

from mcp import events
from mcp.services import (
    analysis_service,
    api_service,
    batch_service,
    connect_service,
    log_service,
    param_text_service,
    preview_service,
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

    On by default. Set `TDMCP_BRIDGE_ALLOW_EXEC` to 0/false/no/off in TouchDesigner's
    environment to reject them at the bridge — defense in depth that holds even against
    a direct network caller, independent of the Node server's own `TDMCP_RAW_PYTHON`
    gate (which only hides the tools client-side). Structured endpoints stay available.
    """
    raw = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")
    if raw is None:
        return True
    return raw.strip().lower() not in ("0", "false", "no", "off")


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


def _route(method, path, query, body, webserver=None):
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api":
        raise ValueError("Not found: %s" % path)
    rest = parts[1:]

    if rest == ["info"] and method == "GET":
        return api_service.get_info()

    if rest == ["nodes"] and method == "POST":
        _require(body, "parent_path", "type")
        return api_service.create_node(
            body["parent_path"], body["type"], body.get("name"), body.get("parameters")
        )
    if rest == ["nodes"] and method == "GET":
        return api_service.get_nodes(_qs(query, "parent"))

    if rest == ["exec"] and method == "POST":
        if not _exec_allowed():
            raise _Forbidden("Forbidden: arbitrary code execution is disabled (TDMCP_BRIDGE_ALLOW_EXEC=0).")
        _require(body, "script")
        return api_service.exec_script(body["script"], body.get("return_output", True))

    if rest == ["batch"] and method == "POST":
        return batch_service.run(body.get("operations", []))

    # Structured wiring + logs endpoints — NO exec gate (they must survive
    # TDMCP_BRIDGE_ALLOW_EXEC=0). Top-level paths, so no collision with nodes/network.
    if rest == ["connect"] and method == "POST":
        _require(body, "source_path", "target_path")
        return connect_service.connect(
            body["source_path"],
            body["target_path"],
            int(body.get("source_output", 0)),
            int(body.get("target_input", 0)),
        )
    if rest == ["disconnect"] and method == "POST":
        _require(body, "to_path")
        return connect_service.disconnect(
            body["to_path"], body.get("from_path"), body.get("to_input")
        )
    if rest == ["logs"] and method == "GET":
        # Resolve the Error DAT relative to the webserver's own container so a custom
        # install (parent_path/container) works; fall back to get_logs' default when
        # the webserver isn't threaded (e.g. tests).
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

    if rest[0] == "nodes" and len(rest) >= 2:
        if rest[-1] == "method" and method == "POST":
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
        if rest[-1] == "errors" and method == "GET":
            return api_service.get_node_errors(_node_path(rest[1:-1]), recursive=False)
        # Param-mode + DAT-text suffixes — MORE SPECIFIC than the generic node CRUD
        # below, so they MUST be matched first (else `…/text` GET is swallowed by
        # get_node). No exec gate — structured endpoints survive ALLOW_EXEC=0.
        if rest[-1] == "params" and method == "GET" and _qs(query, "modes") == "true":
            return param_text_service.read_param_modes(
                _node_path(rest[1:-1]),
                (_qs(query, "keys").split(",") if _qs(query, "keys") else None),
                _qs(query, "non_default_only") == "true",
            )
        if len(rest) >= 4 and rest[-1] == "mode" and rest[-3] == "params" and method == "PATCH":
            # /api/nodes/<path…>/params/<param>/mode
            return param_text_service.set_param_mode(
                _node_path(rest[1:-3]),
                unquote(rest[-2]),
                body.get("mode", "expression"),
                body.get("expr"),
                body.get("value"),
            )
        if rest[-1] == "text" and method == "GET":
            # Disambiguate a node literally named "text": the /text suffix only means
            # "read this DAT's text" when the PARENT is actually a DAT. Otherwise the
            # WebServer DAT decoded the path's slashes and "text" is the node's own
            # name, so return that node's detail instead of the parent's DAT text.
            _txt_parent = _node_path(rest[1:-1])
            if param_text_service.is_dat(_txt_parent):
                return param_text_service.get_dat_text(_txt_parent)
            return api_service.get_node(_node_path(rest[1:]))
        if rest[-1] == "text" and method == "PUT":
            _require(body, "text")
            return param_text_service.put_dat_text(_node_path(rest[1:-1]), body["text"])
        node_path = _node_path(rest[1:])
        if method == "GET":
            return api_service.get_node(node_path)
        if method == "PATCH":
            return api_service.update_parameters(node_path, body.get("parameters", {}))
        if method == "DELETE":
            return api_service.delete_node(node_path)

    if rest[0] == "preview" and method == "GET" and len(rest) >= 2:
        return preview_service.capture(
            _node_path(rest[1:]), int(_qs(query, "width", 640)), int(_qs(query, "height", 360))
        )

    if rest[0] == "network" and method == "GET" and len(rest) >= 3:
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
        elif method == "DELETE" and len(rest) >= 2 and rest[0] == "nodes":
            events.broadcast(webserver, "node.deleted", data)
        elif method == "POST" and rest == ["batch"]:
            for result in (data or {}).get("results", []):
                if not result.get("ok"):
                    continue
                if result.get("action") == "create":
                    node = result.get("data")
                    events.broadcast(webserver, "node.created", node)
                    _emit_node_errors(webserver, (node or {}).get("path"))
                elif result.get("action") == "delete":
                    events.broadcast(webserver, "node.deleted", {"path": result.get("path")})
    except Exception:  # noqa: BLE001
        pass


def handle(request, response, webserver=None):
    try:
        _check_origin(request)
        _check_auth(request)
        method = (request.get("method") or "GET").upper()
        parsed = urlparse(request.get("uri", "/"))
        query = _merge_query(request, parse_qs(parsed.query))
        body = _parse_body(request)
        data = _route(method, parsed.path, query, body, webserver)
        _emit_event(webserver, method, parsed.path, data)
        return _send(response, 200, {"ok": True, "data": data})
    except PermissionError as exc:
        return _send(response, getattr(exc, "status", 403), {"ok": False, "error": {"message": str(exc)}})
    except Exception as exc:  # noqa: BLE001
        return _send(response, 400, {"ok": False, "error": {"message": str(exc)}})
