"""Broadcast TD-side events to all connected WebSocket clients.

Events use the shape { "event": "<name>", "data": <payload> }, matching what the
Node server's event stream expects.
"""

import json


def broadcast(webserver, event, data=None):
    if webserver is None:
        return
    try:
        message = json.dumps({"event": event, "data": data})
    except Exception:  # noqa: BLE001
        return
    try:
        connections = webserver.webSocketConnections or []
    except Exception:  # noqa: BLE001
        return
    for client in connections:
        try:
            webserver.webSocketSendText(client, message)
        except Exception:  # noqa: BLE001
            pass
