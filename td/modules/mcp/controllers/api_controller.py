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
from mcp.services import analysis_service, api_service, batch_service, preview_service


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
            if isinstance(key, str) and key.lower() == target and isinstance(value, str):
                return value
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
        raise PermissionError("Unauthorized: missing or invalid bearer token.")


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


def _route(method, path, query, body):
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api":
        raise ValueError("Not found: %s" % path)
    rest = parts[1:]

    if rest == ["info"] and method == "GET":
        return api_service.get_info()

    if rest == ["nodes"] and method == "POST":
        return api_service.create_node(
            body["parent_path"], body["type"], body.get("name"), body.get("parameters")
        )
    if rest == ["nodes"] and method == "GET":
        return api_service.get_nodes(_qs(query, "parent"))

    if rest == ["exec"] and method == "POST":
        if not _exec_allowed():
            raise PermissionError("Forbidden: arbitrary code execution is disabled (TDMCP_BRIDGE_ALLOW_EXEC=0).")
        return api_service.exec_script(body["script"], body.get("return_output", True))

    if rest == ["batch"] and method == "POST":
        return batch_service.run(body.get("operations", []))

    if rest[0] == "nodes" and len(rest) >= 2:
        if rest[-1] == "method" and method == "POST":
            if not _exec_allowed():
                raise PermissionError(
                    "Forbidden: arbitrary method calls are disabled (TDMCP_BRIDGE_ALLOW_EXEC=0)."
                )
            return api_service.call_method(
                _node_path(rest[1:-1]),
                body["method"],
                body.get("args", []),
                body.get("kwargs", {}),
            )
        if rest[-1] == "errors" and method == "GET":
            return api_service.get_node_errors(_node_path(rest[1:-1]), recursive=False)
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
        _check_auth(request)
        method = (request.get("method") or "GET").upper()
        parsed = urlparse(request.get("uri", "/"))
        query = _merge_query(request, parse_qs(parsed.query))
        body = _parse_body(request)
        data = _route(method, parsed.path, query, body)
        _emit_event(webserver, method, parsed.path, data)
        return _send(response, 200, {"ok": True, "data": data})
    except PermissionError as exc:
        return _send(response, 401, {"ok": False, "error": {"message": str(exc)}})
    except Exception as exc:  # noqa: BLE001
        return _send(response, 400, {"ok": False, "error": {"message": str(exc)}})
