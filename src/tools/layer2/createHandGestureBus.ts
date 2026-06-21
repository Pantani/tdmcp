import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { setupHandTrackingImpl, setupHandTrackingSchema } from "./setupHandTracking.js";

const HAND_GESTURE_CHANNELS = [
  "on",
  "has_hand",
  "active_hand",
  "palm_open",
  "palm_x",
  "palm_y",
  "float_x",
  "float_y",
  "palm_size",
  "palm_rot",
  "palm_confidence",
  "held_tracking",
  "pinch_active",
  "pinch_power",
  "pinch_measured",
  "pinch_near",
  "pinch_close",
  "pinch_x",
  "pinch_y",
  "scale_target",
  "light_gain",
  "audio_level",
] as const;

const GESTURE_BUS_SCRIPT = `
import json, base64, math, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

CHANNELS = [
    "on", "has_hand", "active_hand", "palm_open", "palm_x", "palm_y",
    "float_x", "float_y", "palm_size", "palm_rot", "palm_confidence",
    "held_tracking", "pinch_active", "pinch_power", "pinch_measured",
    "pinch_near", "pinch_close", "pinch_x", "pinch_y", "scale_target",
    "light_gain", "audio_level",
]

report = {
    "container_path": "",
    "source": _p["source"],
    "hand_chop": _p.get("hand_chop"),
    "gesture_chop": "",
    "gesture_bus": "",
    "state_dat": "",
    "channels": CHANNELS,
    "controls": [],
    "warnings": [],
    "errors": [],
}

SYNTHETIC_CB = r"""
import math

HAND_COUNT = __HAND_COUNT__

def _screen_x(v):
    return max(-1.15, min(1.15, float(v) * 2.0 - 1.0))

def _screen_y(v):
    return max(-1.15, min(1.15, 1.0 - float(v) * 2.0))

def _pt(x, y, z=0.0):
    return (float(x), float(y), float(z))

def _open_hand(cx, cy, spread=0.055):
    lm = [_pt(cx, cy, 0.0) for _ in range(21)]
    lm[0] = _pt(cx, cy + 0.105)
    lm[1] = _pt(cx - spread * 1.10, cy + 0.075)
    lm[2] = _pt(cx - spread * 1.25, cy + 0.050)
    lm[3] = _pt(cx - spread * 1.38, cy + 0.030)
    lm[4] = _pt(cx - spread * 1.45, cy + 0.020)
    lm[5] = _pt(cx - spread, cy + 0.010)
    lm[6] = _pt(cx - spread * 1.05, cy - 0.050)
    lm[7] = _pt(cx - spread * 1.08, cy - 0.100)
    lm[8] = _pt(cx - spread * 1.12, cy - 0.145)
    lm[9] = _pt(cx - spread * 0.20, cy)
    lm[10] = _pt(cx - spread * 0.22, cy - 0.065)
    lm[11] = _pt(cx - spread * 0.24, cy - 0.115)
    lm[12] = _pt(cx - spread * 0.25, cy - 0.165)
    lm[13] = _pt(cx + spread * 0.45, cy + 0.008)
    lm[14] = _pt(cx + spread * 0.50, cy - 0.055)
    lm[15] = _pt(cx + spread * 0.52, cy - 0.105)
    lm[16] = _pt(cx + spread * 0.55, cy - 0.150)
    lm[17] = _pt(cx + spread, cy + 0.016)
    lm[18] = _pt(cx + spread * 1.08, cy - 0.040)
    lm[19] = _pt(cx + spread * 1.12, cy - 0.085)
    lm[20] = _pt(cx + spread * 1.18, cy - 0.125)
    return lm

def _pinch_hand(cx, cy, gap):
    lm = _open_hand(cx, cy, 0.050)
    lm[4] = _pt(cx - gap, cy - 0.040)
    lm[8] = _pt(cx + gap, cy - 0.042)
    lm[10] = _pt(cx - 0.010, cy - 0.010)
    lm[12] = _pt(cx - 0.012, cy - 0.012)
    lm[14] = _pt(cx + 0.020, cy - 0.006)
    lm[16] = _pt(cx + 0.022, cy - 0.004)
    return lm

def onCook(scriptOp):
    scriptOp.clear()
    scriptOp.numSamples = HAND_COUNT * 21
    chans = {name: scriptOp.appendChan(name) for name in [
        "tx", "ty", "tz", "confidence", "handedness", "screen_x", "screen_y"
    ]}
    t = absTime.seconds
    sway = math.sin(t * 0.85) * 0.035
    pulse = math.sin(t * 1.15) * 0.5 + 0.5
    hands = [_open_hand(0.48 + sway, 0.58, 0.056)]
    if HAND_COUNT > 1:
        gap = 0.052 - pulse * 0.038
        hands.append(_pinch_hand(0.48 + sway * 0.6, 0.38, gap))
    handed = [1.0, -1.0]
    for slot in range(HAND_COUNT):
        base = slot * 21
        live = slot < len(hands)
        for lm in range(21):
            idx = base + lm
            if live:
                x, y, z = hands[slot][lm]
                chans["tx"][idx] = x - 0.5
                chans["ty"][idx] = 0.5 - y
                chans["tz"][idx] = z
                chans["confidence"][idx] = 1.0
                chans["handedness"][idx] = handed[slot] if slot < len(handed) else 0.0
                chans["screen_x"][idx] = _screen_x(x)
                chans["screen_y"][idx] = _screen_y(y)
            else:
                for ch in chans.values():
                    ch[idx] = 0.0
    return
"""

GESTURE_CB = r"""
import json, math

HAND_CHOP = __HAND_CHOP__
HAND_COUNT = __HAND_COUNT__
STATE_DAT = __STATE_DAT__
DEFAULT_SMOOTHING = __SMOOTHING__
DEFAULT_FAST_SMOOTHING = __FAST_SMOOTHING__
DEFAULT_HOLD_SECONDS = __HOLD_SECONDS__
DEFAULT_PINCH_ARM_SECONDS = __PINCH_ARM_SECONDS__
DEFAULT_PINCH_CLOSE_DIST = __PINCH_CLOSE_DIST__
DEFAULT_PINCH_OPEN_DIST = __PINCH_OPEN_DIST__
DEFAULT_PINCH_RADIUS = __PINCH_RADIUS__
DEFAULT_PINCH_RADIUS_SCALE = __PINCH_RADIUS_SCALE__
DEFAULT_PINCH_THRESHOLD = __PINCH_THRESHOLD__
DEFAULT_ACTIVE_HAND_LOCK = __ACTIVE_HAND_LOCK__
MIRROR = __MIRROR__

FINGER_CLOSED_ANGLE = 96.0
FINGER_FULL_OPEN_ANGLE = 172.0
PALM_MIN_WIDTH = 0.044
PALM_LOCK_MIN_RAW = 0.16
PALM_SWITCH_RAW_MARGIN = 0.55
FLOAT_OFFSET = 1.92
PINCH_POWER_EMA = 0.38
PINCH_CLOSE_MIN = 0.84
PINCH_NEAR_MIN = 0.48
PINCH_RELEASE_THRESHOLD = 0.16
PINCH_RELEASE_CLOSE_MIN = 0.64
PINCH_RELEASE_NEAR_MIN = 0.30
MOTION_PREDICT_SECONDS = 0.035
MOTION_MAX_PREDICT = 0.032
EMA_CLOSE = 0.90
PIP = {"index": (5, 6, 8), "middle": (9, 10, 12), "ring": (13, 14, 16), "pinky": (17, 18, 20)}
STATE = globals().setdefault("HAND_GESTURE_BUS_STATE", {})

CHANNELS = [
    "on", "has_hand", "active_hand", "palm_open", "palm_x", "palm_y",
    "float_x", "float_y", "palm_size", "palm_rot", "palm_confidence",
    "held_tracking", "pinch_active", "pinch_power", "pinch_measured",
    "pinch_near", "pinch_close", "pinch_x", "pinch_y", "scale_target",
    "light_gain", "audio_level",
]

def _clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, float(v)))

def _par_float(name, default):
    try:
        par = getattr(parent().par, name, None)
        if par is not None:
            return float(par.eval())
    except Exception:
        pass
    return float(default)

def _par_bool(name, default):
    try:
        par = getattr(parent().par, name, None)
        if par is not None:
            return bool(par.eval())
    except Exception:
        pass
    return bool(default)

def _sample(chop, chan_name, idx, default=0.0):
    try:
        chan = chop[chan_name]
        if chan is None:
            if default is None:
                return None
            return float(default)
        return float(chan[idx])
    except Exception:
        if default is None:
            return None
        return float(default)

def _norm_from_screen(sx, sy):
    x = (float(sx) + 1.0) * 0.5
    y = (1.0 - float(sy)) * 0.5
    if MIRROR:
        x = 1.0 - x
    return _clamp(x), _clamp(y)

def _point(chop, slot, landmark):
    idx = slot * 21 + landmark
    sx = _sample(chop, "screen_x", idx, None)
    sy = _sample(chop, "screen_y", idx, None)
    if sx is not None and sy is not None and (sx != 0.0 or sy != 0.0):
        x, y = _norm_from_screen(sx, sy)
    else:
        x = _clamp(_sample(chop, "tx", idx, 0.0) + 0.5)
        y = _clamp(0.5 - _sample(chop, "ty", idx, 0.0))
        if MIRROR:
            x = 1.0 - x
    z = _sample(chop, "tz", idx, 0.0)
    conf = _sample(chop, "confidence", idx, 0.0)
    return {"x": x, "y": y, "z": z, "confidence": conf}

def _dist(a, b):
    return math.sqrt((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2)

def _angle(points, a, b, c):
    A = points[a]; B = points[b]; C = points[c]
    ba = (A["x"] - B["x"], A["y"] - B["y"])
    bc = (C["x"] - B["x"], C["y"] - B["y"])
    na = math.sqrt(ba[0] * ba[0] + ba[1] * ba[1])
    nc = math.sqrt(bc[0] * bc[0] + bc[1] * bc[1])
    if na < 1e-9 or nc < 1e-9:
        return 180.0
    cv = _clamp((ba[0] * bc[0] + ba[1] * bc[1]) / (na * nc), -1.0, 1.0)
    return math.degrees(math.acos(cv))

def _finger_open(angle):
    span = max(1.0, FINGER_FULL_OPEN_ANGLE - FINGER_CLOSED_ANGLE)
    return _clamp((angle - FINGER_CLOSED_ANGLE) / span)

def _empty():
    prev = STATE.get("ema", (0.5, 0.5, 0.11, 0.0))
    return {
        "on": 0.0, "has_hand": 0.0, "active_hand": -1.0, "palm_open": 0.0,
        "palm_x": prev[0], "palm_y": prev[1], "float_x": prev[0], "float_y": prev[1],
        "palm_size": prev[2], "palm_rot": prev[3], "palm_confidence": 0.0,
        "held_tracking": 0.0, "pinch_active": 0.0, "pinch_power": 0.0,
        "pinch_measured": 0.0, "pinch_near": 0.0, "pinch_close": 0.0,
        "pinch_x": 0.0, "pinch_y": 0.0, "scale_target": 1.0, "light_gain": 1.0,
        "audio_level": 0.0,
    }

def _slot_candidate(chop, slot):
    pts = [_point(chop, slot, i) for i in range(21)]
    if max(p["confidence"] for p in pts) < 0.15:
        return None
    angles = {name: _angle(pts, *idx) for name, idx in PIP.items()}
    finger_open = {name: _finger_open(value) for name, value in angles.items()}
    openness = sum(finger_open.values()) / max(1, len(finger_open))
    open_count = sum(1 for value in finger_open.values() if value >= 0.50)
    wrist = pts[0]; index_mcp = pts[5]; middle_mcp = pts[9]; ring_mcp = pts[13]; pinky_mcp = pts[17]
    palm_width = _dist(index_mcp, pinky_mcp)
    palm_height = _dist(wrist, middle_mcp)
    thumb_index_dist = _dist(pts[4], pts[8])
    pinch_like = _clamp((0.130 - thumb_index_dist) / 0.080)
    palm_visible = palm_width > PALM_MIN_WIDTH or (open_count >= 3 and palm_height > 0.085)
    raw = _clamp((openness - 0.18) / 0.74) if palm_visible else 0.0
    if palm_visible and open_count >= 3 and openness > 0.62:
        raw = max(raw, _clamp((openness - 0.45) / 0.45))
    knuckle_x = (index_mcp["x"] + middle_mcp["x"] + ring_mcp["x"] + pinky_mcp["x"]) / 4.0
    knuckle_y = (index_mcp["y"] + middle_mcp["y"] + ring_mcp["y"] + pinky_mcp["y"]) / 4.0
    stable_x = wrist["x"] * 0.52 + middle_mcp["x"] * 0.48
    stable_y = wrist["y"] * 0.52 + middle_mcp["y"] * 0.48
    knuckle_palm_x = wrist["x"] * 0.42 + knuckle_x * 0.58
    knuckle_palm_y = wrist["y"] * 0.42 + knuckle_y * 0.58
    open_x = stable_x * 0.72 + knuckle_palm_x * 0.28
    open_y = stable_y * 0.72 + knuckle_palm_y * 0.28
    closed_x = wrist["x"] * 0.86 + stable_x * 0.14
    closed_y = wrist["y"] * 0.86 + stable_y * 0.14
    open_mix = raw * raw
    palm_x = closed_x * (1.0 - open_mix) + open_x * open_mix
    palm_y = closed_y * (1.0 - open_mix) + open_y * open_mix
    base_size = _clamp(palm_width * 1.15, 0.070, 0.190)
    lift_curve = raw * raw * raw
    float_y = _clamp(palm_y - base_size * FLOAT_OFFSET * lift_curve, 0.02, 0.98)
    rot = math.atan2(pinky_mcp["y"] - index_mcp["y"], pinky_mcp["x"] - index_mcp["x"]) * 0.35
    score = palm_width + raw * 0.30 - pinch_like * 0.22
    conf = max(p["confidence"] for p in pts)
    return {
        "hand": slot, "raw": raw, "open_count": open_count, "openness": openness,
        "palm_x": _clamp(palm_x), "palm_y": _clamp(palm_y), "float_x": _clamp(palm_x),
        "float_y": float_y, "palm_size": base_size, "palm_rot": rot,
        "palm_score": score, "palm_width": palm_width, "palm_confidence": conf * raw,
        "pinch_like": pinch_like, "pts": pts,
    }

def _usable(cand):
    if cand is None or cand.get("raw", 0.0) <= 0.0:
        return False
    if cand.get("pinch_like", 0.0) > 0.82 and cand.get("open_count", 0) < 4:
        return False
    return True

def _choose(candidates):
    valid = [c for c in candidates if _usable(c)]
    if not valid:
        return None
    best = max(valid, key=lambda c: c.get("palm_score", 0.0))
    if not _par_bool("Activehandlock", DEFAULT_ACTIVE_HAND_LOCK):
        return best
    prev_hand = int(STATE.get("active_hand", -1))
    locked = None
    for cand in valid:
        if int(cand.get("hand", -1)) == prev_hand:
            locked = cand
            break
    if locked and locked.get("raw", 0.0) >= PALM_LOCK_MIN_RAW:
        if best.get("hand") != locked.get("hand"):
            raw_gap = best.get("raw", 0.0) - locked.get("raw", 0.0)
            if locked.get("raw", 0.0) < 0.32 and raw_gap > PALM_SWITCH_RAW_MARGIN:
                return best
        return locked
    return best

def _predict(cx, cy, raw):
    now = absTime.seconds
    prev = STATE.get("target_prev")
    STATE["target_prev"] = (cx, cy, now)
    if not prev or raw < 0.12:
        return cx, cy
    try:
        pcx, pcy, pt = prev
        dt = max(0.001, now - float(pt))
    except Exception:
        return cx, cy
    if dt > 0.20:
        return cx, cy
    dx = _clamp((cx - pcx) / dt * MOTION_PREDICT_SECONDS, -MOTION_MAX_PREDICT, MOTION_MAX_PREDICT)
    dy = _clamp((cy - pcy) / dt * MOTION_PREDICT_SECONDS, -MOTION_MAX_PREDICT, MOTION_MAX_PREDICT)
    return _clamp(cx + dx), _clamp(cy + dy, 0.02, 0.98)

def _smooth(cand):
    cx, cy = _predict(cand["float_x"], cand["float_y"], cand["raw"])
    size = cand["palm_size"]; rot = cand["palm_rot"]
    prev = STATE.get("ema")
    if prev:
        pcx, pcy, psz, prot = prev
        raw_prev = float(STATE.get("raw_prev", cand["raw"]))
        motion = math.sqrt((cx - pcx) ** 2 + (cy - pcy) ** 2)
        slow = _par_float("Smoothing", DEFAULT_SMOOTHING)
        fast = _par_float("Fastsmoothing", DEFAULT_FAST_SMOOTHING)
        ema = EMA_CLOSE if cand["raw"] < raw_prev else _clamp(slow + motion * 5.0, slow, fast)
        cx = ema * cx + (1.0 - ema) * pcx
        cy = ema * cy + (1.0 - ema) * pcy
        size = ema * size + (1.0 - ema) * psz
        rot = ema * rot + (1.0 - ema) * prot
    STATE["raw_prev"] = cand["raw"]
    STATE["ema"] = (cx, cy, size, rot)
    cand["float_x"] = cx; cand["float_y"] = cy; cand["palm_size"] = size; cand["palm_rot"] = rot
    cand["ema"] = ema if prev else 1.0
    return cand

def _pinch_candidate(cand, candidates):
    base_hand = int(cand.get("hand", -1))
    best = None
    for other in candidates:
        if other is None or int(other.get("hand", -1)) == base_hand:
            continue
        pts = other.get("pts")
        if not pts:
            continue
        thumb = pts[4]; index = pts[8]
        midx = (thumb["x"] + index["x"]) * 0.5
        midy = (thumb["y"] + index["y"]) * 0.5
        d = _dist(thumb, index)
        close_dist = max(0.0001, _par_float("Pinchclosedist", DEFAULT_PINCH_CLOSE_DIST))
        open_dist = max(close_dist + 0.0001, _par_float("Pinchopendist", DEFAULT_PINCH_OPEN_DIST))
        pinch_close = _clamp((open_dist - d) / (open_dist - close_dist))
        radius = max(_par_float("Pinchradius", DEFAULT_PINCH_RADIUS), cand.get("palm_size", 0.10) * DEFAULT_PINCH_RADIUS_SCALE)
        dist_to_anchor = math.sqrt((midx - cand["float_x"]) ** 2 + (midy - cand["float_y"]) ** 2)
        near = _clamp((radius - dist_to_anchor) / max(0.001, radius))
        power = pinch_close * near
        if pinch_close < PINCH_CLOSE_MIN or near < PINCH_NEAR_MIN:
            power *= 0.35
        item = {
            "hand": other.get("hand", -1), "x": midx, "y": midy, "close": pinch_close,
            "near": near, "power_raw": power, "distance": d, "radius": radius,
        }
        if best is None or item["power_raw"] > best["power_raw"]:
            best = item
    return best

def _apply_pinch(cand, candidates):
    best = _pinch_candidate(cand, candidates)
    prev_power = float(STATE.get("pinch_power_ema", 0.0))
    raw = best["power_raw"] if best else 0.0
    measured = PINCH_POWER_EMA * raw + (1.0 - PINCH_POWER_EMA) * prev_power
    STATE["pinch_power_ema"] = measured
    now = absTime.seconds
    threshold = _par_float("Pinchthreshold", DEFAULT_PINCH_THRESHOLD)
    strong = bool(best and best["close"] >= PINCH_CLOSE_MIN and best["near"] >= PINCH_NEAR_MIN and measured >= threshold)
    arm_start = float(STATE.get("pinch_arm_start", -999.0))
    if strong:
        if arm_start < -100.0:
            arm_start = now
            STATE["pinch_arm_start"] = arm_start
    else:
        STATE["pinch_arm_start"] = -999.0
        arm_start = -999.0
    prev_active = bool(STATE.get("pinch_active", False))
    keep = bool(best and best["close"] >= PINCH_RELEASE_CLOSE_MIN and best["near"] >= PINCH_RELEASE_NEAR_MIN and measured >= PINCH_RELEASE_THRESHOLD)
    active = bool((strong and now - arm_start >= _par_float("Pincharmseconds", DEFAULT_PINCH_ARM_SECONDS)) or (prev_active and keep))
    STATE["pinch_active"] = active
    power = measured if active else 0.0
    scale = 1.0 + power * 1.4
    cand.update({
        "pinch_active": 1.0 if active else 0.0,
        "pinch_power": power,
        "pinch_measured": measured,
        "pinch_near": best["near"] if best else 0.0,
        "pinch_close": best["close"] if best else 0.0,
        "pinch_x": best["x"] if best else 0.0,
        "pinch_y": best["y"] if best else 0.0,
        "scale_target": scale,
        "light_gain": 1.0 + power * 1.15,
        "audio_level": cand.get("raw", 0.0) * (0.34 + power * 0.55),
    })
    return cand

def _hold_last():
    last = STATE.get("last_state")
    age = absTime.seconds - float(STATE.get("last_seen", -999.0))
    hold_seconds = _par_float("Holdseconds", DEFAULT_HOLD_SECONDS)
    if not isinstance(last, dict) or age < 0 or age > hold_seconds:
        return None
    held = dict(last)
    held["held_tracking"] = 1.0
    held["audio_level"] = float(held.get("audio_level", 0.0)) * _clamp(1.0 - age / max(0.001, hold_seconds))
    return held

def _detect(chop):
    if chop is None:
        return _empty()
    candidates = [_slot_candidate(chop, slot) for slot in range(HAND_COUNT)]
    best = _choose(candidates)
    if best:
        STATE["active_hand"] = int(best.get("hand", -1))
        best = _smooth(best)
        best = _apply_pinch(best, candidates)
        state = {
            "on": best["raw"], "has_hand": 1.0, "active_hand": float(best["hand"]),
            "palm_open": best["raw"], "palm_x": best["palm_x"], "palm_y": best["palm_y"],
            "float_x": best["float_x"], "float_y": best["float_y"],
            "palm_size": best["palm_size"], "palm_rot": best["palm_rot"],
            "palm_confidence": best["palm_confidence"], "held_tracking": 0.0,
            "pinch_active": best.get("pinch_active", 0.0), "pinch_power": best.get("pinch_power", 0.0),
            "pinch_measured": best.get("pinch_measured", 0.0), "pinch_near": best.get("pinch_near", 0.0),
            "pinch_close": best.get("pinch_close", 0.0), "pinch_x": best.get("pinch_x", 0.0),
            "pinch_y": best.get("pinch_y", 0.0), "scale_target": best.get("scale_target", 1.0),
            "light_gain": best.get("light_gain", 1.0), "audio_level": best.get("audio_level", 0.0),
        }
        STATE["last_seen"] = absTime.seconds
        STATE["last_state"] = dict(state)
        return state
    held = _hold_last()
    if held:
        return held
    STATE["active_hand"] = -1
    STATE["pinch_active"] = False
    STATE["pinch_power_ema"] = 0.0
    return _empty()

def onCook(scriptOp):
    scriptOp.clear()
    scriptOp.numSamples = 1
    chans = {name: scriptOp.appendChan(name) for name in CHANNELS}
    state = _detect(op(HAND_CHOP))
    for name in CHANNELS:
        chans[name][0] = float(state.get(name, 0.0))
    try:
        op(STATE_DAT).text = json.dumps(state, sort_keys=True)
    except Exception:
        pass
    return
"""

def _set_pos(node, x, y):
    try:
        node.nodeX = x
        node.nodeY = y
    except Exception:
        pass

def _place_comp_in_grid(parent, comp):
    try:
        cell_w, cell_h, rows = 260, 200, 6
        def _cell(child):
            return (
                round((child.nodeX + child.nodeWidth / 2.0) / cell_w),
                round(-(child.nodeY + child.nodeHeight / 2.0) / cell_h),
            )
        occupied = set()
        for child in parent.children:
            if child is not comp:
                occupied.add(_cell(child))
        k = 0
        while (k // rows, k % rows) in occupied:
            k += 1
        comp.nodeX = (k // rows) * cell_w
        comp.nodeY = -((k % rows) * cell_h)
    except Exception:
        try:
            siblings = [child for child in parent.children if child is not comp]
            comp.nodeX = len(siblings) * 260
            comp.nodeY = -450
        except Exception:
            _set_pos(comp, 0, -450)

def _safe_destroy_inputs(node):
    try:
        for conn in node.inputConnectors:
            conn.disconnect()
    except Exception:
        pass

def _safe_destroy_child(comp, name):
    try:
        node = comp.op(name)
        if node is not None:
            node.destroy()
    except Exception as exc:
        report["warnings"].append("Failed to remove unused %s: %s" % (name, exc))

def _connect(src, dst, idx=0):
    try:
        _safe_destroy_inputs(dst)
        dst.inputConnectors[idx].connect(src)
    except Exception as exc:
        report["warnings"].append("Failed to connect %s -> %s: %s" % (src.path, dst.path, exc))

def _parname(name):
    s = "".join(ch for ch in name if ch.isalnum())
    if not s:
        s = "Par"
    if not s[0].isalpha():
        s = "P" + s
    return s[0].upper() + s[1:].lower()

def _ensure_control(comp, page, name, typ, default, minv=None, maxv=None):
    par_name = _parname(name)
    if hasattr(comp.par, par_name):
        report["controls"].append({"name": name, "par": par_name, "type": typ})
        return
    try:
        if typ == "toggle":
            pars = page.appendToggle(par_name, label=name)
        else:
            pars = page.appendFloat(par_name, label=name)
        if pars is not None and len(pars) > 0:
            p = pars[0]
            try:
                if minv is not None:
                    p.min = minv
                    p.normMin = minv
                if maxv is not None:
                    p.max = maxv
                    p.normMax = maxv
                p.default = default
            except Exception:
                pass
            try:
                setattr(comp.par, par_name, default)
            except Exception:
                pass
        report["controls"].append({"name": name, "par": par_name, "type": typ})
    except Exception as exc:
        report["warnings"].append("Failed to add control %s: %s" % (name, exc))

def _node_errors(nodes):
    for node in nodes:
        try:
            err = str(node.errors())
            warn = str(node.warnings())
        except Exception:
            err = ""
            warn = ""
        if err:
            report["errors"].append("%s: %s" % (node.path, err))
        if warn:
            report["warnings"].append("%s: %s" % (node.path, warn))

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + _p["parent_path"]
    else:
        comp = parent.op(_p["comp_name"]) or parent.create(baseCOMP, _p["comp_name"])
        report["container_path"] = comp.path
        _place_comp_in_grid(parent, comp)

        if _p.get("expose_controls", True):
            page = None
            for pg in comp.customPages:
                if pg.name == "Hand Gesture":
                    page = pg
                    break
            if page is None:
                page = comp.appendCustomPage("Hand Gesture")
            _ensure_control(comp, page, "Smoothing", "float", _p["smoothing"], 0.0, 0.95)
            _ensure_control(comp, page, "FastSmoothing", "float", _p["fast_smoothing"], 0.0, 0.95)
            _ensure_control(comp, page, "HoldSeconds", "float", _p["hold_seconds"], 0.0, 1.0)
            _ensure_control(comp, page, "PinchArmSeconds", "float", _p["pinch_arm_seconds"], 0.0, 1.0)
            _ensure_control(comp, page, "PinchCloseDist", "float", _p["pinch_close_dist"], 0.001, 0.3)
            _ensure_control(comp, page, "PinchOpenDist", "float", _p["pinch_open_dist"], 0.001, 0.5)
            _ensure_control(comp, page, "PinchRadius", "float", _p["pinch_radius"], 0.01, 0.6)
            _ensure_control(comp, page, "PinchThreshold", "float", _p["pinch_threshold"], 0.0, 1.0)
            _ensure_control(comp, page, "ActiveHandLock", "toggle", _p["active_hand_lock"])

        created = []
        if _p["source"] == "synthetic":
            hand = comp.op("synthetic_hands") or comp.create(scriptCHOP, "synthetic_hands")
            hand_cb = comp.op("synthetic_hands_cb") or comp.create(textDAT, "synthetic_hands_cb")
            hand_cb.text = SYNTHETIC_CB.replace("__HAND_COUNT__", str(_p["max_hands"]))
            hand.par.callbacks = hand_cb.name
            _safe_destroy_child(comp, "synthetic_hands_callbacks")
            _set_pos(hand, -520, 160)
            _set_pos(hand_cb, -520, -20)
            created.extend([hand, hand_cb])
            hand_path = hand.path
        else:
            hand_path = _p.get("hand_chop") or ""
            source_op = op(hand_path)
            if source_op is None:
                report["fatal"] = "Hand CHOP not found: " + hand_path
            else:
                hand = comp.op("hand_in") or comp.create(selectCHOP, "hand_in")
                try:
                    hand.par.chop = hand_path
                except Exception as exc:
                    report["warnings"].append("Failed to set hand_in.chop: %s" % exc)
                _set_pos(hand, -520, 160)
                created.append(hand)
                hand_path = hand.path

        if not report.get("fatal"):
            state = comp.op("state_json") or comp.create(textDAT, "state_json")
            gesture = comp.op("gesture") or comp.create(scriptCHOP, "gesture")
            gesture_cb = comp.op("gesture_cb") or comp.create(textDAT, "gesture_cb")
            bus = comp.op("gesture_bus") or comp.create(nullCHOP, "gesture_bus")
            _set_pos(gesture_cb, -180, -20)
            _set_pos(gesture, -180, 160)
            _set_pos(bus, 140, 160)
            _set_pos(state, 140, -20)
            cb = GESTURE_CB
            replacements = {
                "__HAND_CHOP__": repr(hand_path),
                "__HAND_COUNT__": str(_p["max_hands"]),
                "__STATE_DAT__": repr(state.path),
                "__SMOOTHING__": repr(float(_p["smoothing"])),
                "__FAST_SMOOTHING__": repr(float(_p["fast_smoothing"])),
                "__HOLD_SECONDS__": repr(float(_p["hold_seconds"])),
                "__PINCH_ARM_SECONDS__": repr(float(_p["pinch_arm_seconds"])),
                "__PINCH_CLOSE_DIST__": repr(float(_p["pinch_close_dist"])),
                "__PINCH_OPEN_DIST__": repr(float(_p["pinch_open_dist"])),
                "__PINCH_RADIUS__": repr(float(_p["pinch_radius"])),
                "__PINCH_RADIUS_SCALE__": repr(float(_p["pinch_radius_scale"])),
                "__PINCH_THRESHOLD__": repr(float(_p["pinch_threshold"])),
                "__ACTIVE_HAND_LOCK__": "True" if _p["active_hand_lock"] else "False",
                "__MIRROR__": "True" if _p["mirror"] else "False",
            }
            for key, value in replacements.items():
                cb = cb.replace(key, value)
            gesture_cb.text = cb
            gesture.par.callbacks = gesture_cb.name
            _safe_destroy_child(comp, "gesture_callbacks")
            _connect(gesture, bus)
            created.extend([gesture, gesture_cb, bus, state])
            report["hand_chop"] = hand_path
            report["gesture_chop"] = gesture.path
            report["gesture_bus"] = bus.path
            report["state_dat"] = state.path
            _node_errors(created)
except Exception:
    report["fatal"] = traceback.format_exc()

print(json.dumps(report))
`;

const createHandGestureBusInputSchema = z.object({
  source: z.enum(["synthetic", "mediapipe", "existing_chop"]).default("synthetic"),
  parent_path: z.string().default("/project1"),
  comp_name: z.string().default("hand_gesture_bus"),
  hand_chop_path: z.string().optional(),
  tox_path: z.string().optional(),
  adapter_name: z.string().default("mp_hand_adapter"),
  max_hands: z.coerce.number().int().min(1).max(2).default(2),
  coordinate_space: z.enum(["world", "image"]).default("world"),
  mirror: z.boolean().default(true),
  smoothing: z.coerce.number().min(0).max(0.95).default(0.46),
  fast_smoothing: z.coerce.number().min(0).max(0.95).default(0.82),
  hold_seconds: z.coerce.number().min(0).max(1).default(0.16),
  pinch_arm_seconds: z.coerce.number().min(0).max(1).default(0.11),
  pinch_close_dist: z.coerce.number().positive().default(0.052),
  pinch_open_dist: z.coerce.number().positive().default(0.125),
  pinch_radius: z.coerce.number().positive().default(0.155),
  pinch_radius_scale: z.coerce.number().positive().default(2.25),
  pinch_threshold: z.coerce.number().min(0).max(1).default(0.38),
  active_hand_lock: z.boolean().default(true),
  expose_controls: z.boolean().default(true),
});

export const createHandGestureBusSchema = createHandGestureBusInputSchema.refine(
  (args) => args.pinch_open_dist > args.pinch_close_dist,
  {
    message: "pinch_open_dist must be greater than pinch_close_dist",
    path: ["pinch_open_dist"],
  },
);

type CreateHandGestureBusArgs = z.infer<typeof createHandGestureBusSchema>;

interface HandGestureBusReport {
  container_path: string;
  source: string;
  hand_chop?: string | null;
  gesture_chop: string;
  gesture_bus: string;
  state_dat: string;
  channels: string[];
  controls: Array<{ name: string; par: string; type: string }>;
  warnings: string[];
  errors: string[];
  fatal?: string;
}

function fallbackHandChop(parentPath: string, adapterName: string): string {
  return `${parentPath.replace(/\/$/, "")}/${adapterName}/hand`;
}

export async function createHandGestureBusImpl(
  ctx: ToolContext,
  args: CreateHandGestureBusArgs,
): Promise<CallToolResult> {
  let handChop =
    args.source === "existing_chop"
      ? args.hand_chop_path
      : (args.hand_chop_path ?? fallbackHandChop(args.parent_path, args.adapter_name));

  if (args.source === "existing_chop" && !handChop) {
    return errorResult("hand_chop_path is required when source='existing_chop'.");
  }

  if (args.source === "mediapipe" && !args.hand_chop_path) {
    const setupResult = await setupHandTrackingImpl(
      ctx,
      setupHandTrackingSchema.parse({
        tox_path: args.tox_path,
        parent_path: args.parent_path,
        max_hands: args.max_hands,
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
    source: args.source,
    parent_path: args.parent_path,
    comp_name: args.comp_name,
    hand_chop: handChop,
    max_hands: args.max_hands,
    coordinate_space: args.coordinate_space,
    mirror: args.mirror,
    smoothing: args.smoothing,
    fast_smoothing: args.fast_smoothing,
    hold_seconds: args.hold_seconds,
    pinch_arm_seconds: args.pinch_arm_seconds,
    pinch_close_dist: args.pinch_close_dist,
    pinch_open_dist: args.pinch_open_dist,
    pinch_radius: args.pinch_radius,
    pinch_radius_scale: args.pinch_radius_scale,
    pinch_threshold: args.pinch_threshold,
    active_hand_lock: args.active_hand_lock,
    expose_controls: args.expose_controls,
  };

  const script = buildPayloadScript(GESTURE_BUS_SCRIPT, payload);
  return guardTd(
    () => ctx.client.executePythonScript(script),
    ({ stdout }) => {
      const report = parsePythonReport<HandGestureBusReport>(stdout);
      if (report.fatal) {
        return errorResult(`create_hand_gesture_bus failed: ${report.fatal}`, report);
      }
      return jsonResult(
        `Hand gesture bus ready at ${report.gesture_bus}: ${HAND_GESTURE_CHANNELS.length} channels for palm, pinch, hold, scale, light, and audio control.`,
        report,
      );
    },
  );
}

export const registerCreateHandGestureBus: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_hand_gesture_bus",
    {
      title: "Create hand gesture bus",
      description:
        "Build a stable MediaPipe-hands gesture bus for palm holograms, lasers, audio controls, and other hand-reactive visuals. Outputs a Null CHOP with debounced palm and pinch channels: palm_open, float_x/y, palm_size, pinch_active, pinch_power, scale_target, light_gain, and audio_level. Defaults to a synthetic two-hand source so it previews without a camera; source='mediapipe' uses setup_hand_tracking.",
      inputSchema: createHandGestureBusInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHandGestureBusImpl(ctx, createHandGestureBusSchema.parse(args)),
  );
