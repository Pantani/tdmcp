# WebServer DAT callbacks for the tdmcp bridge.
#
# Setup:
#   1. Copy the `td/modules` folder into your TD project, e.g. <project>/tdmcp/modules.
#   2. Add a Web Server DAT, set its port to 9980 (matches TDMCP_TD_PORT).
#   3. Point the Web Server DAT's callbacks at this file (or paste its contents).
#
# The path below assumes <project>/tdmcp/modules — adjust _MODULES if you put it
# somewhere else.

import os
import sys

_MODULES = os.path.join(project.folder, "tdmcp", "modules")  # noqa: F821 - TD global
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.controllers import api_controller  # noqa: E402


def onHTTPRequest(webServerDAT, request, response):
    return api_controller.handle(request, response)


def onWebSocketOpen(webServerDAT, client, uri):
    return


def onWebSocketReceiveText(webServerDAT, client, data):
    return


def onWebSocketReceiveBinary(webServerDAT, client, data):
    return


def onWebSocketReceivePing(webServerDAT, client, data):
    webServerDAT.webSocketSendPong(client, data=data)


def onWebSocketReceivePong(webServerDAT, client, data):
    return


def onServerStart(webServerDAT):
    return


def onServerStop(webServerDAT):
    return
