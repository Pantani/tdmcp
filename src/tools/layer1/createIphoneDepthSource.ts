import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createIphoneDepthSourceSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP to create the scaffold in."),
  name: z.string().default("iphone_depth_source").describe("Name for the generated base COMP."),
  source: z
    .enum(["tdlidar", "record3d", "generic_ndi_osc"])
    .default("tdlidar")
    .describe("iPhone depth sender profile to document in setup hints."),
  video_mode: z
    .enum(["ndi", "syphon_spout", "movie_file"])
    .default("ndi")
    .describe("Transport for the color/depth video stream."),
  video_source_name: z
    .string()
    .optional()
    .describe("NDI source name or Syphon/Spout sender name when using a live video transport."),
  movie_file: z.string().optional().describe("Movie file path used when video_mode is movie_file."),
  osc_port: z.coerce
    .number()
    .int()
    .default(9002)
    .describe("UDP port for OSC sensor data from the iPhone app."),
  sensor_prefix: z
    .string()
    .default("/iphone")
    .describe("OSC address prefix used to select phone sensor channels."),
  create_pointcloud_stub: z
    .boolean()
    .default(true)
    .describe("Create a textDAT placeholder for app-specific point-cloud reconstruction notes."),
  active: z
    .boolean()
    .default(false)
    .describe("Start the live/video receiver immediately where the operator supports it."),
});
type CreateIphoneDepthSourceArgs = z.infer<typeof createIphoneDepthSourceSchema>;

interface IphoneDepthSourceReport {
  source: string;
  video_mode: string;
  comp?: string;
  receiver?: string;
  outputs?: {
    color?: string;
    depth?: string;
    sensors?: string;
  };
  nodes: Array<{
    path: string;
    type: string;
    name: string;
    x: number;
    y: number;
  }>;
  warnings: string[];
  fatal?: string;
}

const IPHONE_DEPTH_SOURCE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "source": _p["source"],
    "video_mode": _p["video_mode"],
    "nodes": [],
    "outputs": {},
    "warnings": [],
}

def _warn(msg):
    report["warnings"].append(str(msg))

def _set_pos(node, x, y):
    try:
        node.nodeX = int(x)
        node.nodeY = int(y)
    except Exception as e:
        _warn("Could not place " + getattr(node, "path", str(node)) + ": " + str(e))
    _place_generated_callbacks(node, int(x) + 140, int(y) - 120)

def _place_generated_callbacks(node, x, y):
    try:
        parent = node.parent()
        callback = parent.op(node.name + "_callbacks")
        if callback is not None and callback.path != node.path:
            callback.nodeX = int(x)
            callback.nodeY = int(y)
    except Exception:
        pass

def _remember(node, x, y):
    report["nodes"].append({
        "path": node.path,
        "type": node.type,
        "name": node.name,
        "x": int(x),
        "y": int(y),
    })

def _create(parent, kind, name, x, y):
    node = parent.create(kind, name)
    _set_pos(node, x, y)
    _remember(node, x, y)
    return node

def _optype(name, fallback=None):
    found = globals().get(name)
    if found is not None:
        return found
    if fallback is not None:
        _warn(name + " is not available in this TouchDesigner build; using fallback placeholder.")
        return fallback
    raise NameError("operator type not available: " + str(name))

def _setpar(node, parname, val):
    if val is None:
        return
    par = getattr(node.par, parname, None)
    if par is None:
        _warn("No parameter '" + parname + "' on " + node.path)
        return
    try:
        par.val = val
    except Exception as e:
        _warn("Could not set " + node.path + "." + parname + ": " + str(e))

def _connect(dst, src):
    try:
        dst.inputConnectors[0].connect(src)
    except Exception as e:
        _warn("Could not connect " + src.path + " to " + dst.path + ": " + str(e))

def _source_warning(source):
    if source == "tdlidar":
        return "TDLidar stream names, depth encoding, and OSC channels vary by app version; validate this scaffold against the live phone sender."
    if source == "record3d":
        return "Record3D can publish color/depth differently by transport; validate stream naming, depth packing, and OSC channels live."
    return "Generic NDI/OSC iPhone senders need live validation for stream names, depth encoding, and sensor channel names."

try:
    report["warnings"].append(_source_warning(_p["source"]))
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        try:
            _existing_count = len(_parent.children)
        except Exception:
            _existing_count = 0
        _comp = _parent.create(_optype("baseCOMP"), _p["name"])
        _set_pos(_comp, _existing_count * 260, -180)
        _remember(_comp, _comp.nodeX, _comp.nodeY)
        report["comp"] = _comp.path

        _moviefile_type = _optype("moviefileinTOP")
        _video_types = {
            "ndi": _optype("ndiinTOP", _moviefile_type),
            "syphon_spout": _optype("syphonspoutinTOP", _moviefile_type),
            "movie_file": _moviefile_type,
        }
        _video = _create(_comp, _video_types[_p["video_mode"]], "video_in", 0, 0)
        report["receiver"] = _video.path
        if _p["video_mode"] == "ndi":
            _setpar(_video, "name", _p.get("video_source_name"))
            _setpar(_video, "active", bool(_p.get("active")))
        elif _p["video_mode"] == "syphon_spout":
            _setpar(_video, "sendername", _p.get("video_source_name"))
            _setpar(_video, "active", bool(_p.get("active")))
        elif _p["video_mode"] == "movie_file":
            if not _p.get("movie_file"):
                _warn("movie_file should be set when video_mode is movie_file.")
            _setpar(_video, "file", _p.get("movie_file"))
            _setpar(_video, "play", bool(_p.get("active")))

        _color = _create(_comp, _optype("nullTOP"), "color_out", 260, 0)
        _connect(_color, _video)

        _depth_level = _create(_comp, _optype("levelTOP"), "depth_level", 0, -180)
        _connect(_depth_level, _video)
        _depth_mono = _create(_comp, _optype("monochromeTOP"), "depth_mono", 260, -180)
        _connect(_depth_mono, _depth_level)
        _depth_out = _create(_comp, _optype("nullTOP"), "depth_out", 520, -180)
        _connect(_depth_out, _depth_mono)

        _sensors_in = _create(_comp, _optype("oscinCHOP"), "sensors_in", 0, -380)
        _setpar(_sensors_in, "port", _p["osc_port"])
        _sensors_select = _create(_comp, _optype("selectCHOP"), "sensor_select", 260, -380)
        _connect(_sensors_select, _sensors_in)
        _setpar(_sensors_select, "channames", str(_p["sensor_prefix"]) + "*")
        _sensors_out = _create(_comp, _optype("nullCHOP"), "sensors_out", 520, -380)
        _connect(_sensors_out, _sensors_select)

        _info = _create(_comp, _optype("textDAT"), "setup_hints", 0, -600)
        _info.text = "\\n".join([
            "iPhone depth source scaffold",
            "source: " + str(_p["source"]),
            "video mode: " + str(_p["video_mode"]),
            "video source: " + str(_p.get("video_source_name") or _p.get("movie_file") or "(set in operator)"),
            "OSC port: " + str(_p["osc_port"]),
            "sensor prefix: " + str(_p["sensor_prefix"]),
            "Outputs: color_out TOP, depth_out TOP, sensors_out CHOP.",
            "Point-cloud reconstruction depends on the sender/app depth format and should be validated live.",
        ])

        if bool(_p.get("create_pointcloud_stub")):
            _stub = _create(_comp, _optype("textDAT"), "pointcloud_stub", 260, -600)
            _stub.text = "\\n".join([
                "Placeholder for point-cloud reconstruction.",
                "Use color_out + depth_out + sender-specific intrinsics once the live app format is confirmed.",
                "Record3D, TDLidar, and generic NDI/OSC senders do not expose identical depth packing.",
            ])

        report["outputs"] = {
            "color": _color.path,
            "depth": _depth_out.path,
            "sensors": _sensors_out.path,
        }
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(result))
`;

export function buildIphoneDepthSourceScript(payload: object): string {
  return buildPayloadScript(IPHONE_DEPTH_SOURCE_SCRIPT, payload);
}

export async function createIphoneDepthSourceImpl(
  ctx: ToolContext,
  args: CreateIphoneDepthSourceArgs,
) {
  return guardTd(
    async () => {
      const script = buildIphoneDepthSourceScript({
        parent_path: args.parent_path,
        name: args.name,
        source: args.source,
        video_mode: args.video_mode,
        video_source_name: args.video_source_name ?? null,
        movie_file: args.movie_file ?? null,
        osc_port: args.osc_port,
        sensor_prefix: args.sensor_prefix,
        create_pointcloud_stub: args.create_pointcloud_stub,
        active: args.active,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<IphoneDepthSourceReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create iPhone depth source: ${report.fatal}`, report);
      }
      const warnings = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
      return jsonResult(
        `Created iPhone depth source ${report.comp} with color_out, depth_out, and sensors_out${warnings}.`,
        report,
      );
    },
  );
}

export const registerCreateIphoneDepthSource: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_iphone_depth_source",
    {
      title: "Create iPhone depth source",
      description:
        "Create a deterministic TouchDesigner scaffold for iPhone depth senders such as TDLidar, Record3D, or a generic NDI/OSC source. Builds live/video receiver TOPs, color_out, depth_out, OSC sensor input, sensors_out, setup hints, and an optional point-cloud placeholder. This is a scaffold and returns warnings where the sender format must be validated live.",
      inputSchema: createIphoneDepthSourceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createIphoneDepthSourceImpl(ctx, args),
  );
};
