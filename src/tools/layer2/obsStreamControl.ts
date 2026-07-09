import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const obsStreamControlSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to build the OBS control rig in."),
  name: z.string().default("obs_stream_control").describe("Name of the created/reused baseCOMP."),
  host: z.string().default("127.0.0.1").describe("OBS WebSocket host/IP."),
  port: z.coerce.number().int().min(1).max(65535).default(4455).describe("OBS WebSocket port."),
  use_tls: z.boolean().default(false).describe("Use wss:// instead of ws://."),
  auto_connect: z
    .boolean()
    .default(false)
    .describe("Start the websocketDAT active immediately. Defaults false for show safety."),
  include_recording: z
    .boolean()
    .default(true)
    .describe("Also create StartRecord, StopRecord, and ToggleRecord controls."),
  scenes: z
    .array(z.string().min(1))
    .max(24)
    .default([])
    .describe(
      "Optional OBS scene names. Each creates a scene_* control that sends SetCurrentProgramScene.",
    ),
  auth_required: z
    .boolean()
    .default(false)
    .describe(
      "Set true only as a reminder that OBS WebSocket authentication must be completed manually; tdmcp never stores an OBS password.",
    ),
});
export type ObsStreamControlArgs = z.infer<typeof obsStreamControlSchema>;

interface ObsCommandPayload {
  channel: string;
  label: string;
  request_type: string;
  request_data: Record<string, unknown>;
}

interface ObsStreamControlReport {
  container?: string;
  websocket?: string;
  controls?: string;
  dispatch_dat?: string;
  requests_dat?: string;
  endpoint?: string;
  commands: ObsCommandPayload[];
  command_channels: string[];
  auth_note: string;
  warnings: string[];
  fatal?: string;
}

function commandName(value: string, fallback: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const seeded = safe || fallback;
  return /^[a-z_]/.test(seeded) ? seeded : `s_${seeded}`;
}

function uniqueChannel(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

export function buildObsCommandPayload(args: ObsStreamControlArgs): ObsCommandPayload[] {
  const commands: ObsCommandPayload[] = [
    {
      channel: "start_stream",
      label: "Start Stream",
      request_type: "StartStream",
      request_data: {},
    },
    {
      channel: "stop_stream",
      label: "Stop Stream",
      request_type: "StopStream",
      request_data: {},
    },
    {
      channel: "toggle_stream",
      label: "Toggle Stream",
      request_type: "ToggleStream",
      request_data: {},
    },
  ];
  if (args.include_recording) {
    commands.push(
      {
        channel: "start_record",
        label: "Start Recording",
        request_type: "StartRecord",
        request_data: {},
      },
      {
        channel: "stop_record",
        label: "Stop Recording",
        request_type: "StopRecord",
        request_data: {},
      },
      {
        channel: "toggle_record",
        label: "Toggle Recording",
        request_type: "ToggleRecord",
        request_data: {},
      },
    );
  }
  const used = new Set(commands.map((command) => command.channel));
  for (const scene of args.scenes) {
    const channel = uniqueChannel(`scene_${commandName(scene, "scene")}`, used);
    commands.push({
      channel,
      label: `Scene: ${scene}`,
      request_type: "SetCurrentProgramScene",
      request_data: { sceneName: scene },
    });
  }
  return commands;
}

const OBS_STREAM_CONTROL_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "commands": list(_p.get("commands") or []),
    "command_channels": [c.get("channel") for c in (_p.get("commands") or [])],
    "auth_note": "OBS passwords are intentionally not stored. If OBS WebSocket auth is enabled, add the Identify auth response in obs_dispatch manually.",
    "warnings": [],
}

def _place(node, x, y):
    try:
        node.nodeX = int(x)
        node.nodeY = int(y)
    except Exception:
        pass

def _place_container(parent, container):
    try:
        cw, ch, rows = 260, 200, 6
        def _cell(child):
            return (
                round((child.nodeX + child.nodeWidth / 2.0) / cw),
                round(-(child.nodeY + child.nodeHeight / 2.0) / ch),
            )
        occupied = {_cell(child) for child in parent.children if child is not container}
        k = 0
        while (k // rows, k % rows) in occupied:
            k += 1
        container.nodeX = (k // rows) * cw
        container.nodeY = -((k % rows) * ch)
    except Exception:
        pass

def _setpar(node, name, value, warn=True):
    try:
        par = getattr(node.par, name, None)
        if par is None:
            if warn:
                report["warnings"].append("No parameter %s on %s" % (name, getattr(node, "path", node)))
            return False
        par.val = value
        return True
    except Exception:
        if warn:
            report["warnings"].append("Could not set %s on %s" % (name, getattr(node, "path", node)))
        return False

def _set_first(node, pairs):
    for name, value in pairs:
        if _setpar(node, name, value, warn=False):
            return True
    report["warnings"].append("Could not set any of %s on %s" % ([p[0] for p in pairs], getattr(node, "path", node)))
    return False

_DISPATCH_CODE = r"""
import json
import time

def _request_payload(request_type, request_data=None):
    return {
        "op": 6,
        "d": {
            "requestType": request_type,
            "requestId": "tdmcp_%s_%d" % (request_type, int(time.time() * 1000)),
            "requestData": request_data or {},
        },
    }

def _send_json(ws, payload):
    message = json.dumps(payload)
    if hasattr(ws, "sendText"):
        return ws.sendText(message)
    if hasattr(ws, "send"):
        return ws.send(message)
    raise RuntimeError("websocketDAT has no sendText/send method")

def obs_identify():
    ws = parent().op("obs_ws")
    if ws is None:
        raise RuntimeError("obs_ws not found")
    # No-auth OBS WebSocket v5 Identify. If auth is enabled, replace d with the
    # challenge-derived authentication fields from OBS before calling this.
    _send_json(ws, {"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}})

def obs_request(request_type, request_data=None):
    ws = parent().op("obs_ws")
    if ws is None:
        raise RuntimeError("obs_ws not found")
    _send_json(ws, _request_payload(request_type, request_data))

def _commands():
    dat = parent().op("obs_requests")
    if dat is None:
        return []
    try:
        return json.loads(dat.text).get("commands", [])
    except Exception:
        return []

def dispatch_channel(channel_name):
    for command in _commands():
        if command.get("channel") != channel_name:
            continue
        obs_request(command.get("request_type"), command.get("request_data") or {})
        parent().store("tdmcp_obs_last_command", command)
        return command
    return None

def onOffToOn(channel, sampleIndex, val, prev):
    dispatch_channel(channel.name)
    return

def onConnect(websocketDAT):
    parent().store("tdmcp_obs_ws_status", "connected")
    try:
        obs_identify()
    except Exception as exc:
        parent().store("tdmcp_obs_identify_error", str(exc))
    return

def onDisconnect(websocketDAT):
    parent().store("tdmcp_obs_ws_status", "disconnected")
    return

def onReceiveText(websocketDAT, rowIndex, message):
    parent().store("tdmcp_obs_last_message", str(message))
    return
"""

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    elif not hasattr(parent, "create"):
        report["fatal"] = str(_p["parent_path"]) + " is not a COMP."
    else:
        container = parent.op(_p["name"]) or parent.create(baseCOMP, _p["name"])
        _place_container(parent, container)
        report["container"] = container.path

        ws = container.op("obs_ws") or container.create(websocketDAT, "obs_ws")
        controls = container.op("obs_controls") or container.create(constantCHOP, "obs_controls")
        dispatch = container.op("obs_dispatch") or container.create(chopexecuteDAT, "obs_dispatch")
        requests = container.op("obs_requests") or container.create(textDAT, "obs_requests")

        _place(ws, 0, 0)
        _place(controls, 0, -140)
        _place(dispatch, 260, -140)
        _place(requests, 520, -140)

        url = _p["endpoint"]
        report["endpoint"] = url
        report["websocket"] = ws.path
        report["controls"] = controls.path
        report["dispatch_dat"] = dispatch.path
        report["requests_dat"] = requests.path

        _set_first(ws, [("url", url), ("address", url), ("networkaddress", _p["host"]), ("netaddress", _p["host"])])
        _setpar(ws, "port", int(_p["port"]), warn=False)
        _setpar(ws, "active", 1 if _p.get("auto_connect") else 0, warn=False)
        _setpar(ws, "autoreconnect", 1, warn=False)
        _setpar(ws, "reconnectinterval", 2.0, warn=False)

        for idx, command in enumerate(_p.get("commands") or []):
            _setpar(controls, "name%d" % idx, command.get("channel"))
            _setpar(controls, "value%d" % idx, 0)

        requests.text = json.dumps(
            {
                "protocol": "obs-websocket-v5",
                "identify_no_auth": {"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}},
                "request_op": 6,
                "commands": _p.get("commands") or [],
            },
            indent=2,
        )
        dispatch.text = _DISPATCH_CODE
        _setpar(dispatch, "chop", controls.name)
        _setpar(dispatch, "active", 1, warn=False)
        _setpar(dispatch, "offtoon", 1, warn=False)
        _setpar(ws, "callbacks", dispatch.name, warn=False)

        if _p.get("auth_required"):
            report["auth_note"] = (
                "OBS auth_required=true: tdmcp did not store a password. Complete obs-websocket authentication manually in obs_dispatch."
            )
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildObsStreamControlScript(payload: object): string {
  return buildPayloadScript(OBS_STREAM_CONTROL_SCRIPT, payload);
}

export async function obsStreamControlImpl(ctx: ToolContext, args: ObsStreamControlArgs) {
  const commands = buildObsCommandPayload(args);
  const endpoint = `${args.use_tls ? "wss" : "ws"}://${args.host}:${args.port}`;
  return guardTd(
    async () => {
      const script = buildObsStreamControlScript({
        parent_path: args.parent_path,
        name: args.name,
        host: args.host,
        port: args.port,
        endpoint,
        auto_connect: args.auto_connect,
        auth_required: args.auth_required,
        commands,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ObsStreamControlReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build OBS stream control: ${report.fatal}`, report);
      }
      const warningSuffix = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      return jsonResult(
        `Built OBS stream control ${report.container} for ${report.endpoint} with ${report.command_channels.length} command channel(s)${warningSuffix}.`,
        report,
      );
    },
  );
}

export const registerObsStreamControl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "obs_stream_control",
    {
      title: "OBS stream control",
      description:
        "Create an OBS WebSocket v5 control rig in TouchDesigner: websocketDAT connection, Constant CHOP command channels for stream/record/scene actions, and a chopExecute DAT that dispatches op:6 request payloads such as StartStream, StopStream, ToggleStream, StartRecord, StopRecord, ToggleRecord, and SetCurrentProgramScene. tdmcp never accepts or stores OBS passwords; if OBS authentication is enabled, complete Identify authentication manually in the generated obs_dispatch DAT.",
      inputSchema: obsStreamControlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => obsStreamControlImpl(ctx, args),
  );
};
