import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { setupHandTrackingImpl, setupHandTrackingSchema } from "./setupHandTracking.js";

const HAND_MAPPER_SCRIPT = `
import json, base64, math, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container_path": "",
    "hand_chop": _p["hand_chop"],
    "gesture_chop": "",
    "mapper_send": "",
    "overlay_top": "",
    "mapper_path": None,
    "mapper_linked": False,
    "channels": ["map1", "map2", "map3", "map4"],
    "warnings": [],
    "errors": [],
}

HAND_BONES = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]

GESTURE_CB = r"""
import math
STATE = globals().setdefault("HAND_ABLETON_MAPPER_STATE", {
    "left_pinch": 0.0,
    "right_pinch": 0.0,
    "left_wrist": 0.5,
    "right_wrist": 0.5,
})

def _clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, float(v)))

def _par_float(name, default):
    try:
        owner = op(CONTAINER_PATH)
        par = getattr(owner.par, name, None) if owner is not None else None
        return float(par.eval()) if par is not None else float(default)
    except Exception:
        return float(default)

def _par_bool(name, default=False):
    try:
        owner = op(CONTAINER_PATH)
        par = getattr(owner.par, name, None) if owner is not None else None
        return bool(par.eval()) if par is not None else bool(default)
    except Exception:
        return bool(default)

def _sample(chop, chan_name, idx, default=0.0):
    try:
        chan = chop[chan_name]
        if chan is None:
            return float(default)
        return float(chan[idx])
    except Exception:
        try:
            return float(default)
        except Exception:
            return 0.0

def _point(chop, base, landmark):
    idx = base + landmark
    return (
        _sample(chop, "tx", idx),
        _sample(chop, "ty", idx),
        _sample(chop, "tz", idx),
    )

def _smooth(name, raw, smoothing):
    prev = float(STATE.get(name, raw))
    val = prev * smoothing + float(raw) * (1.0 - smoothing)
    STATE[name] = val
    return val

def _slot_side(chop, slot, fallback_slots):
    base = slot * 21
    hd = _sample(chop, "handedness", base, 0.0)
    if hd < -0.2:
        return "left"
    if hd > 0.2:
        return "right"
    if fallback_slots:
        return "left" if slot == 0 else "right"
    return None

def _slot_active(chop, slot, gate):
    base = slot * 21
    cands = [
        _sample(chop, "confidence", base + 0, 0.0),
        _sample(chop, "confidence", base + 4, 0.0),
        _sample(chop, "confidence", base + 8, 0.0),
        _sample(chop, "confidence", base + 9, 0.0),
    ]
    return max(cands) >= gate

def _slot_metrics(chop, slot, closed_dist, open_dist, invert_pinch, invert_wrist):
    base = slot * 21
    thumb = _point(chop, base, 4)
    index = _point(chop, base, 8)
    dist = math.sqrt(
        (index[0] - thumb[0]) ** 2 +
        (index[1] - thumb[1]) ** 2 +
        (index[2] - thumb[2]) ** 2
    )
    span = max(0.000001, open_dist - closed_dist)
    pinch = _clamp((dist - closed_dist) / span)
    if invert_pinch:
        pinch = 1.0 - pinch

    wrist = _point(chop, base, 0)
    middle = _point(chop, base, 9)
    angle = math.degrees(math.atan2(middle[1] - wrist[1], middle[0] - wrist[0]))
    wrist_rotation = _clamp(angle / 180.0)
    if invert_wrist:
        wrist_rotation = 1.0 - wrist_rotation
    return pinch, wrist_rotation, dist, angle

def onCook(scriptOp):
    scriptOp.clear()
    scriptOp.numSamples = 1
    names = [
        "map1", "map2", "map3", "map4",
        "left_pinch", "right_pinch", "left_wrist_rotation", "right_wrist_rotation",
        "left_pinch_distance", "right_pinch_distance",
        "left_wrist_angle_deg", "right_wrist_angle_deg",
        "left_active", "right_active",
        "pinch", "wrist_rotation",
    ]
    chans = {name: scriptOp.appendChan(name) for name in names}

    chop = scriptOp.inputs[0] if scriptOp.inputs else op(HAND_CHOP)
    smoothing = _clamp(_par_float("Smoothing", SMOOTHING_DEFAULT), 0.0, 0.99)
    gate = _clamp(_par_float("Minconfidence", MIN_CONFIDENCE_DEFAULT), 0.0, 1.0)
    closed_dist = max(0.000001, _par_float("Closedist", CLOSED_DIST_DEFAULT))
    open_dist = max(closed_dist + 0.000001, _par_float("Opendist", OPEN_DIST_DEFAULT))
    invert_pinch = _par_bool("Invertpinch", INVERT_PINCH_DEFAULT)
    invert_wrist = _par_bool("Invertwrist", INVERT_WRIST_DEFAULT)
    fallback_slots = _par_bool("Fallbackslots", FALLBACK_SLOTS_DEFAULT)

    raw = {
        "left_pinch": 0.0,
        "right_pinch": 0.0,
        "left_wrist": 0.5,
        "right_wrist": 0.5,
        "left_dist": 0.0,
        "right_dist": 0.0,
        "left_angle": 90.0,
        "right_angle": 90.0,
        "left_active": 0.0,
        "right_active": 0.0,
    }

    if chop is not None:
        slots = min(HAND_COUNT, int(chop.numSamples // 21) if getattr(chop, "numSamples", 0) else HAND_COUNT)
        for slot in range(slots):
            side = _slot_side(chop, slot, fallback_slots)
            if side not in ("left", "right"):
                continue
            if not _slot_active(chop, slot, gate):
                continue
            pinch, wrist_rotation, dist, angle = _slot_metrics(
                chop, slot, closed_dist, open_dist, invert_pinch, invert_wrist
            )
            if side == "left":
                raw["left_pinch"] = pinch
                raw["left_wrist"] = wrist_rotation
                raw["left_dist"] = dist
                raw["left_angle"] = angle
                raw["left_active"] = 1.0
            else:
                raw["right_pinch"] = pinch
                raw["right_wrist"] = wrist_rotation
                raw["right_dist"] = dist
                raw["right_angle"] = angle
                raw["right_active"] = 1.0

    left_pinch = _smooth("left_pinch", raw["left_pinch"], smoothing)
    right_pinch = _smooth("right_pinch", raw["right_pinch"], smoothing)
    left_wrist = _smooth("left_wrist", raw["left_wrist"], smoothing)
    right_wrist = _smooth("right_wrist", raw["right_wrist"], smoothing)

    vals = {
        "map1": left_pinch,
        "map2": right_pinch,
        "map3": left_wrist,
        "map4": right_wrist,
        "left_pinch": left_pinch,
        "right_pinch": right_pinch,
        "left_wrist_rotation": left_wrist,
        "right_wrist_rotation": right_wrist,
        "left_pinch_distance": raw["left_dist"],
        "right_pinch_distance": raw["right_dist"],
        "left_wrist_angle_deg": raw["left_angle"],
        "right_wrist_angle_deg": raw["right_angle"],
        "left_active": raw["left_active"],
        "right_active": raw["right_active"],
        "pinch": left_pinch,
        "wrist_rotation": left_wrist,
    }
    for name, val in vals.items():
        chans[name][0] = float(val)
    return
"""

OVERLAY_CB = r"""
BONES = __BONES__
PINCH_BONE = (4, 8)
STAR_SIZE = __STAR_SIZE__

def _sample(chop, chan_name, idx, default=0.0):
    try:
        chan = chop[chan_name]
        if chan is None:
            return float(default)
        return float(chan[idx])
    except Exception:
        return float(default)

def _active(chop, idx):
    return _sample(chop, "confidence", idx, 0.0) >= __MIN_CONFIDENCE__

def _xy(chop, idx):
    try:
        sx_chan = chop["screen_x"]
        sy_chan = chop["screen_y"]
        if sx_chan is not None and sy_chan is not None:
            return float(sx_chan[idx]), float(sy_chan[idx])
    except Exception:
        pass
    sx = _sample(chop, "tx", idx, 0.0)
    sy = _sample(chop, "ty", idx, 0.0)
    return sx, sy

def _add_line(scriptOp, pts, a, b):
    poly = scriptOp.appendPoly(2, closed=False, addPoints=False)
    poly[0].point = pts[a]
    poly[1].point = pts[b]

def onCook(scriptOp):
    scriptOp.clear()
    chop = op(HAND_CHOP)
    if chop is None:
        return
    slots = min(HAND_COUNT, int(chop.numSamples // 21) if getattr(chop, "numSamples", 0) else HAND_COUNT)
    for slot in range(slots):
        base = slot * 21
        pts = []
        live = []
        for lm in range(21):
            idx = base + lm
            x, y = _xy(chop, idx)
            p = scriptOp.appendPoint()
            p.x = float(x)
            p.y = float(y)
            p.z = 0.0
            pts.append(p)
            live.append(_active(chop, idx))
        for a, b in BONES:
            if live[a] and live[b]:
                _add_line(scriptOp, pts, a, b)
        if live[PINCH_BONE[0]] and live[PINCH_BONE[1]]:
            _add_line(scriptOp, pts, PINCH_BONE[0], PINCH_BONE[1])
        for lm, p in enumerate(pts):
            if not live[lm]:
                continue
            x = p.x
            y = p.y
            for ax, ay, bx, by in [
                (-STAR_SIZE, 0, STAR_SIZE, 0),
                (0, -STAR_SIZE, 0, STAR_SIZE),
                (-STAR_SIZE * 0.7, -STAR_SIZE * 0.7, STAR_SIZE * 0.7, STAR_SIZE * 0.7),
                (-STAR_SIZE * 0.7, STAR_SIZE * 0.7, STAR_SIZE * 0.7, -STAR_SIZE * 0.7),
            ]:
                a = scriptOp.appendPoint(); a.x = x + ax; a.y = y + ay; a.z = 0.0
                b = scriptOp.appendPoint(); b.x = x + bx; b.y = y + by; b.z = 0.0
                poly = scriptOp.appendPoly(2, closed=False, addPoints=False)
                poly[0].point = a
                poly[1].point = b
    return
"""

def _try(label, fn):
    try:
        return fn()
    except Exception as e:
        report["warnings"].append(label + ": " + str(e))
        return None

def _setpar(node, names, value):
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is not None:
                par.val = value
                return True
        except Exception:
            pass
    return False

def _append_float(page, comp, name, label, value, nmin, nmax):
    try:
        if getattr(comp.par, name, None) is None:
            page.appendFloat(name, label=label)
        par = getattr(comp.par, name, None)
        if par is not None:
            try:
                par.normMin = nmin
                par.normMax = nmax
            except Exception:
                pass
            par.val = value
    except Exception as e:
        report["warnings"].append("custom parameter " + name + ": " + str(e))

def _append_toggle(page, comp, name, label, value):
    try:
        if getattr(comp.par, name, None) is None:
            page.appendToggle(name, label=label)
        par = getattr(comp.par, name, None)
        if par is not None:
            par.val = bool(value)
    except Exception as e:
        report["warnings"].append("custom parameter " + name + ": " + str(e))

def _find_mapper(parent):
    if _p.get("mapper_path"):
        return op(_p["mapper_path"])
    roots = []
    if parent is not None:
        roots.append(parent)
    for path in ["/map", "/project1", "/"]:
        root = op(path)
        if root is not None and root not in roots:
            roots.append(root)
    for root in roots:
        try:
            for node in root.findChildren(maxDepth=8):
                if node.name == "TDA_Mapper" or node.path.endswith("/TDA_Mapper"):
                    return node
        except Exception:
            pass
    return None

try:
    parent = op(_p["parent_path"])
    hand = op(_p["hand_chop"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    elif hand is None:
        report["fatal"] = "Hand CHOP not found: " + str(_p["hand_chop"])
    else:
        cname = _p["container_name"]
        cont = parent.op(cname) or parent.create(baseCOMP, cname)
        report["container_path"] = cont.path
        for child in list(cont.children):
            _try("destroy " + child.path, lambda c=child: c.destroy())

        page = _try("custom page", lambda: cont.appendCustomPage("HandAbleton"))
        if page is not None:
            _append_float(page, cont, "Closedist", "Closed Dist", _p["closed_distance"], 0.0, 0.25)
            _append_float(page, cont, "Opendist", "Open Dist", _p["open_distance"], 0.0, 0.4)
            _append_float(page, cont, "Smoothing", "Smoothing", _p["smoothing"], 0.0, 0.99)
            _append_float(page, cont, "Minconfidence", "Min Confidence", _p["min_confidence"], 0.0, 1.0)
            _append_toggle(page, cont, "Invertpinch", "Invert Pinch", _p["invert_pinch"])
            _append_toggle(page, cont, "Invertwrist", "Invert Wrist", _p["invert_wrist"])
            _append_toggle(page, cont, "Fallbackslots", "Fallback Slots", _p["fallback_slots"])

        hand_in = cont.create(selectCHOP, "hand_in")
        _setpar(hand_in, ["chop"], _p["hand_chop"])
        _setpar(hand_in, ["channames"], "tx ty tz confidence handedness screen_x screen_y")

        gesture = cont.create(scriptCHOP, "gesture")
        _try("connect hand_in -> gesture", lambda: hand_in.outputConnectors[0].connect(gesture.inputConnectors[0]))
        cb = cont.create(textDAT, "gesture_cb")
        cb.text = (
            "CONTAINER_PATH = %r\\nHAND_CHOP = %r\\nHAND_COUNT = %d\\n"
            "CLOSED_DIST_DEFAULT = %r\\nOPEN_DIST_DEFAULT = %r\\nSMOOTHING_DEFAULT = %r\\n"
            "MIN_CONFIDENCE_DEFAULT = %r\\nINVERT_PINCH_DEFAULT = %r\\nINVERT_WRIST_DEFAULT = %r\\n"
            "FALLBACK_SLOTS_DEFAULT = %r\\n" %
            (
                cont.path,
                _p["hand_chop"],
                int(_p["hand_count"]),
                _p["closed_distance"],
                _p["open_distance"],
                _p["smoothing"],
                _p["min_confidence"],
                bool(_p["invert_pinch"]),
                bool(_p["invert_wrist"]),
                bool(_p["fallback_slots"]),
            )
        ) + GESTURE_CB
        gesture.par.callbacks = cb.name
        report["gesture_chop"] = gesture.path

        gesture_out = cont.create(nullCHOP, "gesture_out")
        _try("connect gesture -> gesture_out", lambda: gesture.outputConnectors[0].connect(gesture_out.inputConnectors[0]))

        mapper_send = cont.create(selectCHOP, "mapper_send")
        _try("connect gesture -> mapper_send", lambda: gesture.outputConnectors[0].connect(mapper_send.inputConnectors[0]))
        _setpar(mapper_send, ["channames"], "map1 map2 map3 map4")
        report["mapper_send"] = mapper_send.path

        if _p["create_overlay"]:
            geo = cont.create(geometryCOMP, "hand_geo")
            skel = geo.create(scriptSOP, "hand_skeleton")
            skcb = geo.create(textDAT, "hand_skeleton_cb")
            skcb.text = (
                OVERLAY_CB
                .replace("__BONES__", repr(HAND_BONES))
                .replace("__STAR_SIZE__", repr(float(_p["star_size"])))
                .replace("__MIN_CONFIDENCE__", repr(float(_p["min_confidence"])))
            )
            skcb.text = "HAND_CHOP = %r\\nHAND_COUNT = %d\\n" % (_p["hand_chop"], int(_p["hand_count"])) + skcb.text
            skel.par.callbacks = skcb.name
            try:
                skel.render = True
                skel.display = True
            except Exception:
                pass
            wire = cont.create(lineMAT, "skeleton_wire")
            _setpar(wire, ["linenearcolorr"], 0.95)
            _setpar(wire, ["linenearcolorg"], 0.90)
            _setpar(wire, ["linenearcolorb"], 0.22)
            _setpar(wire, ["widthnear"], _p["line_width"])
            _setpar(geo, ["material"], wire.path)
            cam = cont.create(cameraCOMP, "cam")
            _setpar(cam, ["projection"], "orthographic")
            _setpar(cam, ["orthowidth"], 2.25)
            _setpar(cam, ["tz"], 3)
            render = cont.create(renderTOP, "render_skeleton")
            _setpar(render, ["outputresolution"], "custom")
            _setpar(render, ["resolutionw"], 1280)
            _setpar(render, ["resolutionh"], 720)
            _setpar(render, ["antialias"], "3")
            _setpar(render, ["geometry"], geo.path)
            _setpar(render, ["camera"], cam.path)
            overlay = cont.create(nullTOP, "skeleton_overlay")
            _try("connect render -> overlay", lambda: render.outputConnectors[0].connect(overlay.inputConnectors[0]))
            report["overlay_top"] = overlay.path

        if _p["link_mapper"]:
            mapper = _find_mapper(parent)
            if mapper is None:
                report["warnings"].append(
                    "TDA_Mapper not found. Map Ableton manually, or pass mapper_path after importing TDAbleton."
                )
            else:
                report["mapper_path"] = mapper.path
                ok_osc = _setpar(mapper, ["Oscinputchop", "oscinputchop"], mapper_send.path)
                ok_reorder = _setpar(mapper, ["Reorder", "reorder"], "map1 map2 map3 map4")
                for idx in range(1, 5):
                    _setpar(mapper, ["Bypass%d" % idx, "bypass%d" % idx], False)
                    _setpar(mapper, ["Min%d" % idx, "min%d" % idx], 0.0)
                    _setpar(mapper, ["Max%d" % idx, "max%d" % idx], 1.0)
                report["mapper_linked"] = bool(ok_osc or ok_reorder)
                if not report["mapper_linked"]:
                    report["warnings"].append("Found mapper at " + mapper.path + " but could not set Oscinputchop/Reorder parameters.")

        for node in cont.ops():
            try:
                for err in (node.errors() or [])[:3]:
                    report["errors"].append(str(err))
            except Exception:
                pass
except Exception:
    report["fatal"] = traceback.format_exc(limit=6)

print(json.dumps(report))
`;

export const createHandAbletonMapperSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the mapper network."),
  container_name: z
    .string()
    .default("hand_ableton_mapper")
    .describe("baseCOMP created under parent_path."),
  hand_chop: z
    .string()
    .optional()
    .describe(
      "Existing hand CHOP with tx/ty/tz/confidence/handedness/screen_x/screen_y. Defaults to setup_hand_tracking's adapter output.",
    ),
  ensure_hand_tracking: z
    .boolean()
    .default(true)
    .describe("When hand_chop is omitted, run setup_hand_tracking first."),
  tox_path: z
    .string()
    .optional()
    .describe("Optional MediaPipe.tox path forwarded to setup_hand_tracking."),
  adapter_name: z
    .string()
    .default("mp_hand_adapter")
    .describe("Hand adapter name used by setup_hand_tracking."),
  coordinate_space: z
    .enum(["world", "image"])
    .default("world")
    .describe(
      "Coordinate space forwarded to setup_hand_tracking; world is best for pinch distance.",
    ),
  hand_count: z.coerce.number().int().min(1).max(2).default(2).describe("Number of hand slots."),
  closed_distance: z.coerce
    .number()
    .positive()
    .default(0.025)
    .describe("Distance where thumb/index are treated as closed."),
  open_distance: z.coerce
    .number()
    .positive()
    .default(0.14)
    .describe("Distance where thumb/index are treated as fully open."),
  smoothing: z.coerce
    .number()
    .min(0)
    .max(0.99)
    .default(0.35)
    .describe("0=raw, 0.99=very slow smoothing."),
  min_confidence: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.25)
    .describe("Minimum landmark confidence to accept a hand slot."),
  invert_pinch: z.boolean().default(false).describe("Invert map1/map2 pinch values."),
  invert_wrist: z.boolean().default(false).describe("Invert map3/map4 wrist-roll values."),
  fallback_slots: z
    .boolean()
    .default(true)
    .describe("If handedness is missing, treat slot 0 as left and slot 1 as right."),
  mapper_path: z.string().optional().describe("Optional explicit TDA_Mapper path."),
  link_mapper: z
    .boolean()
    .default(true)
    .describe("Try to set the TDA_Mapper Oscinputchop/Reorder/range parameters."),
  create_overlay: z
    .boolean()
    .default(true)
    .describe("Create a skeleton overlay TOP with star joints and a thumb-index line."),
  line_width: z.coerce.number().min(0).default(3).describe("Overlay line width."),
  star_size: z.coerce.number().positive().default(0.018).describe("Overlay star-joint size."),
});
type CreateHandAbletonMapperArgs = z.infer<typeof createHandAbletonMapperSchema>;

interface HandAbletonMapperReport {
  container_path: string;
  hand_chop: string;
  gesture_chop: string;
  mapper_send: string;
  overlay_top?: string;
  mapper_path?: string | null;
  mapper_linked: boolean;
  channels: string[];
  warnings: string[];
  errors: string[];
  fatal?: string;
}

function fallbackHandChop(parentPath: string, adapterName: string): string {
  return `${parentPath.replace(/\/$/, "")}/${adapterName}/hand`;
}

export async function createHandAbletonMapperImpl(
  ctx: ToolContext,
  args: CreateHandAbletonMapperArgs,
): Promise<CallToolResult> {
  let handChop = args.hand_chop ?? fallbackHandChop(args.parent_path, args.adapter_name);

  if (!args.hand_chop && args.ensure_hand_tracking) {
    const setupResult = await setupHandTrackingImpl(
      ctx,
      setupHandTrackingSchema.parse({
        tox_path: args.tox_path,
        parent_path: args.parent_path,
        max_hands: args.hand_count,
        coordinate_space: args.coordinate_space,
        adapter_name: args.adapter_name,
      }),
    );
    if (setupResult.isError) return setupResult;
    const structured = setupResult.structuredContent as { adapter_hand_chop?: unknown } | undefined;
    if (typeof structured?.adapter_hand_chop === "string") {
      handChop = structured.adapter_hand_chop;
    }
  }

  const payload = {
    parent_path: args.parent_path,
    container_name: args.container_name,
    hand_chop: handChop,
    hand_count: args.hand_count,
    closed_distance: args.closed_distance,
    open_distance: args.open_distance,
    smoothing: args.smoothing,
    min_confidence: args.min_confidence,
    invert_pinch: args.invert_pinch,
    invert_wrist: args.invert_wrist,
    fallback_slots: args.fallback_slots,
    mapper_path: args.mapper_path,
    link_mapper: args.link_mapper,
    create_overlay: args.create_overlay,
    line_width: args.line_width,
    star_size: args.star_size,
  };

  const script = buildPayloadScript(HAND_MAPPER_SCRIPT, payload);
  return guardTd(
    () => ctx.client.executePythonScript(script),
    ({ stdout }) => {
      const report = parsePythonReport<HandAbletonMapperReport>(stdout);
      if (report.fatal) {
        return errorResult(`create_hand_ableton_mapper failed: ${report.fatal}`, report);
      }

      const mapperNote = report.mapper_linked
        ? `linked ${report.mapper_path ?? "TDA_Mapper"}`
        : "built mapper_send; map or relink the TDA_Mapper manually";
      const overlayNote = report.overlay_top ? ` Overlay: ${report.overlay_top}.` : "";
      return jsonResult(
        `Hand Ableton mapper ready at ${report.container_path}: map1 left pinch, map2 right pinch, map3 left wrist roll, map4 right wrist roll; ${mapperNote}.${overlayNote}`,
        report,
      );
    },
  );
}

export const registerCreateHandAbletonMapper: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_hand_ableton_mapper",
    {
      title: "Create hand Ableton mapper",
      description:
        "Build a MediaPipe-hands to TDAbleton TDA_Mapper performance control network. It outputs map1=left pinch, map2=right pinch, map3=left wrist roll, map4=right wrist roll, creates a skeleton overlay with star joints plus the thumb-index line, and optionally relinks an existing TDA_Mapper to the generated mapper_send CHOP. Uses TDAbleton directly; AbletonMCP is not required.",
      inputSchema: createHandAbletonMapperSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHandAbletonMapperImpl(ctx, args),
  );
