import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  buildExternalSensorStatusChopCode,
  buildExternalSensorStatusDriverDatCode,
} from "./externalSensorStatusSurface.js";

const DEFAULT_FREQUENCIES = [
  130.81, 146.83, 164.81, 196, 220, 246.94, 261.63, 293.66, 329.63, 392, 440, 493.88, 523.25,
  587.33, 659.25, 783.99,
];

function assertRawTripleQuotedPythonSafe(label: string, code: string): string {
  if (code.includes("'''")) {
    throw new Error(`${label} cannot be embedded in a raw triple-single-quoted Python string`);
  }
  if (code.endsWith("\\")) {
    throw new Error(`${label} cannot end with a trailing backslash`);
  }
  return code;
}

const KINECT_BRIDGE_STATUS_DRIVER_DAT_CODE = assertRawTripleQuotedPythonSafe(
  "Kinect bridge status driver DAT code",
  buildExternalSensorStatusDriverDatCode({
    parameterName: "Bridgestatusjson",
    statusChopName: "bridge_status_chop",
    statusDatName: "bridge_status",
    statusJsonPlaceholder: "__BRIDGE_STATUS_JSON__",
    storeKey: "tdmcp_bridge_status",
  }),
);

const KINECT_BRIDGE_STATUS_CHOP_CODE = assertRawTripleQuotedPythonSafe(
  "Kinect bridge status CHOP code",
  buildExternalSensorStatusChopCode({
    channelPrefix: "bridge",
    storeKey: "tdmcp_bridge_status",
  }),
);

export const createKinectWallHarpSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the isolated kinect_wall_harp Base COMP is created."),
  name: z
    .string()
    .default("kinect_wall_harp")
    .describe("Name for the generated Base COMP under parent_path."),
  source: z
    .enum(["freenect", "synthetic", "osc_kinect"])
    .default("freenect")
    .describe(
      "Input source. 'freenect' tries the FreenectTD FreenectTOP Kinect v2 path; 'synthetic' builds a device-free wall-touch simulator; 'osc_kinect' listens for normalized Kinect hand points from an external OSC bridge.",
    ),
  osc_port: z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .default(7400)
    .describe("UDP port for OSC Kinect hand input when source='osc_kinect'."),
  bridge_status_json: z
    .string()
    .default("_workspace/kinect-wall-harp/bridge-status.json")
    .describe(
      "JSON status path written by scripts/kinect-wall-harp-bridge.mjs --status-json and read by the generated bridge_status DAT.",
    ),
  fallback_to_synthetic: z
    .boolean()
    .default(true)
    .describe(
      "When true, missing FreenectTD/Kinect hardware still creates a playable synthetic fallback with warnings.",
    ),
  deactivate_existing_freenect: z
    .boolean()
    .default(true)
    .describe(
      "Deactivate existing FreenectTOP nodes under parent_path before starting the new Kinect source. Kinect v2 is a single-device path, so this avoids multiple active FreenectTD nodes competing for the same sensor.",
    ),
  activate_freenect: z
    .boolean()
    .default(false)
    .describe(
      "Safety gate for actually creating/activating FreenectTOP. Default false because FreenectTD Kinect v2 initialization is unstable on the validated macOS setup; leave false for crash-safe synthetic fallback.",
    ),
  output_width: z.coerce
    .number()
    .int()
    .positive()
    .default(1280)
    .describe("Width for generated debug and projected output TOPs."),
  output_height: z.coerce
    .number()
    .int()
    .positive()
    .default(720)
    .describe("Height for generated debug and projected output TOPs."),
  wall_depth_center: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Normalized depth value representing the calibrated wall/touch plane."),
  touch_thickness: z.coerce
    .number()
    .min(0.001)
    .max(1)
    .default(0.08)
    .describe("Accepted depth band around wall_depth_center."),
  depth_polarity: z
    .enum(["near", "far"])
    .default("near")
    .describe("Which side of the wall-depth band should count as touch candidates."),
  sensitivity: z.coerce
    .number()
    .min(0)
    .max(4)
    .default(0.65)
    .describe("Blob threshold / cleanup aggressiveness for the wall-touch mask."),
  smoothing: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.18)
    .describe("Hand centroid smoothing amount used by the tracking Script CHOP."),
  crop_left: z.coerce.number().min(0).max(1).default(0),
  crop_right: z.coerce.number().min(0).max(1).default(1),
  crop_top: z.coerce.number().min(0).max(1).default(0),
  crop_bottom: z.coerce.number().min(0).max(1).default(1),
  input_mirror_x: z
    .boolean()
    .default(false)
    .describe("Mirror normalized hand X after OSC input, before projector-space calibration."),
  input_left: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Raw normalized Kinect X that maps to the projector's left edge."),
  input_right: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Raw normalized Kinect X that maps to the projector's right edge."),
  input_top: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Raw normalized Kinect Y that maps to the projector's top edge."),
  input_bottom: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Raw normalized Kinect Y that maps to the projector's bottom edge."),
  show_debug: z
    .boolean()
    .default(false)
    .describe("When true, the visual Script TOP draws hand dots and zone guides."),
  calibration_hold_ms: z.coerce
    .number()
    .int()
    .min(200)
    .max(3000)
    .default(900)
    .describe(
      "Milliseconds a hand must remain stable on a calibration target before auto-capture.",
    ),
  string_count: z.coerce
    .number()
    .int()
    .min(8)
    .max(32)
    .default(16)
    .describe("Number of musical trigger zones across the projected wall harp."),
  visual_line_count: z.coerce
    .number()
    .int()
    .min(8)
    .max(192)
    .default(128)
    .describe(
      "Number of visible projected laser lines. Can exceed string_count for curtain behavior.",
    ),
  curtain_spread: z.coerce
    .number()
    .min(0)
    .max(12)
    .default(3.2)
    .describe("How many neighboring visual lines share vibration from each musical zone."),
  curtain_follow: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("How strongly nearby visual lines bend around tracked wall-touch hands."),
  cooldown_ms: z.coerce
    .number()
    .int()
    .min(40)
    .max(1000)
    .default(150)
    .describe("Per-string retrigger guard in milliseconds."),
  frequencies: z
    .array(z.coerce.number().positive())
    .min(8)
    .max(32)
    .default(DEFAULT_FREQUENCIES)
    .describe("Pluck frequencies for the musical trigger zones."),
  master_volume: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe("Overall gain for the internal pluck Script CHOP."),
  audio_device: z
    .string()
    .default("")
    .describe(
      "Optional Audio Device Out device name. Leave empty to keep TouchDesigner's default device.",
    ),
  audio_sample_rate: z.coerce
    .number()
    .int()
    .min(8000)
    .max(192000)
    .default(48000)
    .describe("Script CHOP audio sample rate. Set to 192000 when using UMC202HD at 192k."),
  decay: z.coerce
    .number()
    .min(0.03)
    .max(3)
    .default(0.45)
    .describe("Electronic pluck decay in seconds."),
  brightness: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.08)
    .describe("Very subtle harmonic color for the generated sine pluck tone."),
  reverb_mix: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.22)
    .describe("Wet reverb mix for the internal pluck synth."),
  reverb_decay: z.coerce
    .number()
    .min(0)
    .max(0.98)
    .default(0.68)
    .describe("Feedback decay for the internal algorithmic reverb."),
  reverb_damping: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.45)
    .describe("High-frequency damping for the internal algorithmic reverb."),
  base_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#050505")
    .describe("Idle projected string color as #RRGGBB."),
  hit_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#FFB000")
    .describe("Touched string color as #RRGGBB."),
  background_level: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Neutral projected background brightness; 0.0 leaves the wall unlit behind the laser lines.",
    ),
  glow: z.coerce
    .number()
    .min(0)
    .max(3)
    .default(1.25)
    .describe("Visual glow multiplier for active strings."),
  vibration_amount: z.coerce
    .number()
    .min(0)
    .max(64)
    .default(18)
    .describe("Maximum horizontal string vibration in pixels."),
  vibration_decay: z.coerce
    .number()
    .min(0.01)
    .max(3)
    .default(0.7)
    .describe("Visual vibration decay in seconds."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose calibration, harp, audio, and visual controls on the generated COMP."),
});
type CreateKinectWallHarpArgs = z.infer<typeof createKinectWallHarpSchema>;

interface KinectWallHarpReport {
  container: string;
  mode: "freenect_live" | "osc_kinect" | "synthetic" | "synthetic_fallback" | "unavailable";
  output_top: string;
  depth_debug: string;
  mask_debug: string;
  hands_debug: string;
  hands_chop: string;
  harp_chop: string;
  audio_chop: string;
  audio_driver: string;
  audio_out: string;
  status_dat: string;
  bridge_status_dat: string;
  bridge_status_chop: string;
  bridge_status_driver: string;
  bridge_status_json: string;
  string_count: number;
  visual_line_count: number;
  freenect_available: boolean;
  synthetic_fallback: boolean;
  deactivated_existing_freenect: number;
  operators: Array<{ path: string; type: string; role: string }>;
  coordinates: Record<string, [number, number]>;
  warnings: string[];
  fatal?: string;
}

const KINECT_WALL_HARP_SCRIPT = `
import json, base64, traceback, math
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "mode": "unavailable",
    "output_top": "",
    "depth_debug": "",
    "mask_debug": "",
    "hands_debug": "",
    "hands_chop": "",
    "harp_chop": "",
    "audio_chop": "",
    "audio_driver": "",
    "audio_out": "",
    "status_dat": "",
    "bridge_status_dat": "",
    "bridge_status_chop": "",
    "bridge_status_driver": "",
    "bridge_status_json": str(_p.get("bridge_status_json", "")),
    "string_count": int(_p.get("string_count", 8)),
    "visual_line_count": int(_p.get("visual_line_count", _p.get("string_count", 8))),
    "freenect_available": False,
    "synthetic_fallback": False,
    "deactivated_existing_freenect": 0,
    "operators": [],
    "coordinates": {},
    "warnings": [],
}

def _warn(message):
    if message and message not in report["warnings"]:
        report["warnings"].append(str(message))

def _optype(names):
    if isinstance(names, str):
        names = [names]
    for name in names:
        optype = globals().get(name, None)
        if optype is not None:
            return optype, name
    _warn("Operator type unavailable: " + "/".join(names))
    return None, ""

def _place(node, x, y):
    if node is None:
        return None
    try:
        node.nodeX = int(x)
        node.nodeY = int(y)
        report["coordinates"][node.path] = [int(x), int(y)]
    except Exception as exc:
        _warn("Could not place %s: %s" % (getattr(node, "path", node), str(exc)))
    return node

def _create(parent, optypes, name, x, y, role):
    optype, type_name = _optype(optypes)
    if optype is None or parent is None:
        return None
    try:
        node = parent.create(optype, name)
        _place(node, x, y)
        report["operators"].append({"path": node.path, "type": type_name, "role": role})
        return node
    except Exception as exc:
        _warn("Could not create %s %s: %s" % (type_name, name, str(exc)))
        return None

def _connect(src, dst, input_index=0):
    if src is None or dst is None:
        return False
    try:
        dst.inputConnectors[int(input_index)].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (src.path, dst.path, str(exc)))
        return False

def _set_par(node, names, value, required=False):
    if node is None:
        return False
    if isinstance(names, str):
        names = [names]
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is None:
                continue
            setattr(node.par, name, value)
            return True
        except Exception:
            try:
                getattr(node.par, name).val = value
                return True
            except Exception:
                continue
    if required:
        _warn("Could not set parameter %s on %s" % ("/".join(names), node.path))
    return False

def _set_par_expr(node, names, expr, fallback):
    if node is None:
        return False
    if isinstance(names, str):
        names = [names]
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is None:
                continue
            par.expr = expr
            return True
        except Exception:
            continue
    return _set_par(node, names, fallback, False)

def _op_type(node):
    return str(getattr(node, "OPType", None) or getattr(node, "type", "") or "")

def _text_dat(parent, name, x, y, role):
    node = None
    try:
        node = parent.op(name) if parent is not None else None
    except Exception:
        node = None
    if node is not None:
        _place(node, x, y)
        report["operators"].append({"path": node.path, "type": _op_type(node), "role": role})
        return node
    return _create(parent, ["textDAT"], name, x, y, role)

def _deactivate_existing_freenect(parent):
    if parent is None or not bool(_p.get("deactivate_existing_freenect", True)):
        return
    try:
        nodes = []
        stack = [(parent, 0)]
        while stack:
            current, depth = stack.pop()
            if depth >= 10:
                continue
            for child in list(getattr(current, "children", []) or []):
                nodes.append(child)
                stack.append((child, depth + 1))
    except Exception as exc:
        _warn("Could not scan existing FreenectTOP nodes: " + str(exc))
        return
    count = 0
    for node in nodes:
        typ = _op_type(node).lower()
        if "freenect" not in typ:
            continue
        if _set_par(node, ["active", "Active"], False, False):
            count += 1
    report["deactivated_existing_freenect"] = count

def _set_text(dat, text):
    if dat is None:
        return
    try:
        dat.text = text
    except Exception as exc:
        _warn("Could not write text DAT %s: %s" % (dat.path, str(exc)))

def _set_callbacks(script_op, dat):
    if script_op is None or dat is None:
        return
    if not _set_par(script_op, ["callbacks"], dat, False):
        _set_par(script_op, ["callbackdat"], dat.path, False)

def _custom_par(page, method_name, name, default, **kwargs):
    try:
        method = getattr(page, method_name)
        pars = method(name)
        par = pars[0] if isinstance(pars, (list, tuple)) else pars
        try:
            if "label" in kwargs:
                par.label = kwargs["label"]
        except Exception:
            pass
        try:
            if "min" in kwargs:
                par.min = kwargs["min"]
                par.normMin = kwargs["min"]
            if "max" in kwargs:
                par.max = kwargs["max"]
                par.normMax = kwargs["max"]
        except Exception:
            pass
        try:
            if "menu_names" in kwargs:
                par.menuNames = kwargs["menu_names"]
                par.menuLabels = kwargs.get("menu_labels", kwargs["menu_names"])
        except Exception:
            pass
        try:
            par.default = default
        except Exception:
            pass
        try:
            par.val = default
        except Exception:
            pass
    except Exception as exc:
        _warn("Could not expose custom parameter %s: %s" % (name, str(exc)))

def _expose_controls(comp):
    if not bool(_p.get("expose_controls", True)) or comp is None:
        return
    try:
        tracking = comp.appendCustomPage("Tracking")
        _custom_par(tracking, "appendToggle", "Active", True)
        _custom_par(tracking, "appendFloat", "Walldepthcenter", _p["wall_depth_center"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Touchthickness", _p["touch_thickness"], min=0, max=1)
        _custom_par(
            tracking,
            "appendMenu",
            "Depthpolarity",
            _p["depth_polarity"],
            menu_names=["near", "far"],
        )
        _custom_par(tracking, "appendFloat", "Sensitivity", _p["sensitivity"], min=0, max=4)
        _custom_par(tracking, "appendFloat", "Smoothing", _p["smoothing"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Cropleft", _p["crop_left"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Cropright", _p["crop_right"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Croptop", _p["crop_top"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Cropbottom", _p["crop_bottom"], min=0, max=1)
        _custom_par(tracking, "appendToggle", "Inputmirrorx", bool(_p["input_mirror_x"]))
        _custom_par(tracking, "appendFloat", "Inputleft", _p["input_left"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Inputright", _p["input_right"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Inputtop", _p["input_top"], min=0, max=1)
        _custom_par(tracking, "appendFloat", "Inputbottom", _p["input_bottom"], min=0, max=1)
        _custom_par(tracking, "appendToggle", "Showdebug", bool(_p["show_debug"]))
        _custom_par(tracking, "appendStr", "Bridgestatusjson", _p.get("bridge_status_json", ""))
        calibration = comp.appendCustomPage("Calibration")
        _custom_par(calibration, "appendToggle", "Calibrationmode", False)
        _custom_par(calibration, "appendToggle", "Manualcapture", False)
        _custom_par(calibration, "appendToggle", "Resetcalibration", False)
        _custom_par(calibration, "appendInt", "Calibrationholdms", int(_p["calibration_hold_ms"]), min=200, max=3000)
        harp = comp.appendCustomPage("Harp")
        _custom_par(harp, "appendInt", "Stringcount", int(_p["string_count"]), min=8, max=32)
        _custom_par(harp, "appendInt", "Cooldownms", int(_p["cooldown_ms"]), min=40, max=1000)
        audio = comp.appendCustomPage("Audio")
        _custom_par(audio, "appendFloat", "Mastervolume", _p["master_volume"], min=0, max=1)
        _custom_par(audio, "appendInt", "Audiosamplerate", int(_p["audio_sample_rate"]), min=8000, max=192000)
        _custom_par(audio, "appendFloat", "Decay", _p["decay"], min=0.03, max=3)
        _custom_par(audio, "appendFloat", "Brightness", _p["brightness"], min=0, max=1)
        _custom_par(audio, "appendFloat", "Reverbmix", _p.get("reverb_mix", 0.22), min=0, max=1)
        _custom_par(audio, "appendFloat", "Reverbdecay", _p.get("reverb_decay", 0.68), min=0, max=0.98)
        _custom_par(audio, "appendFloat", "Reverbdamping", _p.get("reverb_damping", 0.45), min=0, max=1)
        visual = comp.appendCustomPage("Visual")
        _custom_par(visual, "appendStr", "Basecolor", _p["base_color"])
        _custom_par(visual, "appendStr", "Hitcolor", _p["hit_color"])
        _custom_par(visual, "appendInt", "Visuallinecount", int(_p.get("visual_line_count", _p["string_count"])), min=8, max=192)
        _custom_par(visual, "appendFloat", "Curtainspread", _p.get("curtain_spread", 3.2), min=0, max=12)
        _custom_par(visual, "appendFloat", "Curtainfollow", _p.get("curtain_follow", 0.5), min=0, max=1)
        _custom_par(visual, "appendFloat", "Backgroundlevel", _p["background_level"], min=0, max=1)
        _custom_par(visual, "appendFloat", "Glow", _p["glow"], min=0, max=3)
        _custom_par(visual, "appendFloat", "Vibrationamount", _p["vibration_amount"], min=0, max=64)
        _custom_par(visual, "appendFloat", "Vibrationdecay", _p["vibration_decay"], min=0.01, max=3)
    except Exception as exc:
        _warn("Could not create custom parameter pages: " + str(exc))

MASK_TOP_CODE = r'''
import json, math
try:
    import numpy as np
except Exception:
    np = None
CFG = json.loads(r"""__CFG__""")

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def onCook(scriptOp):
    if np is None:
        return
    width = int(CFG["output_width"])
    height = int(CFG["output_height"])
    mode = CFG["mode"]
    if not _bool_value("Active", True):
        mask = np.zeros((height, width), dtype=np.float32)
    elif mode == "osc_kinect":
        mask = np.zeros((height, width), dtype=np.float32)
    elif mode != "freenect_live":
        t = absTime.seconds
        yy, xx = np.mgrid[0:height, 0:width]
        left = np.exp(-(((xx - (width * (0.28 + 0.08 * math.sin(t * 0.7)))) ** 2) / 2200.0 + ((yy - height * 0.48) ** 2) / 12000.0))
        right = np.exp(-(((xx - (width * (0.72 + 0.07 * math.cos(t * 0.6)))) ** 2) / 2200.0 + ((yy - height * 0.52) ** 2) / 12000.0))
        mask = ((left + right) > 0.35).astype(np.float32)
    else:
        src = scriptOp.inputs[0] if scriptOp.inputs else None
        if src is None:
            mask = np.zeros((height, width), dtype=np.float32)
        else:
            arr = src.numpyArray(delayed=True)
            if arr is None:
                mask = np.zeros((height, width), dtype=np.float32)
            else:
                depth = arr[:, :, 0].astype(np.float32)
                center = float(_active_value("Walldepthcenter", CFG["wall_depth_center"]))
                thick = float(_active_value("Touchthickness", CFG["touch_thickness"]))
                sens = float(_active_value("Sensitivity", CFG["sensitivity"]))
                polarity = str(_active_value("Depthpolarity", CFG["depth_polarity"])).lower()
                if polarity == "near":
                    raw = np.logical_and(depth >= center - thick, depth <= center + (thick * sens))
                else:
                    raw = np.logical_and(depth <= center + thick, depth >= center - (thick * sens))
                mask = raw.astype(np.float32)
    rgba = np.zeros((height, width, 4), dtype=np.float32)
    rgba[:, :, 0] = mask
    rgba[:, :, 1] = mask
    rgba[:, :, 2] = mask
    rgba[:, :, 3] = 1.0
    scriptOp.copyNumpyArray(rgba)
    return
'''

HAND_CHOP_CODE = r'''
import json, math
try:
    import numpy as np
except Exception:
    np = None
CFG = json.loads(r"""__CFG__""")

def _chan(scriptOp, name, value):
    c = scriptOp.appendChan(name)
    c[0] = float(value)

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def _empty_hand():
    return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

def _extract_components(mask):
    if np is None or mask is None or mask.size == 0:
        return []
    h, w = mask.shape
    binary = mask > 0.5
    if not bool(binary.any()):
        return []
    stride = max(1, int(math.ceil(max(h, w) / 180.0)))
    sampled = binary[::stride, ::stride]
    sh, sw = sampled.shape
    visited = np.zeros((sh, sw), dtype=np.bool_)
    components = []
    for y0 in range(sh):
        for x0 in range(sw):
            if visited[y0, x0] or not sampled[y0, x0]:
                continue
            stack = [(x0, y0)]
            visited[y0, x0] = True
            count = 0
            sx = 0.0
            sy = 0.0
            while stack:
                x, y = stack.pop()
                count += 1
                sx += x
                sy += y
                for ny in range(max(0, y - 1), min(sh, y + 2)):
                    for nx in range(max(0, x - 1), min(sw, x + 2)):
                        if visited[ny, nx] or not sampled[ny, nx]:
                            continue
                        visited[ny, nx] = True
                        stack.append((nx, ny))
            if count < 3:
                continue
            cx = ((sx / count) * stride + stride * 0.5) / max(1.0, float(w - 1))
            cy = ((sy / count) * stride + stride * 0.5) / max(1.0, float(h - 1))
            size = min(1.0, float(count * stride * stride) / float(max(1, w * h)))
            components.append((count, (1.0, cx, cy, size, cx, cy, cx, cy)))
    strongest = sorted(components, key=lambda item: item[0], reverse=True)[:2]
    return [item[1] for item in sorted(strongest, key=lambda item: item[1][1])]

def _read_chop_any(src, names, default=0.0):
    if src is None:
        return float(default)
    for name in names:
        try:
            return float(src[name][0])
        except Exception:
            pass
    return float(default)

def _osc_names(prefix, field):
    return [
        prefix + "_" + field,
        prefix + ":" + field,
        prefix + "/" + field,
        "/kinect/" + prefix + "/" + field,
        "kinect/" + prefix + "/" + field,
        "kinect:" + prefix + ":" + field,
        "kinect_" + prefix + "_" + field,
    ]

def _map_axis(value, lo_name, hi_name, lo_default, hi_default):
    lo = max(0.0, min(1.0, float(_active_value(lo_name, lo_default))))
    hi = max(0.0, min(1.0, float(_active_value(hi_name, hi_default))))
    if abs(hi - lo) < 0.001:
        return max(0.0, min(1.0, float(value)))
    return max(0.0, min(1.0, (float(value) - lo) / (hi - lo)))

def _read_osc_hand(src, prefix):
    present = _read_chop_any(src, _osc_names(prefix, "present"), 0.0)
    raw_x = max(0.0, min(1.0, _read_chop_any(src, _osc_names(prefix, "x"), 0.0)))
    raw_y = max(0.0, min(1.0, _read_chop_any(src, _osc_names(prefix, "y"), 0.0)))
    cal_x = raw_x
    if _bool_value("Inputmirrorx", CFG["input_mirror_x"]):
        cal_x = 1.0 - raw_x
    x = _map_axis(cal_x, "Inputleft", "Inputright", CFG["input_left"], CFG["input_right"])
    y = _map_axis(raw_y, "Inputtop", "Inputbottom", CFG["input_top"], CFG["input_bottom"])
    size = max(0.0, min(1.0, _read_chop_any(src, _osc_names(prefix, "size"), 0.0)))
    return (present, x, y, size, raw_x, raw_y, cal_x, raw_y)

def _update_hand_trails(hand_values, now):
    life = 1.35
    trails = parent().fetch("tdmcp_neon_hand_trails", [])
    if not isinstance(trails, list):
        trails = []
    next_trails = []
    for point in trails:
        if not isinstance(point, dict):
            continue
        try:
            if float(now) - float(point.get("time", 0.0)) <= life:
                next_trails.append(point)
        except Exception:
            pass
    for prefix in ("left", "right"):
        if float(hand_values.get(prefix + "_present", 0.0)) <= 0.5:
            continue
        x = max(0.0, min(1.0, float(hand_values.get(prefix + "_x", 0.0))))
        y = max(0.0, min(1.0, float(hand_values.get(prefix + "_y", 0.5))))
        size = max(0.0, min(1.0, float(hand_values.get(prefix + "_size", 0.04))))
        last = parent().fetch("tdmcp_" + prefix + "_last_neon_trail", None)
        should_add = True
        if isinstance(last, dict):
            try:
                dist = math.hypot(x - float(last.get("x", x)), y - float(last.get("y", y)))
                should_add = dist > 0.004 or float(now) - float(last.get("time", 0.0)) > 0.025
            except Exception:
                should_add = True
        if should_add:
            point = {"x": x, "y": y, "size": size, "time": float(now), "side": prefix}
            next_trails.append(point)
            parent().store("tdmcp_" + prefix + "_last_neon_trail", point)
    next_trails = sorted(next_trails, key=lambda point: float(point.get("time", 0.0)))[-144:]
    parent().store("tdmcp_neon_hand_trails", next_trails)
    return next_trails

def onCook(scriptOp):
    scriptOp.clear()
    mode = CFG["mode"]
    if not _bool_value("Active", True):
        left = _empty_hand()
        right = _empty_hand()
    elif mode == "osc_kinect":
        src = op(CFG.get("osc_path", ""))
        left = _read_osc_hand(src, "left")
        right = _read_osc_hand(src, "right")
    elif mode != "freenect_live":
        t = absTime.seconds
        lx = 0.22 + 0.22 * ((math.sin(t * 0.85) + 1.0) * 0.5)
        rx = 0.56 + 0.26 * ((math.cos(t * 0.7) + 1.0) * 0.5)
        left = (1.0, lx, 0.48, 0.08, lx, 0.48, lx, 0.48)
        right = (1.0, rx, 0.52, 0.08, rx, 0.52, rx, 0.52)
    else:
        src = op(CFG["mask_path"])
        arr = src.numpyArray(delayed=True) if src is not None else None
        mask = arr[:, :, 0] if arr is not None and np is not None else None
        components = _extract_components(mask)
        left = components[0] if len(components) >= 1 else _empty_hand()
        right = components[1] if len(components) >= 2 else _empty_hand()
    smoothing = max(0.0, min(1.0, float(_active_value("Smoothing", CFG["smoothing"]))))
    state = scriptOp.fetch("hands_state", None)
    if not isinstance(state, dict):
        state = {}
    smoothed = []
    for prefix, vals in (("left", left), ("right", right)):
        present, x, y, size, raw_x, raw_y, cal_x, cal_y = vals
        prev_x = float(state.get(prefix + "_x", x))
        prev_y = float(state.get(prefix + "_y", y))
        if present > 0.5:
            x = prev_x * smoothing + x * (1.0 - smoothing)
            y = prev_y * smoothing + y * (1.0 - smoothing)
            state[prefix + "_x"] = x
            state[prefix + "_y"] = y
        smoothed.append((prefix, (present, x, y, size, raw_x, raw_y, cal_x, cal_y)))
    scriptOp.store("hands_state", state)
    latest = {}
    for prefix, vals in smoothed:
        latest[prefix + "_present"] = float(vals[0])
        latest[prefix + "_x"] = float(vals[1])
        latest[prefix + "_y"] = float(vals[2])
        latest[prefix + "_size"] = float(vals[3])
        latest[prefix + "_raw_x"] = float(vals[4])
        latest[prefix + "_raw_y"] = float(vals[5])
        latest[prefix + "_cal_x"] = float(vals[6])
        latest[prefix + "_cal_y"] = float(vals[7])
        _chan(scriptOp, prefix + "_present", vals[0])
        _chan(scriptOp, prefix + "_x", vals[1])
        _chan(scriptOp, prefix + "_y", vals[2])
        _chan(scriptOp, prefix + "_size", vals[3])
        _chan(scriptOp, prefix + "_raw_x", vals[4])
        _chan(scriptOp, prefix + "_raw_y", vals[5])
        _chan(scriptOp, prefix + "_cal_x", vals[6])
        _chan(scriptOp, prefix + "_cal_y", vals[7])
    try:
        _update_hand_trails(latest, absTime.seconds)
        parent().store("tdmcp_hands_latest", latest)
    except Exception:
        pass
    return
'''

HARP_CHOP_CODE = r'''
import json, math
CFG = json.loads(r"""__CFG__""")

def _read(src, name, default=0.0):
    try:
        return float(src[name][0])
    except Exception:
        return float(default)

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _read_map(src, name, default=0.0):
    try:
        return float(src.get(name, default))
    except Exception:
        return float(default)

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _read_map(src, name, default=0.0):
    try:
        return float(src.get(name, default))
    except Exception:
        return float(default)

def _read_chop(src, name, default=0.0):
    try:
        return float(src[name][0])
    except Exception:
        return float(default)

def _synthetic_hands(t):
    return {
        "left_present": 1.0,
        "left_x": 0.22 + 0.22 * ((math.sin(t * 0.85) + 1.0) * 0.5),
        "left_y": 0.48,
        "left_size": 0.08,
        "right_present": 1.0,
        "right_x": 0.56 + 0.26 * ((math.cos(t * 0.7) + 1.0) * 0.5),
        "right_y": 0.52,
        "right_size": 0.08,
    }

def _chan(scriptOp, name, value):
    c = scriptOp.appendChan(name)
    c[0] = float(value)

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def _cook_rate(default=60.0):
    try:
        return float(getattr(project, "cookRate", default))
    except Exception:
        return float(default)

def _freq(index):
    freqs = CFG.get("frequencies", [])
    if not isinstance(freqs, list) or len(freqs) == 0:
        return 220.0
    i = max(0, int(index))
    try:
        if i < len(freqs):
            return float(freqs[i])
        return float(freqs[-1]) * (2.0 ** ((i - len(freqs) + 1) / 12.0))
    except Exception:
        return 220.0

def _string_centers(count):
    try:
        value = parent().fetch("tdmcp_string_calibration", None)
        if not isinstance(value, dict) or not value.get("ok"):
            return []
        centers = value.get("raw_centers", [])
        if not isinstance(centers, list) or len(centers) != count:
            return []
        return [max(0.0, min(1.0, float(v))) for v in centers]
    except Exception:
        return []

def _zone_for_hand(src, hand, count):
    if _read_map(src, hand + "_present", 0.0) <= 0.5:
        return -1
    centers = _string_centers(count)
    if centers:
        raw_x = max(0.0, min(1.0, _read_map(src, hand + "_raw_x", _read_map(src, hand + "_x", 0.0))))
        return min(range(count), key=lambda i: abs(raw_x - centers[i]))
    x = max(0.0, min(0.9999, _read_map(src, hand + "_x", 0.0)))
    return int(x * count)

def onCook(scriptOp):
    scriptOp.clear()
    count = max(1, min(32, int(_active_value("Stringcount", CFG["string_count"]))))
    cooldown = float(_active_value("Cooldownms", CFG["cooldown_ms"])) / 1000.0
    now = absTime.seconds
    src = _latest("tdmcp_hands_latest")
    if not src:
        src = _synthetic_hands(now)
    state = scriptOp.fetch("state", None)
    if not isinstance(state, dict):
        state = {"last_zone": {"left": -1, "right": -1}, "last_hit": [-999.0] * count, "energy": [0.0] * count}
    triggers = [0.0] * count
    events = []
    energies = list(state.get("energy", [0.0] * count))
    if len(energies) < count:
        energies = energies + [0.0] * (count - len(energies))
    energies = [float(v) if isinstance(v, (int, float)) and math.isfinite(float(v)) else 0.0 for v in energies[:count]]
    if not isinstance(state.get("last_hit"), list) or len(state.get("last_hit", [])) != count:
        state["last_hit"] = [-999.0] * count
    decay = max(0.01, float(_active_value("Vibrationdecay", CFG["vibration_decay"])))
    dt = 1.0 / max(1.0, _cook_rate())
    active = _bool_value("Active", True) and not _bool_value("Calibrationmode", False)
    if not active:
        energies = [0.0] * count
        state["last_zone"] = {"left": -1, "right": -1}
    else:
        for i in range(count):
            energies[i] = max(0.0, energies[i] * math.exp(-dt / decay))
    if src and active:
        for hand in ("left", "right"):
            zone = _zone_for_hand(src, hand, count)
            last_zone = int(state["last_zone"].get(hand, -1))
            if zone >= 0 and zone != last_zone and (now - float(state["last_hit"][zone])) >= cooldown:
                triggers[zone] = 1.0
                energies[zone] = 1.0
                state["last_hit"][zone] = now
                events.append({"string": zone, "freq": _freq(zone), "time": now})
            state["last_zone"][hand] = zone
    state["energy"] = energies
    scriptOp.store("state", state)
    latest = {}
    for i in range(count):
        latest["string%d_trigger" % i] = float(triggers[i])
        latest["string%d_energy" % i] = float(energies[i])
        latest["string%d_freq" % i] = _freq(i)
        _chan(scriptOp, "string%d_trigger" % i, triggers[i])
        _chan(scriptOp, "string%d_energy" % i, energies[i])
        _chan(scriptOp, "string%d_freq" % i, _freq(i))
    try:
        parent().store("tdmcp_harp_latest", latest)
    except Exception:
        pass
    if events:
        try:
            queue = parent().fetch("tdmcp_harp_event_queue", [])
            if not isinstance(queue, list):
                queue = []
            parent().store("tdmcp_harp_event_queue", (queue + events)[-32:])
        except Exception:
            pass
    return
'''

AUDIO_CHOP_CODE = r'''
import json, math
CFG = json.loads(r"""__CFG__""")

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _read_map(src, name, default=0.0):
    try:
        return float(src.get(name, default))
    except Exception:
        return float(default)

def _consume_events(key):
    try:
        value = parent().fetch(key, [])
        if isinstance(value, list):
            parent().store(key, [])
            return value
    except Exception:
        pass
    return []

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def _cook_rate(default=60.0):
    try:
        return float(getattr(project, "cookRate", default))
    except Exception:
        return float(default)

def _freq(index):
    freqs = CFG.get("frequencies", [])
    if not isinstance(freqs, list) or len(freqs) == 0:
        return 220.0
    i = max(0, int(index))
    try:
        if i < len(freqs):
            return float(freqs[i])
        return float(freqs[-1]) * (2.0 ** ((i - len(freqs) + 1) / 12.0))
    except Exception:
        return 220.0

def _drive_callback(node_path, callback_path):
    try:
        node = op(node_path)
        callback = op(callback_path)
        if node is not None and callback is not None:
            callback.module.onCook(node)
    except Exception:
        pass

def _reverb_lengths(rate):
    return [max(64, int(float(rate) * seconds)) for seconds in (0.041, 0.053, 0.067, 0.079)]

def _ensure_reverb_state(scriptOp, rate):
    lengths = _reverb_lengths(rate)
    state = scriptOp.fetch("reverb_state", None)
    if not isinstance(state, dict) or state.get("rate") != int(rate) or state.get("lengths") != lengths:
        state = {
            "rate": int(rate),
            "lengths": lengths,
            "buffers": [[0.0] * length for length in lengths],
            "indexes": [0] * len(lengths),
            "damp": [0.0] * len(lengths),
        }
        scriptOp.store("reverb_state", state)
    return state

def _process_reverb(state, value, feedback, damping):
    buffers = state.get("buffers", [])
    indexes = state.get("indexes", [])
    damp_values = state.get("damp", [])
    wet_l = 0.0
    wet_r = 0.0
    if not buffers or len(indexes) != len(buffers) or len(damp_values) != len(buffers):
        return (0.0, 0.0)
    for i, buf in enumerate(buffers):
        if not buf:
            continue
        idx = int(indexes[i]) % len(buf)
        delayed = float(buf[idx])
        filtered = float(damp_values[i]) * damping + delayed * (1.0 - damping)
        damp_values[i] = filtered
        buf[idx] = float(value) + filtered * feedback * 0.82
        indexes[i] = (idx + 1) % len(buf)
        if i % 2 == 0:
            wet_l += filtered
        else:
            wet_r += filtered
    return (wet_l * 0.5, wet_r * 0.5)

def _soft_limit(value):
    ceiling = 0.92
    if value > ceiling:
        over = value - ceiling
        return ceiling + (over / (1.0 + over * 8.0)) * 0.08
    if value < -ceiling:
        over = -ceiling - value
        return -ceiling - (over / (1.0 + over * 8.0)) * 0.08
    return value

def onCook(scriptOp):
    scriptOp.clear()
    if _bool_value("Active", True) and not _bool_value("Calibrationmode", False):
        _drive_callback(CFG.get("hand_tracker_path", ""), CFG.get("hand_tracker_callbacks_path", ""))
        _drive_callback(CFG.get("harp_logic_path", ""), CFG.get("harp_logic_callbacks_path", ""))
    audio_rate = max(8000.0, min(192000.0, float(_active_value("Audiosamplerate", CFG["audio_sample_rate"]))))
    try:
        scriptOp.rate = audio_rate
    except Exception:
        pass
    cook_rate = _cook_rate()
    rate = audio_rate
    frame = int(absTime.frame)
    last_frame = scriptOp.fetch("last_frame", None)
    if not isinstance(last_frame, int):
        last_frame = frame - 1
    elapsed_frames = max(1, min(8, frame - last_frame))
    samples = max(64, min(8192, int(round(audio_rate * elapsed_frames / max(1.0, cook_rate)))))
    scriptOp.numSamples = samples
    left = scriptOp.appendChan("left")
    right = scriptOp.appendChan("right")
    events = _consume_events("tdmcp_harp_event_queue")
    src = _latest("tdmcp_harp_latest")
    now = absTime.seconds
    block_start = scriptOp.fetch("audio_clock", None)
    if not isinstance(block_start, (int, float)) or abs(float(block_start) - now) > 0.25:
        block_start = now
    block_start = float(block_start)
    voices = scriptOp.fetch("voices", None)
    if not isinstance(voices, list):
        voices = []
    count = max(1, min(32, int(_active_value("Stringcount", CFG["string_count"]))))
    queued_strings = set()
    active_output = _bool_value("Active", True) and not _bool_value("Calibrationmode", False)
    if events and active_output:
        for event in events:
            try:
                index = int(event.get("string", -1)) if isinstance(event, dict) else int(event)
            except Exception:
                index = -1
            if index < 0 or index >= count:
                continue
            freq = _freq(index)
            if isinstance(event, dict):
                try:
                    freq = float(event.get("freq", freq))
                except Exception:
                    pass
            queued_strings.add(index)
            voices.append({"freq": freq, "start": block_start, "phase": 0.0})
    if src and active_output:
        for i in range(count):
            if i not in queued_strings and _read_map(src, "string%d_trigger" % i, 0.0) > 0.5:
                voices.append({"freq": _freq(i), "start": block_start, "phase": 0.0})
    decay = max(0.03, float(_active_value("Decay", CFG["decay"])))
    bright = max(0.0, min(1.0, float(_active_value("Brightness", CFG["brightness"]))))
    volume = max(0.0, min(1.0, float(_active_value("Mastervolume", CFG["master_volume"]))))
    reverb_mix = max(0.0, min(1.0, float(_active_value("Reverbmix", CFG.get("reverb_mix", 0.22)))))
    reverb_decay = max(0.0, min(0.98, float(_active_value("Reverbdecay", CFG.get("reverb_decay", 0.68)))))
    reverb_damping = max(0.0, min(1.0, float(_active_value("Reverbdamping", CFG.get("reverb_damping", 0.45)))))
    if not active_output:
        volume = 0.0
    reverb_state = _ensure_reverb_state(scriptOp, rate)
    active = []
    for n in range(samples):
        t = n / rate
        sample_time = block_start + t
        sample = 0.0
        for voice in voices:
            age = sample_time - float(voice["start"])
            if age > decay * 6.0:
                continue
            if age < 0.0:
                continue
            env = math.exp(-age / decay)
            attack_time = max(0.014, 0.024 - bright * 0.006)
            attack = min(1.0, age / attack_time)
            freq = float(voice["freq"])
            phase = 2.0 * math.pi * freq * age
            tone = math.sin(phase)
            sample += tone * env * attack * 0.22
        dry = sample * volume
        wet_l, wet_r = _process_reverb(reverb_state, dry, reverb_decay, reverb_damping)
        left[n] = _soft_limit(dry + wet_l * reverb_mix)
        right[n] = _soft_limit(dry + wet_r * reverb_mix)
    for voice in voices:
        if block_start + (samples / rate) - float(voice["start"]) <= decay * 6.0:
            active.append(voice)
    scriptOp.store("voices", active[-24:])
    scriptOp.store("reverb_state", reverb_state)
    scriptOp.store("audio_clock", block_start + (samples / rate))
    scriptOp.store("last_frame", frame)
    return
'''

AUDIO_DRIVER_DAT_CODE = r'''
# Drives the Kinect wall harp synth explicitly; Script CHOP auto-cook can be unreliable on some TD audio setups.
def _drive_audio():
    synth = op('pluck_synth')
    callback = op('pluck_synth_callbacks')
    if synth is not None and callback is not None:
        try:
            callback.module.onCook(synth)
        except Exception:
            pass
    debug = op('audio_debug')
    if debug is not None:
        try:
            debug.cook(force=True)
        except Exception:
            pass
    out = op('audio_out')
    if out is not None:
        try:
            out.cook(force=True)
        except Exception:
            pass

def onFrameStart(frame):
    _drive_audio()
    return

def onStart():
    _drive_audio()
    return
'''

TRACKING_DRIVER_DAT_CODE = r'''
# Drives hand tracking and harp logic once per frame, independent from audio output timing.
def _cook(node):
    if node is not None:
        try:
            node.cook(force=True)
        except Exception:
            pass

def _drive_tracking():
    hand = op('hand_tracker')
    hand_cb = op('hand_tracker_callbacks')
    if hand is not None and hand_cb is not None:
        try:
            hand_cb.module.onCook(hand)
        except Exception:
            pass
    _cook(hand)
    _cook(op('hands'))
    logic = op('harp_logic')
    logic_cb = op('harp_logic_callbacks')
    if logic is not None and logic_cb is not None:
        try:
            logic_cb.module.onCook(logic)
        except Exception:
            pass
    _cook(logic)
    _cook(op('harp_state'))

def onFrameStart(frame):
    _drive_tracking()
    return

def onStart():
    _drive_tracking()
    return
'''

BRIDGE_STATUS_DRIVER_DAT_CODE = r'''${KINECT_BRIDGE_STATUS_DRIVER_DAT_CODE}'''

BRIDGE_STATUS_CHOP_CODE = r'''${KINECT_BRIDGE_STATUS_CHOP_CODE}'''

CLEAN_SYNTH_DRIVER_DAT_CODE = r'''
# Uses native Audio Oscillator CHOP voices for clean sine layers, avoiding Script CHOP audio-buffer glitches.
import math

VOICE_NAMES = ('clean_sine_voice', 'clean_sine_voice_2', 'clean_sine_voice_3')

def _par_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _par_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ('0', 'false', 'off', 'no')
    return bool(value)

def _set_par(node, names, value):
    if node is None:
        return False
    if isinstance(names, str):
        names = [names]
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is None:
                continue
            setattr(node.par, name, value)
            return True
        except Exception:
            try:
                getattr(node.par, name).val = value
                return True
            except Exception:
                pass
    return False

def _voice_nodes():
    nodes = []
    for name in VOICE_NAMES:
        node = op(name)
        if node is not None:
            nodes.append(node)
    return nodes

def _last_events(max_events=4):
    events = []
    try:
        queue = parent().fetch('tdmcp_harp_event_queue', [])
        if isinstance(queue, list) and queue:
            parent().store('tdmcp_harp_event_queue', [])
            for item in queue[-max_events:]:
                if isinstance(item, dict):
                    events.append(item)
    except Exception:
        pass
    if events:
        return events[-max_events:]
    latest = parent().fetch('tdmcp_harp_latest', {})
    if isinstance(latest, dict):
        for i in range(32):
            try:
                if float(latest.get('string%d_trigger' % i, 0.0)) > 0.5:
                    events.append({'string': i, 'freq': float(latest.get('string%d_freq' % i, 220.0))})
                    if len(events) >= max_events:
                        break
            except Exception:
                pass
    return events[-max_events:]

def _voice_patch(event, voice_index):
    intervals = (1.0, 1.498307, 2.0)
    gains = (1.0, 0.42, 0.24)
    try:
        freq = float(event.get('freq', 220.0)) if isinstance(event, dict) else 220.0
    except Exception:
        freq = 220.0
    freq = max(30.0, min(4000.0, freq * intervals[min(voice_index, len(intervals) - 1)]))
    return {'freq': freq, 'level': gains[min(voice_index, len(gains) - 1)], 'last': absTime.seconds}

def _drive_clean_synth():
    voices = _voice_nodes()
    if not voices:
        return
    now = absTime.seconds
    states = parent().fetch('tdmcp_clean_synth_voices', [])
    if not isinstance(states, list) or len(states) != len(voices):
        states = [{'freq': 220.0, 'level': 0.0, 'last': now} for _ in voices]
    events = _last_events() if _bool_value('Active', True) and not _bool_value('Calibrationmode', False) else []
    if events:
        if len(events) == 1:
            states = [_voice_patch(events[0], index) for index in range(len(voices))]
        else:
            selected = events[-len(voices):]
            states = []
            for index in range(len(voices)):
                event = selected[index % len(selected)]
                state = _voice_patch(event, 0)
                state['level'] = 0.92 if index == 0 else 0.68
                state['last'] = now
                states.append(state)
    decay = max(0.08, min(1.4, float(_par_value('Decay', 0.35)) * 0.64))
    volume = max(0.0, min(1.0, float(_par_value('Mastervolume', 0.35))))
    for index, osc in enumerate(voices):
        state = states[index] if index < len(states) and isinstance(states[index], dict) else {'freq': 220.0, 'level': 0.0, 'last': now}
        age = max(0.0, now - float(state.get('last', now)))
        amp = max(0.0, min(0.32, float(state.get('level', 0.0)) * math.exp(-age / decay) * volume * 0.44))
        if not _bool_value('Active', True) or _bool_value('Calibrationmode', False):
            amp = 0.0
        _set_par(osc, ['type'], 'sine')
        _set_par(osc, ['freq', 'frequency'], max(30.0, min(4000.0, float(state.get('freq', 220.0)))))
        _set_par(osc, ['rate'], int(float(_par_value('Audiosamplerate', 48000))))
        _set_par(osc, ['amp', 'amplitude'], amp)
        _set_par(osc, ['active'], True)
        try:
            osc.cook(force=True)
        except Exception:
            pass
    mix = op('clean_sine_mix')
    if mix is not None:
        _set_par(mix, ['combinechops', 'chopop', 'operation'], 'add')
        try:
            mix.cook(force=True)
        except Exception:
            pass
    parent().store('tdmcp_clean_synth_voices', states)
    out = op('audio_out')
    if out is not None:
        try:
            out.cook(force=True)
        except Exception:
            pass

def onFrameStart(frame):
    _drive_clean_synth()
    return

def onStart():
    _drive_clean_synth()
    return
'''

VISUAL_TOP_CODE = r'''
import json, math
try:
    import numpy as np
except Exception:
    np = None
CFG = json.loads(r"""__CFG__""")

def _hex(value):
    value = str(value).lstrip("#")
    return [int(value[i:i+2], 16) / 255.0 for i in (0, 2, 4)]

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _read_map(src, name, default=0.0):
    try:
        return float(src.get(name, default))
    except Exception:
        return float(default)

def _laser_palette(pos, energy, now):
    phase = pos * 6.28318
    cyan = np.array([0.04, 1.0, 1.0], dtype=np.float32)
    blue = np.array([0.12, 0.48, 1.0], dtype=np.float32)
    violet = np.array([0.72, 0.28, 1.0], dtype=np.float32)
    magenta = np.array([1.0, 0.12, 0.86], dtype=np.float32)
    a = 0.5 + 0.5 * math.sin(phase * 1.7 + now * 0.17)
    b = 0.5 + 0.5 * math.sin(phase * 2.9 - now * 0.11)
    color = cyan * (1.0 - a) + blue * a
    accent = violet * (1.0 - b) + magenta * b
    return np.clip(color * (1.18 + 0.55 * energy) + accent * (0.32 + 0.38 * energy), 0.0, 1.0)

def _laser_texture(pos, y_norm, now):
    grain = 0.5 + 0.5 * math.sin(pos * 827.0 + y_norm * 91.0 + now * 5.3)
    scan = 0.5 + 0.5 * math.sin(y_norm * 74.0 - now * 11.0 + pos * 19.0)
    pulse = 0.5 + 0.5 * math.sin(now * 2.1 + pos * 37.0)
    return max(0.0, min(1.0, grain * 0.46 + scan * 0.34 + pulse * 0.2))

def _laser_texture_rows(pos, y_norms, now):
    grain = 0.5 + 0.5 * np.sin(pos * 827.0 + y_norms * 91.0 + now * 5.3)
    scan = 0.5 + 0.5 * np.sin(y_norms * 74.0 - now * 11.0 + pos * 19.0)
    pulse = 0.5 + 0.5 * math.sin(now * 2.1 + pos * 37.0)
    return np.clip(grain * 0.46 + scan * 0.34 + pulse * 0.2, 0.0, 1.0).astype(np.float32)

def _beam_gradient_rows(pos, y_norms, energy, now):
    white_hot = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    cyan = np.array([0.02, 1.0, 0.92], dtype=np.float32)
    electric_blue = np.array([0.14, 0.48, 1.0], dtype=np.float32)
    violet = np.array([0.74, 0.16, 1.0], dtype=np.float32)
    magenta = np.array([1.0, 0.08, 0.78], dtype=np.float32)
    vertical = (0.5 + 0.5 * np.sin(y_norms * 5.8 + pos * 3.4 + now * 0.28)).reshape(len(y_norms), 1)
    spectral_edge = (0.5 + 0.5 * np.sin(y_norms * 18.0 - now * 1.15 + pos * 9.0)).reshape(len(y_norms), 1)
    base = cyan * (1.0 - vertical) + electric_blue * vertical
    edge = violet * (1.0 - spectral_edge) + magenta * spectral_edge
    hot = (0.12 + 0.22 * energy) * (0.5 + 0.5 * np.sin(y_norms * 42.0 + now * 2.3 + pos * 17.0)).reshape(len(y_norms), 1)
    return np.clip(base * (0.72 + 0.24 * energy) + edge * (0.28 + 0.34 * energy) + white_hot * hot, 0.0, 1.0).astype(np.float32)

def _localized_hand_motion(pos, y_norm, hand_values, visual_count, curtain_follow):
    motion = 0.0
    if not hand_values:
        return motion
    for prefix in ("left", "right"):
        if _read_map(hand_values, prefix + "_present", 0.0) <= 0.5:
            continue
        hx = max(0.0, min(1.0, _read_map(hand_values, prefix + "_x", 0.0)))
        hy = max(0.0, min(1.0, _read_map(hand_values, prefix + "_y", 0.5)))
        dx = abs(hx - pos) * visual_count
        dy = abs(hy - y_norm)
        height_weight = math.exp(-(dy * dy) / 0.035)
        width_weight = math.exp(-(dx * dx) / 18.0)
        motion = max(motion, width_weight * height_weight * curtain_follow)
    return motion

def _localized_hand_motion_rows(pos, y_norms, hand_values, visual_count, curtain_follow):
    motion = np.zeros_like(y_norms, dtype=np.float32)
    if not hand_values:
        return motion
    for prefix in ("left", "right"):
        if _read_map(hand_values, prefix + "_present", 0.0) <= 0.5:
            continue
        hx = max(0.0, min(1.0, _read_map(hand_values, prefix + "_x", 0.0)))
        hy = max(0.0, min(1.0, _read_map(hand_values, prefix + "_y", 0.5)))
        dx = abs(hx - pos) * visual_count
        dy = np.abs(hy - y_norms)
        height_weight = np.exp(-((dy * dy) / 0.035))
        width_weight = math.exp(-(dx * dx) / 18.0)
        motion = np.maximum(motion, (width_weight * height_weight * curtain_follow).astype(np.float32))
    return motion

def _update_hand_trails(hand_values, now):
    life = 1.25
    trails = parent().fetch("tdmcp_neon_hand_trails", [])
    if not isinstance(trails, list):
        trails = []
    next_trails = []
    for point in trails:
        if not isinstance(point, dict):
            continue
        try:
            age = float(now) - float(point.get("time", 0.0))
        except Exception:
            continue
        if age <= life:
            next_trails.append(point)
    for prefix in ("left", "right"):
        if _read_map(hand_values, prefix + "_present", 0.0) <= 0.5:
            continue
        x = max(0.0, min(1.0, _read_map(hand_values, prefix + "_x", 0.0)))
        y = max(0.0, min(1.0, _read_map(hand_values, prefix + "_y", 0.5)))
        size = max(0.0, min(1.0, _read_map(hand_values, prefix + "_size", 0.04)))
        last = parent().fetch("tdmcp_" + prefix + "_last_neon_trail", None)
        should_add = True
        if isinstance(last, dict):
            try:
                dist = math.hypot(x - float(last.get("x", x)), y - float(last.get("y", y)))
                should_add = dist > 0.006 or float(now) - float(last.get("time", 0.0)) > 0.045
            except Exception:
                should_add = True
        if should_add:
            point = {"x": x, "y": y, "size": size, "time": float(now), "side": prefix}
            next_trails.append(point)
            parent().store("tdmcp_" + prefix + "_last_neon_trail", point)
    next_trails = sorted(next_trails, key=lambda point: float(point.get("time", 0.0)))[-96:]
    parent().store("tdmcp_neon_hand_trails", next_trails)
    return next_trails

def _draw_neon_trails(img, trails, now):
    if not trails:
        return
    h, w, _ = img.shape
    left_color = np.array([0.0, 1.0, 0.94], dtype=np.float32)
    right_color = np.array([1.0, 0.18, 0.92], dtype=np.float32)
    life = 1.25
    for point in trails:
        if not isinstance(point, dict):
            continue
        try:
            age = float(now) - float(point.get("time", 0.0))
            fade = max(0.0, min(1.0, 1.0 - age / life))
            x = max(0.0, min(1.0, float(point.get("x", 0.0))))
            y = max(0.0, min(1.0, float(point.get("y", 0.5))))
            size = max(0.0, min(1.0, float(point.get("size", 0.04))))
        except Exception:
            continue
        if fade <= 0.0:
            continue
        cx = int(max(0, min(w - 1, x * w)))
        cy = int(max(0, min(h - 1, (1.0 - y) * h)))
        radius = int(max(22, min(90, 28 + size * 340 + fade * 28)))
        y0 = max(0, cy - radius)
        y1 = min(h, cy + radius + 1)
        x0 = max(0, cx - radius)
        x1 = min(w, cx + radius + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.ogrid[y0:y1, x0:x1]
        d2 = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy)
        sigma = max(4.0, radius * 0.42)
        glow = np.exp(-(d2.astype(np.float32) / (2.0 * sigma * sigma))).astype(np.float32)
        core = np.exp(-(d2.astype(np.float32) / (2.0 * max(2.0, sigma * 0.42) ** 2))).astype(np.float32)
        trail_alpha = (fade ** 1.25) * 0.78
        wake_sigma_x = max(9.0, radius * 0.28)
        wake_sigma_y = max(28.0, radius * 0.95)
        wake = np.exp(-(
            ((xx - cx).astype(np.float32) ** 2) / (2.0 * wake_sigma_x * wake_sigma_x)
            + ((yy - cy).astype(np.float32) ** 2) / (2.0 * wake_sigma_y * wake_sigma_y)
        )).astype(np.float32)
        wake_alpha = (fade ** 1.55) * 0.32
        color = left_color if str(point.get("side", "left")) == "left" else right_color
        value = color.reshape(1, 1, 3) * (
            (glow * trail_alpha * 0.54)
            + (core * trail_alpha * 0.34)
            + (wake * wake_alpha)
        ).reshape(y1 - y0, x1 - x0, 1)
        img[y0:y1, x0:x1, 0:3] = np.maximum(img[y0:y1, x0:x1, 0:3], value)

def _drive_callback(node_path, callback_path):
    try:
        node = op(node_path)
        callback = op(callback_path)
        if node is not None and callback is not None:
            callback.module.onCook(node)
    except Exception:
        pass

def _synthetic_hands(t):
    lx = 0.22 + 0.22 * ((math.sin(t * 0.85) + 1.0) * 0.5)
    rx = 0.56 + 0.26 * ((math.cos(t * 0.7) + 1.0) * 0.5)
    return {
        "left_present": 1.0,
        "left_x": lx,
        "left_y": 0.48,
        "left_raw_x": lx,
        "left_raw_y": 0.48,
        "left_cal_x": lx,
        "left_cal_y": 0.48,
        "right_present": 1.0,
        "right_x": rx,
        "right_y": 0.52,
        "right_raw_x": rx,
        "right_raw_y": 0.52,
        "right_cal_x": rx,
        "right_cal_y": 0.52,
    }

def _draw_dot(img, x, y, color, radius):
    h, w, _ = img.shape
    cx = int(max(0, min(w - 1, x * w)))
    cy = int(max(0, min(h - 1, (1.0 - y) * h)))
    rr = int(radius)
    y0 = max(0, cy - rr)
    y1 = min(h, cy + rr + 1)
    x0 = max(0, cx - rr)
    x1 = min(w, cx + rr + 1)
    img[y0:y1, x0:x1, 0:3] = color

def _draw_rect(img, x0, y0, x1, y1, color, alpha=1.0):
    h, w, _ = img.shape
    ix0 = int(max(0, min(w, x0)))
    ix1 = int(max(0, min(w, x1)))
    iy0 = int(max(0, min(h, y0)))
    iy1 = int(max(0, min(h, y1)))
    if ix1 <= ix0 or iy1 <= iy0:
        return
    img[iy0:iy1, ix0:ix1, 0:3] = np.maximum(img[iy0:iy1, ix0:ix1, 0:3], np.array(color, dtype=np.float32) * alpha)

def _draw_ring(img, x, y, radius, color, thickness=4, alpha=1.0):
    h, w, _ = img.shape
    cx = int(max(0, min(w - 1, x * w)))
    cy = int(max(0, min(h - 1, (1.0 - y) * h)))
    rr = int(max(2, radius))
    inner = max(0, rr - int(max(1, thickness)))
    y0 = max(0, cy - rr - 1)
    y1 = min(h, cy + rr + 2)
    x0 = max(0, cx - rr - 1)
    x1 = min(w, cx + rr + 2)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    d2 = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy)
    mask = (d2 <= rr * rr) & (d2 >= inner * inner)
    region = img[y0:y1, x0:x1, 0:3]
    region[mask] = np.maximum(region[mask], np.array(color, dtype=np.float32) * alpha)
    cross = max(8, rr // 3)
    _draw_rect(img, cx - cross, cy - 1, cx + cross, cy + 2, color, alpha)
    _draw_rect(img, cx - 1, cy - cross, cx + 2, cy + cross, color, alpha)

def _targets():
    count = max(1, min(32, int(_active_value("Stringcount", CFG.get("string_count", 8)))))
    return [
        {"id": "string_%d" % i, "x": (i + 0.5) / max(1, count), "y": 0.5, "string": i}
        for i in range(count)
    ]

def _set_par_value(name, value):
    try:
        par = getattr(parent().par, name, None)
        if par is None:
            return False
        par.val = value
        return True
    except Exception:
        try:
            setattr(parent().par, name, value)
            return True
        except Exception:
            return False

def _space_pressed():
    keys = op(CFG.get("calibration_keys_path", "")) or op("calibration_keys")
    if keys is None:
        return False
    names = ("space", "spacebar", "Space", "Spacebar", "key_space", "space_down")
    for name in names:
        try:
            if float(keys[name][0]) > 0.5:
                return True
        except Exception:
            pass
    try:
        for chan in keys.chans():
            if "space" in chan.name.lower() and float(chan[0]) > 0.5:
                return True
    except Exception:
        pass
    return False

def _best_raw_hand(hand_values):
    best = None
    for prefix in ("left", "right"):
        if _read_map(hand_values, prefix + "_present", 0.0) <= 0.5:
            continue
        size = _read_map(hand_values, prefix + "_size", 0.01)
        raw_x = max(0.0, min(1.0, _read_map(hand_values, prefix + "_raw_x", _read_map(hand_values, prefix + "_x", 0.0))))
        raw_y = max(0.0, min(1.0, _read_map(hand_values, prefix + "_raw_y", _read_map(hand_values, prefix + "_y", 0.0))))
        hand = {
            "side": prefix,
            "size": size,
            "raw_x": raw_x,
            "raw_y": raw_y,
            "mapped_x": max(0.0, min(1.0, _read_map(hand_values, prefix + "_x", raw_x))),
            "mapped_y": max(0.0, min(1.0, _read_map(hand_values, prefix + "_y", raw_y))),
        }
        if best is None or hand["size"] > best["size"]:
            best = hand
    return best

def _apply_calibration(captures):
    count = max(1, min(32, int(_active_value("Stringcount", CFG.get("string_count", 8)))))
    required = ["string_%d" % i for i in range(count)]
    for key in required:
        if key not in captures:
            return {"ok": False, "error": "missing " + key}
    raw_centers = [max(0.0, min(1.0, float(captures[key]["raw_x"]))) for key in required]
    raw_ys = [max(0.0, min(1.0, float(captures[key]["raw_y"]))) for key in required]
    left_raw = raw_centers[0]
    right_raw = raw_centers[-1]
    top_raw = min(raw_ys)
    bottom_raw = max(raw_ys)
    mirror = right_raw < left_raw
    input_left = min(left_raw, right_raw)
    input_right = max(left_raw, right_raw)
    if abs(input_right - input_left) < 0.05:
        return {"ok": False, "error": "x span too small", "left_raw": left_raw, "right_raw": right_raw}
    _set_par_value("Inputmirrorx", bool(mirror))
    _set_par_value("Inputleft", max(0.0, min(1.0, input_left)))
    _set_par_value("Inputright", max(0.0, min(1.0, input_right)))
    _set_par_value("Inputtop", max(0.0, min(1.0, top_raw)))
    _set_par_value("Inputbottom", max(0.0, min(1.0, bottom_raw)))
    result = {
        "ok": True,
        "inputmirrorx": bool(mirror),
        "inputleft": float(max(0.0, min(1.0, input_left))),
        "inputright": float(max(0.0, min(1.0, input_right))),
        "inputtop": float(max(0.0, min(1.0, top_raw))),
        "inputbottom": float(max(0.0, min(1.0, bottom_raw))),
        "raw_centers": raw_centers,
        "target_xs": [float(captures[key]["target_x"]) for key in required],
        "captures": captures,
    }
    parent().store("tdmcp_calibration_result", result)
    parent().store("tdmcp_string_calibration", result)
    return result

def _capture_target(state, targets, hand, now, forced=False):
    index = int(state.get("index", 0))
    if index < 0 or index >= len(targets):
        return state
    target = targets[index]
    captures = state.setdefault("captures", {})
    captures[target["id"]] = {
        "target_x": float(target["x"]),
        "target_y": float(target["y"]),
        "raw_x": float(hand["raw_x"]),
        "raw_y": float(hand["raw_y"]),
        "mapped_x": float(hand["mapped_x"]),
        "mapped_y": float(hand["mapped_y"]),
        "side": str(hand["side"]),
        "size": float(hand["size"]),
        "time": float(now),
        "forced": bool(forced),
    }
    state["index"] = index + 1
    state["stable_since"] = None
    state["last_hand"] = None
    state["last_capture"] = {"raw_x": float(hand["raw_x"]), "raw_y": float(hand["raw_y"]), "time": float(now)}
    state["awaiting_move"] = True
    state["armed"] = False
    state["clear_since"] = None
    state["progress"] = 0.0
    state["status"] = "captured"
    if int(state["index"]) >= len(targets):
        result = _apply_calibration(captures)
        state["done"] = bool(result.get("ok", False))
        state["result"] = result
        if result.get("ok", False):
            state["status"] = "done"
            state["active"] = False
            _set_par_value("Calibrationmode", False)
            _set_par_value("Showdebug", False)
        else:
            state["status"] = "error"
            state["error"] = result.get("error", "calibration failed")
    return state

def _update_calibration(hand_values, now):
    if _bool_value("Resetcalibration", False):
        parent().store("tdmcp_calibration_wizard", {})
        parent().store("tdmcp_calibration_result", {})
        parent().store("tdmcp_string_calibration", {})
        _set_par_value("Resetcalibration", False)
    if not _bool_value("Calibrationmode", False):
        state = parent().fetch("tdmcp_calibration_wizard", {})
        if isinstance(state, dict) and state.get("active"):
            state["active"] = False
            parent().store("tdmcp_calibration_wizard", state)
        return state if isinstance(state, dict) else {}
    targets = _targets()
    state = parent().fetch("tdmcp_calibration_wizard", {})
    if not isinstance(state, dict) or not state.get("active") or int(state.get("version", 0)) != 1:
        state = {
            "version": 1,
            "active": True,
            "index": 0,
            "captures": {},
            "progress": 0.0,
            "stable_since": None,
            "last_hand": None,
            "awaiting_move": False,
            "armed": False,
            "clear_since": None,
            "manual_latch": False,
            "status": "clear_wall",
        }
    hand = _best_raw_hand(hand_values)
    manual_pressed = _bool_value("Manualcapture", False) or _space_pressed()
    manual = bool(manual_pressed and not bool(state.get("manual_latch", False)))
    state["manual_latch"] = bool(manual_pressed)
    if _bool_value("Manualcapture", False):
        _set_par_value("Manualcapture", False)
    if hand is None:
        if state.get("clear_since") is None:
            state["clear_since"] = float(now)
        if float(now) - float(state.get("clear_since", now)) >= 0.45:
            state["armed"] = True
            state["status"] = "ready"
        else:
            state["status"] = "clear_wall"
        state["progress"] = 0.0
        state["stable_since"] = None
        state["last_hand"] = None
        parent().store("tdmcp_calibration_wizard", state)
        return state
    if not bool(state.get("armed", False)) and not manual:
        state["progress"] = 0.0
        state["stable_since"] = None
        state["last_hand"] = {"raw_x": float(hand["raw_x"]), "raw_y": float(hand["raw_y"])}
        state["status"] = "clear_wall"
        parent().store("tdmcp_calibration_wizard", state)
        return state
    state["clear_since"] = None
    if state.get("awaiting_move") and not manual:
        last_capture = state.get("last_capture", {})
        try:
            dist = math.hypot(float(hand["raw_x"]) - float(last_capture.get("raw_x", hand["raw_x"])), float(hand["raw_y"]) - float(last_capture.get("raw_y", hand["raw_y"])))
        except Exception:
            dist = 1.0
        if dist < 0.025:
            state["progress"] = 0.0
            state["status"] = "move_to_next"
            parent().store("tdmcp_calibration_wizard", state)
            return state
        state["awaiting_move"] = False
    last = state.get("last_hand")
    if isinstance(last, dict):
        dist = math.hypot(float(hand["raw_x"]) - float(last.get("raw_x", hand["raw_x"])), float(hand["raw_y"]) - float(last.get("raw_y", hand["raw_y"])))
    else:
        dist = 1.0
    if dist <= 0.055:
        if state.get("stable_since") is None:
            state["stable_since"] = float(now)
    else:
        state["stable_since"] = float(now)
        state["samples"] = []
    state["last_hand"] = {"raw_x": float(hand["raw_x"]), "raw_y": float(hand["raw_y"])}
    samples = state.get("samples", [])
    if not isinstance(samples, list):
        samples = []
    samples.append({
        "raw_x": float(hand["raw_x"]),
        "raw_y": float(hand["raw_y"]),
        "mapped_x": float(hand["mapped_x"]),
        "mapped_y": float(hand["mapped_y"]),
        "size": float(hand["size"]),
    })
    state["samples"] = samples[-36:]
    hold = max(0.2, float(_active_value("Calibrationholdms", CFG["calibration_hold_ms"])) / 1000.0)
    stable_since = state.get("stable_since")
    progress = 0.0 if stable_since is None else max(0.0, min(1.0, (float(now) - float(stable_since)) / hold))
    state["progress"] = progress
    state["status"] = "holding" if progress > 0.0 else "tracking"
    if manual or progress >= 1.0:
        capture_hand = dict(hand)
        if state["samples"]:
            sample_count = float(len(state["samples"]))
            for key in ("raw_x", "raw_y", "mapped_x", "mapped_y", "size"):
                capture_hand[key] = sum(float(sample.get(key, capture_hand[key])) for sample in state["samples"]) / sample_count
        state = _capture_target(state, targets, capture_hand, now, manual)
    parent().store("tdmcp_calibration_wizard", state)
    return state

def _draw_calibration_overlay(img, state, hand_values, now):
    h, w, _ = img.shape
    img[:, :, 0:3] *= 0.68
    targets = _targets()
    captures = state.get("captures", {}) if isinstance(state, dict) else {}
    index = int(state.get("index", 0)) if isinstance(state, dict) else 0
    progress = float(state.get("progress", 0.0)) if isinstance(state, dict) else 0.0
    for i, target in enumerate(targets):
        if target["id"] in captures:
            color = [0.0, 0.9, 0.45]
            radius = 38
            alpha = 0.85
        elif i == index:
            pulse = 0.5 + 0.5 * math.sin(now * 5.0)
            color = [0.1 + 0.4 * pulse, 0.82, 1.0]
            radius = 54
            alpha = 1.0
        else:
            color = [0.12, 0.18, 0.2]
            radius = 30
            alpha = 0.55
        _draw_ring(img, target["x"], target["y"], radius, color, 6, alpha)
    if 0 <= index < len(targets):
        target = targets[index]
        _draw_ring(img, target["x"], target["y"], 68, [1.0, 1.0, 1.0], max(4, int(18 * progress)), 0.35 + 0.55 * progress)
        if progress > 0.02:
            _draw_ring(img, target["x"], target["y"], 22 + int(30 * progress), [1.0, 0.72, 0.22], 8, progress)
    hand = _best_raw_hand(hand_values)
    if hand is not None:
        _draw_dot(img, float(hand["raw_x"]), float(hand["raw_y"]), [1.0, 0.68, 0.18], 11)
    return

def onCook(scriptOp):
    if np is None:
        return
    width = int(CFG["output_width"])
    height = int(CFG["output_height"])
    count = max(1, min(32, int(_active_value("Stringcount", CFG["string_count"]))))
    visual_count = max(8, min(192, int(_active_value("Visuallinecount", CFG.get("visual_line_count", count)))))
    img = np.zeros((height, width, 4), dtype=np.float32)
    background = max(0.0, min(1.0, float(_active_value("Backgroundlevel", CFG["background_level"]))))
    img[:, :, 0:3] = background
    img[:, :, 3] = 1.0
    base = np.array(_hex(_active_value("Basecolor", CFG["base_color"])), dtype=np.float32)
    hit = np.array(_hex(_active_value("Hitcolor", CFG["hit_color"])), dtype=np.float32)
    active = _bool_value("Active", True)
    calibrating = _bool_value("Calibrationmode", False)
    now = absTime.seconds
    hand_values = {}
    if active:
        hand_values = _latest("tdmcp_hands_latest")
    logic = _latest("tdmcp_harp_latest") if active and not calibrating else {}
    if active and not hand_values:
        hand_values = _synthetic_hands(now)
    trails = parent().fetch("tdmcp_neon_hand_trails", []) if active and not calibrating else []
    if not isinstance(trails, list):
        trails = []
    glow = float(_active_value("Glow", CFG["glow"]))
    vibration = float(_active_value("Vibrationamount", CFG["vibration_amount"]))
    curtain_spread = max(0.01, float(_active_value("Curtainspread", CFG.get("curtain_spread", 3.2))))
    curtain_follow = max(0.0, min(1.0, float(_active_value("Curtainfollow", CFG.get("curtain_follow", 0.5)))))
    rows = np.arange(height, dtype=np.int32)
    y_norms = 1.0 - (np.arange(height, dtype=np.float32) / max(1.0, float(height)))
    white_hot = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    for i in range(visual_count):
        pos = (i + 0.5) / max(1, visual_count)
        note_energy = 0.0
        for j in range(count):
            zone_pos = (j + 0.5) / max(1, count)
            dz = abs(zone_pos - pos) * count
            weight = math.exp(-(dz * dz) / curtain_spread)
            note_energy = max(note_energy, max(0.0, min(1.0, _read_map(logic, "string%d_energy" % j, 0.0))) * weight)
        tint = max(0.18, min(1.0, note_energy * glow))
        color = np.maximum(_laser_palette(pos, tint, now), base * 0.25)
        x_base = int(pos * width)
        hand_motion = _localized_hand_motion_rows(pos, y_norms, hand_values, visual_count, curtain_follow)
        local_motion = np.maximum(note_energy * 0.18, hand_motion)
        motion = np.maximum(note_energy * 0.32, local_motion)
        phase = y_norms * 21.0 + now * (11.0 + local_motion * 28.0) + pos * 41.0
        xs = np.clip((x_base + np.sin(phase) * motion * vibration).astype(np.int32), 0, width - 1)
        texture = _laser_texture_rows(pos, y_norms, now)
        gradient = _beam_gradient_rows(pos, y_norms, tint, now)
        beam_color = np.maximum(color.reshape(1, 3) * 0.48, gradient)
        core = beam_color * (0.78 + 0.42 * texture).reshape(height, 1)
        halo = color.reshape(1, 3) * (0.34 + 0.48 * local_motion).reshape(height, 1)
        needle = np.clip((white_hot.reshape(1, 3) * (0.42 + 0.38 * texture + 0.28 * local_motion).reshape(height, 1)) + (beam_color * (0.52 + 0.28 * tint)), 0.0, 1.0)
        beam_alpha = np.minimum(1.0, 0.68 + texture * 0.24 + tint * 0.5).reshape(height, 1)
        halo_gain = (0.38 + motion * 0.72).reshape(height, 1)
        halo_value = halo * halo_gain
        far_halo = beam_color * (0.14 + motion * 0.34 + texture * 0.08).reshape(height, 1)
        edge_value = np.maximum(halo_value, core * 0.42)
        for offset in (-8, -6, -4, 4, 6, 8):
            hx = np.clip(xs + offset, 0, width - 1)
            img[rows, hx, 0:3] = np.maximum(img[rows, hx, 0:3], far_halo)
        for offset in (-3, -2, -1, 1, 2, 3):
            hx = np.clip(xs + offset, 0, width - 1)
            img[rows, hx, 0:3] = np.maximum(img[rows, hx, 0:3], edge_value)
        img[rows, xs, 0:3] = np.maximum(img[rows, xs, 0:3], needle * beam_alpha)
    _draw_neon_trails(img, trails, now)
    if active and calibrating:
        state = _update_calibration(hand_values, now)
        _draw_calibration_overlay(img, state, hand_values, now)
    if active and _bool_value("Showdebug", CFG["show_debug"]):
        guide = np.array([0.15, 0.32, 0.36], dtype=np.float32)
        for i in range(1, count):
            x = int(i * width / count)
            img[:, max(0, x - 1):min(width, x + 1), 0:3] = np.maximum(
                img[:, max(0, x - 1):min(width, x + 1), 0:3],
                guide,
            )
        for prefix, color in (("left", np.array([1.0, 0.95, 0.25], dtype=np.float32)), ("right", hit)):
            if _read_map(hand_values, prefix + "_present", 0.0) > 0.5:
                _draw_dot(img, _read_map(hand_values, prefix + "_x", 0.0), _read_map(hand_values, prefix + "_y", 0.0), color, 12)
    scriptOp.copyNumpyArray(img)
    return
'''

HANDS_DEBUG_TOP_CODE = r'''
import json, math
try:
    import numpy as np
except Exception:
    np = None
CFG = json.loads(r"""__CFG__""")

def _latest(key):
    try:
        value = parent().fetch(key, None)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _read_map(src, name, default=0.0):
    try:
        return float(src.get(name, default))
    except Exception:
        return float(default)

def _synthetic_hands(t):
    return {
        "left_present": 1.0,
        "left_x": 0.22 + 0.22 * ((math.sin(t * 0.85) + 1.0) * 0.5),
        "left_y": 0.48,
        "right_present": 1.0,
        "right_x": 0.56 + 0.26 * ((math.cos(t * 0.7) + 1.0) * 0.5),
        "right_y": 0.52,
    }

def _active_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _bool_value(name, default):
    value = _active_value(name, default)
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no")
    return bool(value)

def onCook(scriptOp):
    if np is None:
        return
    width = int(CFG["output_width"])
    height = int(CFG["output_height"])
    img = np.zeros((height, width, 4), dtype=np.float32)
    img[:, :, 3] = 1.0
    active = _bool_value("Active", True)
    hands = _latest("tdmcp_hands_latest") if active else {}
    if active and _bool_value("Showdebug", CFG["show_debug"]):
        for prefix, color in (("left", [1.0, 0.9, 0.1]), ("right", [1.0, 0.35, 0.15])):
            if _read_map(hands, prefix + "_present", 0.0) > 0.5:
                cx = int(_read_map(hands, prefix + "_x", 0.0) * width)
                cy = int((1.0 - _read_map(hands, prefix + "_y", 0.0)) * height)
                img[max(0, cy - 10):min(height, cy + 11), max(0, cx - 10):min(width, cx + 11), 0:3] = color
    scriptOp.copyNumpyArray(img)
    return
'''

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _cont = _create(_parent, ["baseCOMP"], _p["name"], 0, 0, "container")
        if _cont is None:
            report["fatal"] = "Could not create Base COMP: " + str(_p["name"])
        else:
            report["container"] = _cont.path
            _expose_controls(_cont)
            _status = _create(_cont, ["textDAT"], "status", -900, 360, "status")
            if _status is not None:
                report["status_dat"] = _status.path
            _bridge_status = _create(_cont, ["textDAT"], "bridge_status", -660, 360, "bridge status")
            if _bridge_status is not None:
                report["bridge_status_dat"] = _bridge_status.path
                _set_text(_bridge_status, json.dumps({
                    "ok": False,
                    "path": str(_p.get("bridge_status_json", "")),
                    "stale": True,
                    "state": "waiting",
                }, indent=2, sort_keys=True))
            _bridge_status_chop = _create(_cont, ["scriptCHOP"], "bridge_status_chop", -660, 500, "bridge status channels")
            if _bridge_status_chop is not None:
                report["bridge_status_chop"] = _bridge_status_chop.path
                _set_par(_bridge_status_chop, ["timeslice"], False, False)
                _set_par(_bridge_status_chop, ["modoutsidecook"], True, False)
                _set_par(_bridge_status_chop, ["cooktype"], "always", False)
                _bridge_status_chop_cb = _text_dat(_cont, "bridge_status_chop_callbacks", -430, 500, "bridge status callbacks")
                _set_text(_bridge_status_chop_cb, BRIDGE_STATUS_CHOP_CODE)
                _set_callbacks(_bridge_status_chop, _bridge_status_chop_cb)
            _bridge_status_driver = _create(_cont, ["executeDAT"], "bridge_status_driver", -430, 360, "bridge status driver")
            if _bridge_status_driver is not None:
                report["bridge_status_driver"] = _bridge_status_driver.path
                _bridge_status_literal = json.dumps(str(_p.get("bridge_status_json", "")))
                _bridge_status_code = BRIDGE_STATUS_DRIVER_DAT_CODE.replace(
                    '"__BRIDGE_STATUS_JSON__"',
                    _bridge_status_literal,
                )
                _set_text(_bridge_status_driver, _bridge_status_code)
                _set_par(_bridge_status_driver, ["active"], True, False)
                _set_par(_bridge_status_driver, ["framestart"], True, False)
                _set_par(_bridge_status_driver, ["start"], True, False)
                _set_par(_bridge_status_driver, ["play"], True, False)
            _depth_src = None
            _osc_select = None
            _mode = (
                "synthetic"
                if _p["source"] == "synthetic"
                else ("osc_kinect" if _p["source"] == "osc_kinect" else "freenect_live")
            )
            if _p["source"] == "freenect":
                _deactivate_existing_freenect(_parent)
                if not bool(_p.get("activate_freenect", False)):
                    _warn(
                        "Freenect live activation is disabled by default after macOS FreenectTD crash evidence; using synthetic fallback. Pass activate_freenect=true only in an isolated diagnostic project."
                    )
                else:
                    _freenect = _create(_cont, ["FreenectTOP", "freenectTOP"], "freenect_in", -900, 180, "kinect input")
                    if _freenect is not None:
                        report["freenect_available"] = True
                        _set_par(_freenect, ["hardwareversion", "Hardwareversion"], "Kinect v2", True)
                        _set_par(_freenect, ["active", "Active"], True, False)
                        _depth = _create(_cont, ["renderselectTOP"], "depth_buffer", -660, 180, "depth buffer")
                        if not _set_par(_depth, ["top"], _freenect.path, False):
                            try:
                                if len(_depth.inputConnectors) > 0:
                                    _connect(_freenect, _depth)
                                else:
                                    _warn("Could not set Freenect source on depth_buffer.")
                            except Exception:
                                _warn("Could not set Freenect source on depth_buffer.")
                        _set_par(_depth, ["renderbufferindex", "bufferindex", "selectindex", "index"], 1, True)
                        _depth_src = _depth
                        _rgb = _create(_cont, ["nullTOP"], "rgb_debug", -660, 320, "rgb debug")
                        _connect(_freenect, _rgb)
                    else:
                        _warn("FreenectTD FreenectTOP is unavailable; Kinect v2 depth is UNVERIFIED.")
            elif _p["source"] == "osc_kinect":
                _depth_src = _create(_cont, ["constantTOP"], "osc_depth_placeholder", -900, 180, "OSC depth placeholder")
                if _depth_src is not None:
                    _set_par(_depth_src, ["resolutionw"], int(_p["output_width"]), False)
                    _set_par(_depth_src, ["resolutionh"], int(_p["output_height"]), False)
                    _set_par(_depth_src, ["colorr", "color1r"], 0, False)
                    _set_par(_depth_src, ["colorg", "color1g"], 0, False)
                    _set_par(_depth_src, ["colorb", "color1b"], 0, False)
                    _set_par(_depth_src, ["alpha", "color1a"], 1, False)
                _osc = _create(_cont, ["oscinCHOP"], "osc_kinect_in", -220, -20, "OSC Kinect input")
                if _osc is not None:
                    _set_par(_osc, ["port"], int(_p["osc_port"]), False)
                    _set_par(_osc, ["active"], True, False)
                    report["osc_in"] = _osc.path
                else:
                    _warn("OSC In CHOP unavailable; osc_kinect mode cannot receive external Kinect hand points.")
                _osc_select = _create(_cont, ["selectCHOP"], "osc_kinect_select", 20, -20, "OSC hand channels")
                if _osc_select is not None:
                    _connect(_osc, _osc_select)
                    report["osc_chop"] = _osc_select.path
            if _depth_src is None:
                if bool(_p.get("fallback_to_synthetic", True)) or _p["source"] == "synthetic":
                    _mode = "synthetic_fallback" if _p["source"] == "freenect" else "synthetic"
                    report["synthetic_fallback"] = _p["source"] == "freenect"
                    _depth_src = _create(_cont, ["noiseTOP"], "synthetic_depth", -900, 180, "synthetic depth")
                    _set_par(_depth_src, ["resolutionw"], int(_p["output_width"]), False)
                    _set_par(_depth_src, ["resolutionh"], int(_p["output_height"]), False)
                    _set_par(_depth_src, ["monochrome"], True, False)
                    _set_par(_depth_src, ["period"], 4, False)
                    try:
                        _depth_src.par.tx.expr = "absTime.seconds * 0.06"
                        _depth_src.par.ty.expr = "absTime.seconds * 0.04"
                    except Exception:
                        pass
                else:
                    report["fatal"] = "FreenectTOP unavailable and fallback_to_synthetic is false."

            if "fatal" not in report:
                report["mode"] = _mode
                _fit = _create(_cont, ["fitTOP"], "depth_fit", -430, 180, "depth processing")
                _connect(_depth_src, _fit)
                _set_par(_fit, ["resolutionw"], int(_p["output_width"]), False)
                _set_par(_fit, ["resolutionh"], int(_p["output_height"]), False)
                _crop = _create(_cont, ["cropTOP"], "depth_crop", -220, 180, "depth crop")
                _connect(_fit, _crop)
                _set_par_expr(_crop, ["left"], "parent().par.Cropleft", float(_p["crop_left"]))
                _set_par_expr(_crop, ["right"], "parent().par.Cropright", float(_p["crop_right"]))
                _set_par_expr(_crop, ["top"], "parent().par.Croptop", float(_p["crop_top"]))
                _set_par_expr(_crop, ["bottom"], "parent().par.Cropbottom", float(_p["crop_bottom"]))
                _depth_debug = _create(_cont, ["nullTOP"], "depth_debug", -220, 340, "depth debug")
                _connect(_crop, _depth_debug)
                if _depth_debug is not None:
                    report["depth_debug"] = _depth_debug.path

                _mask = _create(_cont, ["scriptTOP"], "wall_touch_mask", 20, 180, "wall-touch mask")
                _connect(_crop, _mask)
                _set_par(_mask, ["resolutionw"], int(_p["output_width"]), False)
                _set_par(_mask, ["resolutionh"], int(_p["output_height"]), False)
                _mask_cfg = dict(_p)
                _mask_cfg["mode"] = _mode
                _mask_code = MASK_TOP_CODE.replace("__CFG__", json.dumps(_mask_cfg))
                _mask_cb = _text_dat(_cont, "wall_touch_mask_callbacks", 20, 340, "mask callbacks")
                _set_text(_mask_cb, _mask_code)
                _set_callbacks(_mask, _mask_cb)
                _mask_debug = _create(_cont, ["nullTOP"], "mask_debug", 250, 180, "mask debug")
                _connect(_mask, _mask_debug)
                if _mask_debug is not None:
                    report["mask_debug"] = _mask_debug.path

                _hands = _create(_cont, ["scriptCHOP"], "hand_tracker", 250, -20, "two-hand tracker")
                _set_par(_hands, ["timeslice"], False, False)
                _set_par(_hands, ["modoutsidecook"], True, False)
                if _osc_select is not None:
                    _connect(_osc_select, _hands)
                _hands_cfg = dict(_p)
                _hands_cfg["mode"] = _mode
                _hands_cfg["mask_path"] = _mask.path if _mask is not None else ""
                _hands_cfg["osc_path"] = _osc_select.path if _osc_select is not None else ""
                _hands_code = HAND_CHOP_CODE.replace("__CFG__", json.dumps(_hands_cfg))
                _hands_cb = _text_dat(_cont, "hand_tracker_callbacks", 250, -180, "hand callbacks")
                _set_text(_hands_cb, _hands_code)
                _set_callbacks(_hands, _hands_cb)
                _hands_null = _create(_cont, ["nullCHOP"], "hands", 500, -20, "hands output")
                _connect(_hands, _hands_null)
                _set_par(_hands_null, ["cooktype"], "always", False)
                if _hands_null is not None:
                    report["hands_chop"] = _hands_null.path

                _logic = _create(_cont, ["scriptCHOP"], "harp_logic", 740, -20, "entry trigger logic")
                _set_par(_logic, ["timeslice"], False, False)
                _set_par(_logic, ["modoutsidecook"], True, False)
                _connect(_hands_null, _logic)
                _logic_cfg = dict(_p)
                _logic_code = HARP_CHOP_CODE.replace("__CFG__", json.dumps(_logic_cfg))
                _logic_cb = _text_dat(_cont, "harp_logic_callbacks", 740, -180, "logic callbacks")
                _set_text(_logic_cb, _logic_code)
                _set_callbacks(_logic, _logic_cb)
                _logic_null = _create(_cont, ["nullCHOP"], "harp_state", 980, -20, "harp state output")
                _connect(_logic, _logic_null)
                _set_par(_logic_null, ["cooktype"], "always", False)
                if _logic_null is not None:
                    report["harp_chop"] = _logic_null.path
                _tracking_driver = _create(_cont, ["executeDAT"], "tracking_driver", 1210, -20, "tracking driver")
                _set_text(_tracking_driver, TRACKING_DRIVER_DAT_CODE)
                _set_par(_tracking_driver, ["active"], True, False)
                _set_par(_tracking_driver, ["framestart"], True, False)
                _set_par(_tracking_driver, ["start"], True, False)
                _set_par(_tracking_driver, ["play"], True, False)

                _clean_voice = _create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice", 980, -500, "clean sine voice")
                _clean_voice_2 = _create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice_2", 980, -580, "clean sine fifth voice")
                _clean_voice_3 = _create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice_3", 980, -660, "clean sine octave voice")
                _set_par(_clean_voice, ["type"], "sine", False)
                _set_par(_clean_voice, ["freq", "frequency"], 220, False)
                _set_par(_clean_voice, ["rate"], int(_p["audio_sample_rate"]), False)
                _set_par(_clean_voice, ["amp", "amplitude"], 0, False)
                _set_par(_clean_voice, ["active"], True, False)
                for _voice in (_clean_voice_2, _clean_voice_3):
                    _set_par(_voice, ["type"], "sine", False)
                    _set_par(_voice, ["freq", "frequency"], 220, False)
                    _set_par(_voice, ["rate"], int(_p["audio_sample_rate"]), False)
                    _set_par(_voice, ["amp", "amplitude"], 0, False)
                    _set_par(_voice, ["active"], True, False)
                _clean_mix = _create(_cont, ["mathCHOP"], "clean_sine_mix", 1210, -580, "clean sine voice mix")
                _set_par(_clean_mix, ["combinechops", "chopop", "operation"], "add", False)
                _connect(_clean_voice, _clean_mix, 0)
                _connect(_clean_voice_2, _clean_mix, 1)
                _connect(_clean_voice_3, _clean_mix, 2)
                _audio_out = _create(_cont, ["audiodeviceoutCHOP"], "audio_out", 1210, -320, "audio output")
                if _audio_out is not None:
                    _connect(_clean_mix, _audio_out)
                    if str(_p.get("audio_device", "")).strip():
                        _set_par(_audio_out, ["device"], str(_p["audio_device"]), False)
                    report["audio_out"] = _audio_out.path
                else:
                    _warn("Audio Device Out CHOP unavailable; clean_sine_mix still exposes the synth signal.")
                _clean_driver = _create(_cont, ["executeDAT"], "clean_synth_driver", 1210, -660, "clean synth driver")
                _set_text(_clean_driver, CLEAN_SYNTH_DRIVER_DAT_CODE)
                _set_par(_clean_driver, ["active"], True, False)
                _set_par(_clean_driver, ["framestart"], True, False)
                _set_par(_clean_driver, ["start"], True, False)
                _set_par(_clean_driver, ["play"], True, False)

                _keys = _create(_cont, ["keyboardinCHOP"], "calibration_keys", 20, -320, "calibration keyboard fallback")
                if _keys is not None:
                    _set_par(_keys, ["active"], True, False)

                _visual = _create(_cont, ["scriptTOP"], "strings_visual", 740, 180, "projected strings")
                _vis_cfg = dict(_p)
                _vis_cfg["logic_path"] = _logic_null.path if _logic_null is not None else ""
                _vis_cfg["hands_path"] = _hands_null.path if _hands_null is not None else ""
                _vis_cfg["hand_tracker_path"] = _hands.path if _hands is not None else ""
                _vis_cfg["hand_tracker_callbacks_path"] = _hands_cb.path if _hands_cb is not None else ""
                _vis_cfg["harp_logic_path"] = _logic.path if _logic is not None else ""
                _vis_cfg["harp_logic_callbacks_path"] = _logic_cb.path if _logic_cb is not None else ""
                _vis_cfg["calibration_keys_path"] = _keys.path if _keys is not None else ""
                _vis_code = VISUAL_TOP_CODE.replace("__CFG__", json.dumps(_vis_cfg))
                _vis_cb = _text_dat(_cont, "strings_visual_callbacks", 740, 340, "visual callbacks")
                _set_text(_vis_cb, _vis_code)
                _set_callbacks(_visual, _vis_cb)
                _connect(_depth_debug, _visual)

                _hands_debug_top = _create(_cont, ["scriptTOP"], "hands_debug", 500, 180, "hands debug")
                _hd_cfg = dict(_p)
                _hd_cfg["hands_path"] = _hands_null.path if _hands_null is not None else ""
                _hd_code = HANDS_DEBUG_TOP_CODE.replace("__CFG__", json.dumps(_hd_cfg))
                _hd_cb = _text_dat(_cont, "hands_debug_callbacks", 500, 340, "hands debug callbacks")
                _set_text(_hd_cb, _hd_code)
                _set_callbacks(_hands_debug_top, _hd_cb)
                _connect(_depth_debug, _hands_debug_top)
                if _hands_debug_top is not None:
                    report["hands_debug"] = _hands_debug_top.path

                _out = _create(_cont, ["nullTOP"], "out1", 980, 180, "projected output")
                _connect(_visual, _out)
                if _out is not None:
                    report["output_top"] = _out.path

            _set_text(_status, json.dumps(report, indent=2, sort_keys=True))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
result = report
print(json.dumps(report))
`;

function buildKinectWallHarpScript(payload: CreateKinectWallHarpArgs): string {
  return buildPayloadScript(KINECT_WALL_HARP_SCRIPT, payload);
}

export async function createKinectWallHarpImpl(ctx: ToolContext, args: CreateKinectWallHarpArgs) {
  return guardTd(
    async () => {
      const script = buildKinectWallHarpScript(args);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<KinectWallHarpReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Kinect wall harp build failed: ${report.fatal}`, report);
      }
      const warningNote =
        report.warnings.length > 0 ? ` with ${report.warnings.length} warning(s)` : "";
      const modeNote =
        report.mode === "freenect_live"
          ? "FreenectTD/Kinect v2 live depth"
          : report.mode === "osc_kinect"
            ? "OSC Kinect external hand input"
            : report.mode === "synthetic_fallback"
              ? "synthetic fallback because FreenectTD/Kinect was unavailable"
              : "synthetic test source";
      return jsonResult(
        `Built Kinect wall harp (${modeNote}) at ${report.container} -> ${report.output_top}${warningNote}.`,
        report,
      );
    },
  );
}

export const registerCreateKinectWallHarp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_kinect_wall_harp",
    {
      title: "Create Kinect wall harp",
      description:
        "Build a synthetic-safe Kinect v2 / FreenectTD projected wall harp in an isolated Base COMP. The network can create a FreenectTOP depth path when explicitly enabled, listen to an external OSC Kinect bridge with source='osc_kinect', or build a synthetic fallback. It extracts left/right hand centroids, divides the projection into configurable musical zones, triggers short electronic plucks on zone entry, renders a denser vibrating curtain of projected strings, and exposes depth/mask/hands/audio plus bridge-status diagnostics. If FreenectTD or Kinect hardware is unavailable, the tool returns warnings instead of throwing, so the visual/audio/trigger chain can still be tested offline.",
      inputSchema: createKinectWallHarpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKinectWallHarpImpl(ctx, args),
  );
};
