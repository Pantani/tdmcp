import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createNuitrackBodyBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the Nuitrack body-bus container is created."),
  name: z.string().default("nuitrack_body_bus").describe("Name of the generated baseCOMP."),
  source: z
    .enum(["osc", "websocket", "tcp_json", "sample"])
    .default("osc")
    .describe("Transport for Nuitrack skeleton data."),
  listen_port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(7007)
    .describe("Local port for OSC/TCP skeleton input."),
  server_url: z
    .string()
    .default("ws://127.0.0.1:8767")
    .describe("WebSocket URL when source is websocket."),
  joint_set: z
    .enum(["upper_body", "full_body", "hands"])
    .default("full_body")
    .describe("Joint subset to expose as normalized body channels."),
  max_bodies: z.coerce
    .number()
    .int()
    .min(1)
    .max(6)
    .default(2)
    .describe("Maximum tracked bodies exposed in the output CHOP contract."),
  channel_prefix: z
    .string()
    .default("body")
    .describe("Prefix for output CHOP channels, e.g. body0_head_x."),
  active: z.boolean().default(false).describe("Start the transport active where supported."),
});

type CreateNuitrackBodyBusArgs = z.infer<typeof createNuitrackBodyBusSchema>;

export interface NuitrackBodyBusReport {
  container_path?: string;
  source?: CreateNuitrackBodyBusArgs["source"];
  joint_set?: CreateNuitrackBodyBusArgs["joint_set"];
  receiver?: string;
  raw_skeleton?: string;
  body_bus?: string;
  status_dat?: string;
  setup_dat?: string;
  channels?: string[];
  warnings: string[];
  fatal?: string;
}

const NUITRACK_BODY_BUS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "source": _p.get("source"),
    "joint_set": _p.get("joint_set"),
    "channels": [],
    "warnings": [],
}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0, exclude=None):
    try:
        occupied = set()
        for child in parent.children:
            if exclude is not None and getattr(child, "path", None) == getattr(exclude, "path", None):
                continue
            try:
                if abs(float(child.nodeY) - float(y)) < 1.0:
                    occupied.add(round(float(child.nodeX) / step) * step)
            except Exception:
                continue
        x = float(start)
        while round(x / step) * step in occupied:
            x += step
        return x
    except Exception:
        return float(start)

def _or_create(parent, name, optype):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(optype, name)

def _setpar(node, par_name, value, warn=True):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        if warn:
            _warn("No parameter '%s' on %s" % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        if warn:
            _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _connect(src, dst, input_index=0):
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (getattr(src, "name", src), getattr(dst, "name", dst), exc))
        return False

JOINTS = {
    "hands": ["left_hand", "right_hand"],
    "upper_body": ["head", "neck", "torso", "left_shoulder", "right_shoulder", "left_hand", "right_hand"],
    "full_body": ["head", "neck", "torso", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand", "left_knee", "right_knee", "left_foot", "right_foot"],
}

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container_path"] = comp.path

        mode = _p.get("source", "osc")
        receiver = None
        if mode == "osc":
            receiver = _or_create(comp, "nuitrack_osc", oscinCHOP)
            _setpar(receiver, "port", int(_p["listen_port"]))
            _setpar(receiver, "active", 1 if _p.get("active") else 0, warn=False)
        elif mode == "websocket":
            receiver = _or_create(comp, "nuitrack_ws", websocketDAT)
            _setpar(receiver, "active", 1 if _p.get("active") else 0, warn=False)
            _warn("websocket URL parsing and callback payload shape must be validated against the live Nuitrack sender.")
        elif mode == "tcp_json":
            receiver = _or_create(comp, "nuitrack_tcp", tcpipDAT)
            _setpar(receiver, "port", int(_p["listen_port"]))
            _setpar(receiver, "active", 1 if _p.get("active") else 0, warn=False)
        else:
            receiver = _or_create(comp, "sample_skeleton", tableDAT)
            receiver.clear()
            receiver.appendRow(["body", "joint", "x", "y", "z", "confidence"])
            receiver.appendRow([0, "head", 0.5, 0.8, 0.0, 1.0])
            receiver.appendRow([0, "left_hand", 0.3, 0.55, 0.0, 1.0])
            receiver.appendRow([0, "right_hand", 0.7, 0.55, 0.0, 1.0])
        _place(receiver, 0, 0)
        report["receiver"] = receiver.path

        raw = _or_create(comp, "raw_skeleton", tableDAT)
        _place(raw, 260, 0)
        raw.clear()
        raw.appendRow(["body", "joint", "x", "y", "z", "confidence"])
        report["raw_skeleton"] = raw.path

        normalizer = _or_create(comp, "normalize_script", scriptCHOP)
        _place(normalizer, 520, 0)

        joints = JOINTS.get(_p.get("joint_set", "full_body"), JOINTS["full_body"])
        channels = []
        for b in range(int(_p["max_bodies"])):
            for joint in joints:
                for axis in ("x", "y", "z", "confidence"):
                    channels.append("%s%d_%s_%s" % (_p.get("channel_prefix", "body"), b, joint, axis))
        report["channels"] = channels

        body_bus = _or_create(comp, "body_bus", nullCHOP)
        _place(body_bus, 780, 0)
        _connect(normalizer, body_bus)
        report["body_bus"] = body_bus.path

        status = _or_create(comp, "status", tableDAT)
        _place(status, 0, -220)
        status.clear()
        status.appendRow(["field", "value"])
        status.appendRow(["source", str(mode)])
        status.appendRow(["joint_set", str(_p.get("joint_set"))])
        status.appendRow(["max_bodies", str(_p.get("max_bodies"))])
        status.appendRow(["active", str(bool(_p.get("active")))])
        report["status_dat"] = status.path

        notes = _or_create(comp, "setup_notes", textDAT)
        _place(notes, 260, -220)
        notes.text = (
            "Nuitrack body bus scaffold. Install and calibrate Nuitrack separately, then map its "
            "OSC/WebSocket/TCP JSON skeleton payload into raw_skeleton/normalize_script. Output "
            "contract is the body_bus CHOP channel list in the report."
        )
        report["setup_dat"] = notes.path
        _warn("Live Nuitrack SDK, license, camera calibration, and joint naming were not validated by this offline scaffold.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildNuitrackBodyBusScript(payload: object): string {
  return buildPayloadScript(NUITRACK_BODY_BUS_SCRIPT, payload);
}

export async function createNuitrackBodyBusImpl(ctx: ToolContext, args: CreateNuitrackBodyBusArgs) {
  const script = buildNuitrackBodyBusScript({
    parent_path: args.parent_path,
    name: args.name,
    source: args.source,
    listen_port: args.listen_port,
    server_url: args.server_url,
    joint_set: args.joint_set,
    max_bodies: args.max_bodies,
    channel_prefix: args.channel_prefix,
    active: args.active,
  });

  return guardTd(
    async () =>
      parsePythonReport<NuitrackBodyBusReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create Nuitrack body bus: ${report.fatal}`, report);
      }
      return jsonResult(
        `Created Nuitrack body bus ${report.container_path} with output ${report.body_bus} (${report.channels?.length ?? 0} channels, ${report.warnings.length} warning(s)).`,
        report,
      );
    },
  );
}

export const registerCreateNuitrackBodyBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_nuitrack_body_bus",
    {
      title: "Create Nuitrack body bus",
      description:
        "Create a TouchDesigner scaffold for Nuitrack skeleton data over OSC, WebSocket, TCP JSON, or sample mode. Produces a stable body_bus CHOP contract and setup notes; live SDK/device calibration must be validated separately.",
      inputSchema: createNuitrackBodyBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createNuitrackBodyBusImpl(ctx, args),
  );
};
