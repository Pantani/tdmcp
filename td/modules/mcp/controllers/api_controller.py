"""HTTP router for the tdmcp bridge.

Maps the REST endpoints the Node MCP server calls onto the service layer and
wraps every response in the standard `{ ok, data | error }` envelope.

Node-path URL segments are percent-encoded by the client (a TD path contains
slashes), so they are `unquote`d here.
"""

import json
from urllib.parse import parse_qs, unquote, urlparse

from mcp.services import analysis_service, api_service, batch_service, preview_service


def _qs(query, key, default=None):
    values = query.get(key)
    return values[0] if values else default


def _parse_body(request):
    data = request.get("data")
    if data is None or data == "":
        return {}
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")
    if isinstance(data, str):
        return json.loads(data)
    return data


def _route(method, path, query, body):
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api":
        raise ValueError("Not found: %s" % path)
    rest = parts[1:]

    if rest == ["info"] and method == "GET":
        return api_service.get_info()

    if rest == ["nodes"]:
        if method == "POST":
            return api_service.create_node(
                body["parent_path"], body["type"], body.get("name"), body.get("parameters")
            )
        if method == "GET":
            return api_service.get_nodes(_qs(query, "parent"))

    if rest == ["exec"] and method == "POST":
        return api_service.exec_script(body["script"], body.get("return_output", True))

    if rest == ["batch"] and method == "POST":
        return batch_service.run(body.get("operations", []))

    if len(rest) >= 2 and rest[0] == "nodes":
        node_path = unquote(rest[1])
        tail = rest[2:]
        if not tail:
            if method == "GET":
                return api_service.get_node(node_path)
            if method == "PATCH":
                return api_service.update_parameters(node_path, body.get("parameters", {}))
            if method == "DELETE":
                return api_service.delete_node(node_path)
        if tail == ["method"] and method == "POST":
            return api_service.call_method(
                node_path, body["method"], body.get("args", []), body.get("kwargs", {})
            )
        if tail == ["errors"] and method == "GET":
            return api_service.get_node_errors(node_path, recursive=False)

    if len(rest) >= 2 and rest[0] == "preview" and method == "GET":
        node_path = unquote(rest[1])
        return preview_service.capture(
            node_path, int(_qs(query, "width", 640)), int(_qs(query, "height", 360))
        )

    if len(rest) >= 3 and rest[0] == "network" and method == "GET":
        node_path = unquote(rest[1])
        kind = rest[2]
        if kind == "errors":
            return analysis_service.errors(node_path)
        if kind == "topology":
            return analysis_service.topology(node_path)
        if kind == "performance":
            return analysis_service.performance(node_path)

    raise ValueError("Unsupported %s %s" % (method, path))


def _send(response, status, payload):
    response["statusCode"] = status
    response["statusReason"] = "OK" if status < 400 else "Error"
    response["content-type"] = "application/json"
    response["data"] = json.dumps(payload)
    return response


def handle(request, response):
    try:
        method = (request.get("method") or "GET").upper()
        parsed = urlparse(request.get("uri", "/"))
        query = parse_qs(parsed.query)
        body = _parse_body(request)
        data = _route(method, parsed.path, query, body)
        return _send(response, 200, {"ok": True, "data": data})
    except Exception as exc:  # noqa: BLE001
        return _send(response, 400, {"ok": False, "error": {"message": str(exc)}})
