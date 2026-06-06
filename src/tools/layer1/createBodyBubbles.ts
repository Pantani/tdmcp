import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import { installFrameCooker } from "./poseSource.js";

const q = (value: string): string => JSON.stringify(value);
const qn = (value: number): string => (Number.isFinite(value) ? value.toFixed(1) : "0.0");
const qi = (value: number): string => (Number.isFinite(value) ? value.toString() : "0");

const resolutionSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .default([1280, 720]);

const BODY_OUTLINE_CHAINS = [
  { points: [7, 11, 23, 25, 27, 31], closed: false },
  { points: [8, 12, 24, 26, 28, 32], closed: false },
  { points: [11, 12, 24, 23], closed: true },
  { points: [15, 13, 11, 12, 14, 16], closed: false },
  { points: [23, 24], closed: false },
  { points: [0, 7, 3, 2, 0, 5, 6, 8, 0], closed: false },
] as const;

const BODY_INTERACTION_RING_IDS = [0, 11, 12, 15, 16, 23, 24] as const;

export const createBodyBubblesSchema = z.object({
  name: z
    .string()
    .default("body_bubbles")
    .describe("Name for the generated bubble-physics Base COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the body-bubble system is created."),
  hand_chop_path: z
    .string()
    .optional()
    .describe(
      "Optional hand-tracking CHOP from setup_hand_tracking: 21 samples per hand with tx/ty/tz/confidence. Open palm emits bubbles.",
    ),
  body_chop_path: z
    .string()
    .optional()
    .describe(
      "Optional body/pose CHOP from setup_body_tracking or create_pose_tracking: 33 samples with tx/ty/tz/confidence. Landmarks collide with bubbles.",
    ),
  camera_top_path: z
    .string()
    .default("/project1/MediaPipe/video")
    .describe(
      "TOP to use as the visible camera background. The MediaPipe plugin exposes the live camera at /project1/MediaPipe/video.",
    ),
  show_camera_background: z
    .boolean()
    .default(true)
    .describe("Composite the camera TOP behind the body contour and bubbles."),
  hide_camera_tracking_overlays: z
    .boolean()
    .default(true)
    .describe(
      "When camera_top_path belongs to the MediaPipe plugin, turn off its built-in tracking overlays so only the clean camera appears behind this system.",
    ),
  camera_opacity: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Opacity for the camera background when show_camera_background is enabled."),
  bubble_count: z.coerce
    .number()
    .int()
    .min(1)
    .max(600)
    .default(45)
    .describe("Maximum number of live/recyclable bubbles in the simulation."),
  lifetime_seconds: z.coerce
    .number()
    .min(1)
    .max(120)
    .default(30)
    .describe("Seconds each bubble remains visible before popping and disappearing."),
  emit_on_open_palm: z
    .boolean()
    .default(true)
    .describe("When true, emit only while an open palm is detected in hand_chop_path."),
  fallback_to_pose_wrists: z
    .boolean()
    .default(false)
    .describe(
      "Optional fallback: when hand tracking has no landmarks, emit from pose wrist landmarks. Disabled by default so bubbles are created only by an open palm.",
    ),
  show_body_contour: z
    .boolean()
    .default(true)
    .describe(
      "Render the tracked body as a visible contour in the same output as the bubbles, so collisions read as performer interaction.",
    ),
  body_contour_width: z.coerce
    .number()
    .min(0)
    .max(20)
    .default(4)
    .describe("Line width in pixels for the visible body contour overlay."),
  hand_emit_rate: z.coerce
    .number()
    .min(0)
    .max(120)
    .default(8)
    .describe("Bubbles emitted per second while the palm is open."),
  palm_open_threshold: z.coerce
    .number()
    .min(0.001)
    .max(0.3)
    .default(0.08)
    .describe(
      "World-space average wrist-to-fingertip distance required to treat the hand as an open palm.",
    ),
  gravity: z.coerce
    .number()
    .min(-1)
    .max(1)
    .default(0.28)
    .describe("Downward acceleration in screen-space units per second squared."),
  body_radius: z.coerce
    .number()
    .min(0)
    .max(0.5)
    .default(0.11)
    .describe("Collision radius around each tracked body/hand landmark, in screen-space units."),
  wall_bounce: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.68)
    .describe("Energy retained when bubbles hit the left/right/top screen bounds."),
  floor_bounce: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.12)
    .describe("Energy retained when bubbles hit the lower screen floor."),
  drag: z.coerce
    .number()
    .min(0)
    .max(5)
    .default(0.95)
    .describe("Air drag applied to bubble velocity each second; higher settles faster."),
  buoyancy: z.coerce
    .number()
    .min(-1)
    .max(1)
    .default(0.04)
    .describe("Small upward force countering gravity; keep below gravity for weighted bubbles."),
  skeleton_impulse: z.coerce
    .number()
    .min(0)
    .max(3)
    .default(0.65)
    .describe("How strongly moving body/hand landmarks transfer motion to bubbles."),
  bubble_repulsion: z.coerce
    .number()
    .min(0)
    .max(2)
    .default(0.18)
    .describe("Soft collision force between bubbles so they do not collapse into one point."),
  tracking_smoothing: z.coerce
    .number()
    .min(0)
    .max(0.95)
    .default(0.55)
    .describe("Temporal smoothing for body/hand colliders inside the bubble solver."),
  output_resolution: resolutionSchema.describe(
    "Render resolution [width, height] for the output TOP.",
  ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live EmitRate/Gravity/BodyRadius/Lifetime/Bounce controls on the container."),
});

type CreateBodyBubblesArgs = z.infer<typeof createBodyBubblesSchema>;

function cameraOverlayScript(args: CreateBodyBubblesArgs): string {
  return [
    `CAMERA_TOP_PATH = ${q(args.camera_top_path)}`,
    `HIDE_CAMERA_TRACKING_OVERLAYS = ${args.hide_camera_tracking_overlays ? "True" : "False"}`,
    "if HIDE_CAMERA_TRACKING_OVERLAYS and CAMERA_TOP_PATH:",
    "    _n = op(CAMERA_TOP_PATH)",
    "    while _n is not None:",
    "        if _n.name == 'MediaPipe':",
    "            for _name, _value in [('Showoverlays', False), ('overlay', False)]:",
    "                try:",
    "                    _p = getattr(_n.par, _name, None)",
    "                    if _p is not None:",
    "                        _p.val = _value",
    "                except Exception:",
    "                    pass",
    "            break",
    "        _n = _n.parent()",
  ].join("\n");
}

function bubbleSimCallback(args: CreateBodyBubblesArgs): string {
  return [
    "import math, random",
    `HAND_PATH = ${q(args.hand_chop_path ?? "")}`,
    `BODY_PATH = ${q(args.body_chop_path ?? "")}`,
    `COUNT = ${qi(args.bubble_count)}`,
    `LIFETIME = ${qn(args.lifetime_seconds)}`,
    `EMIT_ON_OPEN_PALM = ${args.emit_on_open_palm ? "True" : "False"}`,
    `FALLBACK_TO_POSE_WRISTS = ${args.fallback_to_pose_wrists ? "True" : "False"}`,
    `EMIT_RATE = ${qi(args.hand_emit_rate)}`,
    `PALM_OPEN_THRESHOLD = ${args.palm_open_threshold}`,
    `GRAVITY = ${args.gravity}`,
    `BODY_RADIUS = ${args.body_radius}`,
    `WALL_BOUNCE = ${args.wall_bounce}`,
    `FLOOR_BOUNCE = ${args.floor_bounce}`,
    `DRAG = ${args.drag}`,
    `BUOYANCY = ${args.buoyancy}`,
    `SKELETON_IMPULSE = ${args.skeleton_impulse}`,
    `BUBBLE_REPULSION = ${args.bubble_repulsion}`,
    `TRACKING_SMOOTHING = ${args.tracking_smoothing}`,
    `OPEN_THRESHOLD = ${args.palm_open_threshold}`,
    "HAND_CONFIDENCE_THRESHOLD = 0.05",
    "BODY_CONFIDENCE_THRESHOLD = 0.35",
    "BODY_MIN_HEIGHT = 0.55",
    "STATE_KEY = 'BODY_BUBBLES_STATE_' + str(id(me))",
    "STATE = globals().setdefault(STATE_KEY, {'bubbles': [], 'last_t': None, 'emit_accum': 0.0, 'last_colliders': {}, 'smooth_points': {}})",
    "",
    "def _control(name, default):",
    "    try:",
    "        par = getattr(parent().par, name, None)",
    "        if par is not None:",
    "            return float(par.eval())",
    "    except Exception:",
    "        pass",
    "    return float(default)",
    "",
    "def _chan(chop, name):",
    "    try:",
    "        return chop[name]",
    "    except Exception:",
    "        return None",
    "",
    "def _read_points(path, limit, min_confidence):",
    "    if not path:",
    "        return []",
    "    c = op(path)",
    "    if c is None:",
    "        return []",
    "    try:",
    "        c.cook(force=True)",
    "    except Exception:",
    "        pass",
    "    sx = _chan(c, 'screen_x'); sy = _chan(c, 'screen_y')",
    "    tx = _chan(c, 'tx'); ty = _chan(c, 'ty'); tz = _chan(c, 'tz'); cf = _chan(c, 'confidence')",
    "    if tx is None or ty is None:",
    "        return []",
    "    n = min(int(getattr(c, 'numSamples', 0)), limit)",
    "    pts = []",
    "    for i in range(n):",
    "        try:",
    "            conf = float(cf[i]) if cf is not None else 1.0",
    "            if conf < min_confidence:",
    "                continue",
    "            if sx is not None and sy is not None:",
    "                x = max(-1.12, min(1.12, float(sx[i])))",
    "                y = max(-1.12, min(1.12, float(sy[i])))",
    "            else:",
    "                x = max(-1.12, min(1.12, float(tx[i])))",
    "                y = max(-1.12, min(1.12, float(ty[i])))",
    "            z = float(tz[i]) if tz is not None else 0.0",
    "            pts.append({'id': i, 'x': x, 'y': y, 'z': z, 'confidence': conf})",
    "        except Exception:",
    "            pass",
    "    return pts",
    "",
    "def _dist(a, b):",
    "    return math.sqrt((a['x'] - b['x']) ** 2 + (a['y'] - b['y']) ** 2)",
    "",
    "def _hand_slots(points):",
    "    slots = []",
    "    for base in range(0, len(points), 21):",
    "        slot = points[base:base + 21]",
    "        if len(slot) >= 21:",
    "            slots.append(slot)",
    "    return slots",
    "",
    "def _has_body_anchor(points):",
    "    ids = set([p.get('id') for p in points])",
    "    shoulders = 11 in ids and 12 in ids",
    "    hips = 23 in ids and 24 in ids",
    "    wrists = 15 in ids or 16 in ids",
    "    if not (shoulders and (hips or wrists)):",
    "        return False",
    "    ys = [p['y'] for p in points]",
    "    return (max(ys) - min(ys)) >= BODY_MIN_HEIGHT",
    "",
    "def _palm_spread(slot):",
    "    wrist = slot[0]",
    "    tips = [slot[i] for i in [4, 8, 12, 16, 20]]",
    "    return sum(_dist(wrist, tip) for tip in tips) / float(len(tips))",
    "",
    "def _finger_extension_score(slot):",
    "    if len(slot) < 21:",
    "        return 0.0",
    "    wrist = slot[0]",
    "    palm_ref = max(_dist(slot[5], slot[17]), _dist(wrist, slot[9]), 0.001)",
    "    extended = 0",
    "    for tip_idx, mid_idx in [(4, 3), (8, 6), (12, 10), (16, 14), (20, 18)]:",
    "        tip_len = _dist(wrist, slot[tip_idx])",
    "        mid_len = _dist(wrist, slot[mid_idx])",
    "        if tip_len > palm_ref * 1.05 and tip_len > mid_len * 1.08:",
    "            extended += 1",
    "    return float(extended) / 5.0",
    "",
    "def _open_palm(slot, threshold):",
    "    return _palm_spread(slot) >= threshold or _finger_extension_score(slot) >= 0.8",
    "",
    "def _palm_center(slot):",
    "    ids = [0, 5, 9, 13, 17]",
    "    x = sum(slot[i]['x'] for i in ids) / float(len(ids))",
    "    y = sum(slot[i]['y'] for i in ids) / float(len(ids))",
    "    return {'x': x, 'y': y}",
    "",
    "def _pose_wrist_fallback(body_points):",
    "    # Keeps the installation alive when the MediaPipe hand detector drops out.",
    "    wrists = []",
    "    for wanted in [15, 16]:",
    "        for p in body_points:",
    "            if p.get('id') == wanted:",
    "                wrists.append({'x': p['x'], 'y': p['y']})",
    "                break",
    "    return wrists",
    "",
    "def _smooth_points(label, points, smoothing, hold_seconds):",
    "    cache_root = STATE.setdefault('smooth_points', {})",
    "    cache = cache_root.setdefault(label, {})",
    "    now = absTime.seconds",
    "    alpha = max(0.0, min(0.95, smoothing))",
    "    live = set()",
    "    out = []",
    "    for p in points:",
    "        key = str(p.get('id', len(out)))",
    "        live.add(key)",
    "        prev = cache.get(key)",
    "        if prev is None:",
    "            x = p['x']; y = p['y']; z = p.get('z', 0.0)",
    "        else:",
    "            x = prev[0] * alpha + p['x'] * (1.0 - alpha)",
    "            y = prev[1] * alpha + p['y'] * (1.0 - alpha)",
    "            z = prev[2] * alpha + p.get('z', 0.0) * (1.0 - alpha)",
    "        conf = p.get('confidence', 1.0)",
    "        cache[key] = (x, y, z, conf, now)",
    "        out.append({'id': p.get('id'), 'key': label + ':' + key, 'x': x, 'y': y, 'z': z, 'confidence': conf})",
    "    for key, prev in list(cache.items()):",
    "        if key in live:",
    "            continue",
    "        age = now - float(prev[4])",
    "        if age <= hold_seconds:",
    "            out.append({'id': int(key) if key.isdigit() else key, 'key': label + ':' + key, 'x': prev[0], 'y': prev[1], 'z': prev[2], 'confidence': prev[3] * 0.55})",
    "        else:",
    "            del cache[key]",
    "    return out",
    "",
    "def _ensure_bubbles():",
    "    bubbles = STATE['bubbles']",
    "    while len(bubbles) < COUNT:",
    "        bubbles.append({'x': 0.0, 'y': -2.0, 'vx': 0.0, 'vy': 0.0, 'age': LIFETIME + 1.0, 'radius': 0.025, 'mass': 1.0, 'alive': False})",
    "    if len(bubbles) > COUNT:",
    "        del bubbles[COUNT:]",
    "",
    "def _spawn(x, y):",
    "    bubbles = STATE['bubbles']",
    "    dead = [b for b in bubbles if not b['alive']]",
    "    b = dead[0] if dead else max(bubbles, key=lambda item: item['age'])",
    "    b['x'] = max(-0.92, min(0.92, x + random.uniform(-0.045, 0.045)))",
    "    b['y'] = max(-0.82, min(0.86, y + random.uniform(-0.035, 0.035)))",
    "    b['vx'] = random.uniform(-0.08, 0.08)",
    "    b['vy'] = random.uniform(0.02, 0.13)",
    "    b['age'] = 0.0",
    "    b['radius'] = random.uniform(0.024, 0.064)",
    "    b['mass'] = max(0.65, min(1.8, 0.75 + b['radius'] * 18.0))",
    "    b['alive'] = True",
    "",
    "def _collider_velocities(colliders, dt):",
    "    prev = STATE.get('last_colliders', {})",
    "    next_prev = {}",
    "    out = []",
    "    for c in colliders:",
    "        key = str(c.get('key', c['id']))",
    "        old = prev.get(key)",
    "        vx = 0.0; vy = 0.0",
    "        if old is not None and dt > 0:",
    "            vx = (c['x'] - old[0]) / dt",
    "            vy = (c['y'] - old[1]) / dt",
    "        next_prev[key] = (c['x'], c['y'])",
    "        out.append({'x': c['x'], 'y': c['y'], 'vx': vx, 'vy': vy})",
    "    STATE['last_colliders'] = next_prev",
    "    return out",
    "",
    "def _cap_velocity(b):",
    "    max_speed = 2.2",
    "    sp = math.sqrt(b['vx'] * b['vx'] + b['vy'] * b['vy'])",
    "    if sp > max_speed:",
    "        scale = max_speed / sp",
    "        b['vx'] *= scale; b['vy'] *= scale",
    "",
    "def _apply_bounds(b, wall_bounce, floor_bounce, floor_y, dt):",
    "    r = b['radius']",
    "    if b['x'] < -1.0 + r:",
    "        b['x'] = -1.0 + r",
    "        b['vx'] = abs(b['vx']) * wall_bounce",
    "    elif b['x'] > 1.0 - r:",
    "        b['x'] = 1.0 - r",
    "        b['vx'] = -abs(b['vx']) * wall_bounce",
    "    if b['y'] > 1.0 - r:",
    "        b['y'] = 1.0 - r",
    "        b['vy'] = -abs(b['vy']) * wall_bounce",
    "    if b['y'] < floor_y + r:",
    "        b['y'] = floor_y + r",
    "        if b['vy'] < 0.0:",
    "            b['vy'] = -b['vy'] * floor_bounce",
    "        if abs(b['vy']) < 0.028:",
    "            b['vy'] = 0.0",
    "        b['vx'] *= max(0.0, 1.0 - 3.4 * dt)",
    "",
    "def _separate_bubbles(dt, repulsion, floor_y, wall_bounce, floor_bounce):",
    "    if repulsion <= 0.0:",
    "        return",
    "    active = [b for b in STATE['bubbles'] if b['alive']]",
    "    n = len(active)",
    "    for i in range(n):",
    "        a = active[i]",
    "        for j in range(i + 1, n):",
    "            b = active[j]",
    "            dx = b['x'] - a['x']; dy = b['y'] - a['y']",
    "            d = math.sqrt(dx * dx + dy * dy)",
    "            target = a['radius'] + b['radius'] + 0.006",
    "            if d >= target:",
    "                continue",
    "            if d < 1e-5:",
    "                nx = random.uniform(-1.0, 1.0); ny = random.uniform(-1.0, 1.0)",
    "                mag = math.sqrt(nx * nx + ny * ny) or 1.0",
    "                nx /= mag; ny /= mag; d = target * 0.35",
    "            else:",
    "                nx = dx / d; ny = dy / d",
    "            push = (target - d) * 0.5 * repulsion",
    "            a['x'] -= nx * push; a['y'] -= ny * push",
    "            b['x'] += nx * push; b['y'] += ny * push",
    "            impulse = push / max(dt, 1.0 / 240.0) * 0.018",
    "            a['vx'] -= nx * impulse; a['vy'] -= ny * impulse",
    "            b['vx'] += nx * impulse; b['vy'] += ny * impulse",
    "            _cap_velocity(a); _cap_velocity(b)",
    "            _apply_bounds(a, wall_bounce, floor_bounce, floor_y, dt)",
    "            _apply_bounds(b, wall_bounce, floor_bounce, floor_y, dt)",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    _ensure_bubbles()",
    "    t = absTime.seconds",
    "    last = STATE.get('last_t')",
    "    dt = 1.0 / 60.0 if last is None else max(1.0 / 240.0, min(1.0 / 20.0, t - last))",
    "    STATE['last_t'] = t",
    "    emit_rate = _control('Emitrate', EMIT_RATE)",
    "    palm_threshold = max(0.001, min(0.3, _control('Palmthreshold', PALM_OPEN_THRESHOLD)))",
    "    gravity = _control('Gravity', GRAVITY)",
    "    body_radius = _control('Bodyradius', BODY_RADIUS)",
    "    lifetime = max(1.0, _control('Lifetime', LIFETIME))",
    "    wall_bounce = max(0.0, min(1.0, _control('Wallbounce', WALL_BOUNCE)))",
    "    floor_bounce = max(0.0, min(1.0, _control('Floorbounce', FLOOR_BOUNCE)))",
    "    drag = max(0.0, min(5.0, _control('Drag', DRAG)))",
    "    buoyancy = max(-1.0, min(1.0, _control('Buoyancy', BUOYANCY)))",
    "    skeleton_impulse = max(0.0, min(3.0, _control('Skeletonimpulse', SKELETON_IMPULSE)))",
    "    bubble_repulsion = max(0.0, min(2.0, _control('Bubblerepulsion', BUBBLE_REPULSION)))",
    "    tracking_smoothing = max(0.0, min(0.95, _control('Trackingsmoothing', TRACKING_SMOOTHING)))",
    "    floor_y = -0.92",
    "",
    "    raw_hand_points = _read_points(HAND_PATH, 42, HAND_CONFIDENCE_THRESHOLD)",
    "    raw_body_points = _read_points(BODY_PATH, 33, BODY_CONFIDENCE_THRESHOLD)",
    "    if raw_body_points and not _has_body_anchor(raw_body_points):",
    "        raw_body_points = []",
    "    hand_points = _smooth_points('hand', raw_hand_points, tracking_smoothing, 0.25)",
    "    body_points = _smooth_points('body', raw_body_points, tracking_smoothing, 0.35)",
    "    open_palm = False",
    "    max_palm_spread = 0.0",
    "    emit_points = []",
    "    for slot in _hand_slots(hand_points):",
    "        spread = _palm_spread(slot)",
    "        max_palm_spread = max(max_palm_spread, spread)",
    "        if _open_palm(slot, palm_threshold):",
    "            open_palm = True",
    "            emit_points.append(_palm_center(slot))",
    "    if not open_palm and FALLBACK_TO_POSE_WRISTS and body_points:",
    "        for p in _pose_wrist_fallback(body_points):",
    "            emit_points.append(p)",
    "        if emit_points:",
    "            open_palm = True",
    "    if not EMIT_ON_OPEN_PALM and not emit_points:",
    "        emit_points.append({'x': 0.0, 'y': 0.2})",
    "        open_palm = True",
    "",
    "    if open_palm and emit_points and emit_rate > 0:",
    "        STATE['emit_accum'] += emit_rate * dt",
    "        spawn_count = min(12, int(STATE['emit_accum']))",
    "        STATE['emit_accum'] -= spawn_count",
    "        for i in range(spawn_count):",
    "            p = emit_points[i % len(emit_points)]",
    "            _spawn(p['x'], p['y'])",
    "    else:",
    "        STATE['emit_accum'] = min(STATE['emit_accum'], 1.0)",
    "",
    "    colliders = _collider_velocities(body_points + hand_points, dt)",
    "    for b in STATE['bubbles']:",
    "        if not b['alive']:",
    "            continue",
    "        b['mass'] = max(0.5, float(b.get('mass', 1.0)))",
    "        b['age'] += dt",
    "        if b['age'] >= lifetime:",
    "            b['alive'] = False",
    "            continue",
    "        net_gravity = (gravity - buoyancy) / b['mass']",
    "        b['vy'] -= net_gravity * dt",
    "        drag_factor = max(0.0, 1.0 - drag * dt)",
    "        b['vx'] *= drag_factor",
    "        b['vy'] *= drag_factor",
    "        b['x'] += b['vx'] * dt",
    "        b['y'] += b['vy'] * dt",
    "        _apply_bounds(b, wall_bounce, floor_bounce, floor_y, dt)",
    "        for c in colliders:",
    "            dx = b['x'] - c['x']; dy = b['y'] - c['y']",
    "            d = math.sqrt(dx * dx + dy * dy)",
    "            hit = body_radius + b['radius']",
    "            if d < hit:",
    "                if d <= 1e-6:",
    "                    nx = random.uniform(-1.0, 1.0); ny = random.uniform(-1.0, 1.0)",
    "                    mag = math.sqrt(nx * nx + ny * ny) or 1.0",
    "                    nx /= mag; ny /= mag; d = hit * 0.35",
    "                else:",
    "                    nx = dx / d; ny = dy / d",
    "                push = hit - d",
    "                b['x'] += nx * push * 0.72",
    "                b['y'] += ny * push * 0.72",
    "                rel_vx = b['vx'] - c['vx']; rel_vy = b['vy'] - c['vy']",
    "                closing = rel_vx * nx + rel_vy * ny",
    "                if closing < 0.0:",
    "                    bounce = -closing * 0.45",
    "                    b['vx'] += nx * bounce",
    "                    b['vy'] += ny * bounce",
    "                b['vx'] += c['vx'] * 0.16 * skeleton_impulse",
    "                b['vy'] += c['vy'] * 0.16 * skeleton_impulse",
    "                b['vy'] += max(0.0, c['vy']) * 0.18 * skeleton_impulse",
    "                _cap_velocity(b)",
    "                _apply_bounds(b, wall_bounce, floor_bounce, floor_y, dt)",
    "        _cap_velocity(b)",
    "    _separate_bubbles(dt, bubble_repulsion, floor_y, wall_bounce, floor_bounce)",
    "",
    "    scriptOp.numSamples = COUNT",
    "    x = scriptOp.appendChan('x'); y = scriptOp.appendChan('y')",
    "    vx = scriptOp.appendChan('vx'); vy = scriptOp.appendChan('vy')",
    "    radius = scriptOp.appendChan('radius'); alpha = scriptOp.appendChan('alpha')",
    "    alive = scriptOp.appendChan('alive'); age = scriptOp.appendChan('age')",
    "    palm = scriptOp.appendChan('open_palm')",
    "    spread = scriptOp.appendChan('palm_spread')",
    "    for i, b in enumerate(STATE['bubbles']):",
    "        fade = max(0.0, min(1.0, (lifetime - b['age']) / 1.2)) if b['alive'] else 0.0",
    "        birth = max(0.0, min(1.0, b['age'] * 8.0)) if b['alive'] else 0.0",
    "        pop = 1.0 + (1.0 - fade) * 1.75",
    "        x[i] = b['x'] if b['alive'] else 0.0",
    "        y[i] = b['y'] if b['alive'] else -2.0",
    "        vx[i] = b['vx'] if b['alive'] else 0.0",
    "        vy[i] = b['vy'] if b['alive'] else 0.0",
    "        radius[i] = b['radius'] * pop if b['alive'] else 0.0",
    "        alpha[i] = birth * fade",
    "        alive[i] = 1.0 if b['alive'] else 0.0",
    "        age[i] = b['age']",
    "        palm[i] = 1.0 if open_palm else 0.0",
    "        spread[i] = max_palm_spread",
    "    return",
    "",
  ].join("\n");
}

function bodyContourSopCallback(args: CreateBodyBubblesArgs, containerPath: string): string {
  return [
    "import json, math",
    `BODY_CONTOUR_PATH = ${q(args.body_chop_path ?? "")}`,
    `SYSTEM_PATH = ${q(containerPath)}`,
    `SHOW_BODY_CONTOUR = ${args.show_body_contour ? "True" : "False"}`,
    `BODY_RADIUS = ${args.body_radius}`,
    `BODY_OUTLINE_CHAINS = json.loads(${q(JSON.stringify(BODY_OUTLINE_CHAINS))})`,
    `INTERACTION_RING_IDS = json.loads(${q(JSON.stringify(BODY_INTERACTION_RING_IDS))})`,
    "BODY_CONTOUR_HOLD_SECONDS = 0.0",
    "BODY_CONTOUR_CONFIDENCE_THRESHOLD = 0.35",
    "BODY_CONTOUR_MIN_HEIGHT = 0.55",
    "STATE_KEY = 'BODY_CONTOUR_STATE_' + str(id(me))",
    "STATE = globals().setdefault(STATE_KEY, {'points': [], 'last_t': -9999.0})",
    "RING_SEGMENTS = 18",
    "",
    "def _control(name, default):",
    "    comp = op(SYSTEM_PATH)",
    "    if comp is not None:",
    "        try:",
    "            par = getattr(comp.par, name, None)",
    "            if par is not None:",
    "                return float(par.eval())",
    "        except Exception:",
    "            pass",
    "    return float(default)",
    "",
    "def _chan(chop, name):",
    "    try:",
    "        return chop[name]",
    "    except Exception:",
    "        return None",
    "",
    "def _read_pose():",
    "    if not BODY_CONTOUR_PATH:",
    "        return []",
    "    pose = op(BODY_CONTOUR_PATH)",
    "    if pose is None or pose.numSamples < 1:",
    "        return []",
    "    try:",
    "        pose.cook(force=True)",
    "    except Exception:",
    "        pass",
    "    sx = _chan(pose, 'screen_x'); sy = _chan(pose, 'screen_y')",
    "    tx = _chan(pose, 'tx'); ty = _chan(pose, 'ty'); tz = _chan(pose, 'tz'); cf = _chan(pose, 'confidence')",
    "    if tx is None or ty is None:",
    "        return []",
    "    pts = []",
    "    for i in range(min(int(pose.numSamples), 33)):",
    "        try:",
    "            conf = float(cf[i]) if cf is not None else 1.0",
    "            if conf < BODY_CONTOUR_CONFIDENCE_THRESHOLD:",
    "                pts.append(None)",
    "                continue",
    "            if sx is not None and sy is not None:",
    "                x = max(-0.98, min(0.98, float(sx[i])))",
    "                y = max(-0.98, min(0.98, float(sy[i])))",
    "            else:",
    "                x = max(-0.98, min(0.98, float(tx[i])))",
    "                y = max(-0.98, min(0.98, float(ty[i])))",
    "            z = float(tz[i]) if tz is not None else 0.0",
    "            pts.append({'x': x, 'y': y, 'z': z, 'confidence': conf})",
    "        except Exception:",
    "            pts.append(None)",
    "    if any(p is not None for p in pts):",
    "        STATE['points'] = pts",
    "        STATE['last_t'] = absTime.seconds",
    "    return pts",
    "",
    "def _held_pose(points):",
    "    if any(p is not None for p in points):",
    "        return points",
    "    last = STATE.get('points') or []",
    "    if BODY_CONTOUR_HOLD_SECONDS > 0.0 and last and absTime.seconds - float(STATE.get('last_t', -9999.0)) <= BODY_CONTOUR_HOLD_SECONDS:",
    "        return last",
    "    return points",
    "",
    "def _has_pose_anchor(points):",
    "    valid = [p for p in points if p is not None]",
    "    if not valid:",
    "        return False",
    "    shoulders = _point(points, 11) is not None and _point(points, 12) is not None",
    "    hips = _point(points, 23) is not None and _point(points, 24) is not None",
    "    wrists = _point(points, 15) is not None or _point(points, 16) is not None",
    "    if not (shoulders and (hips or wrists)):",
    "        return False",
    "    ys = [p['y'] for p in valid]",
    "    return (max(ys) - min(ys)) >= BODY_CONTOUR_MIN_HEIGHT",
    "",
    "def _point(points, idx):",
    "    if idx < 0 or idx >= len(points):",
    "        return None",
    "    return points[idx]",
    "",
    "def _append_polyline(scriptOp, points, chain, closed=False):",
    "    valid = []",
    "    for idx in chain:",
    "        p = _point(points, int(idx))",
    "        if p is not None:",
    "            valid.append(p)",
    "    if len(valid) < 2:",
    "        return",
    "    pts = []",
    "    for src in valid:",
    "        pt = scriptOp.appendPoint()",
    "        pt.x = src['x']; pt.y = src['y']; pt.z = -0.035",
    "        pts.append(pt)",
    "    poly = scriptOp.appendPoly(len(valid), closed=closed, addPoints=False)",
    "    for i, pt in enumerate(pts):",
    "        poly[i].point = pt",
    "",
    "def _append_ring(scriptOp, center, radius):",
    "    if center is None:",
    "        return",
    "    pts = []",
    "    for i in range(RING_SEGMENTS):",
    "        a = (float(i) / float(RING_SEGMENTS)) * math.pi * 2.0",
    "        pt = scriptOp.appendPoint()",
    "        pt.x = center['x'] + math.cos(a) * radius",
    "        pt.y = center['y'] + math.sin(a) * radius",
    "        pt.z = -0.034",
    "        pts.append(pt)",
    "    poly = scriptOp.appendPoly(RING_SEGMENTS, closed=True, addPoints=False)",
    "    for i, pt in enumerate(pts):",
    "        poly[i].point = pt",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    if _control('Bodycontour', 1.0 if SHOW_BODY_CONTOUR else 0.0) < 0.5:",
    "        return",
    "    points = _held_pose(_read_pose())",
    "    if not points or not _has_pose_anchor(points):",
    "        return",
    "    for spec in BODY_OUTLINE_CHAINS:",
    "        _append_polyline(scriptOp, points, spec.get('points', []), bool(spec.get('closed', False)))",
    "    ring_radius = max(0.015, min(0.14, _control('Bodyradius', BODY_RADIUS) * 0.55))",
    "    for idx in INTERACTION_RING_IDS:",
    "        _append_ring(scriptOp, _point(points, int(idx)), ring_radius)",
    "    return",
    "",
  ].join("\n");
}

function bubbleSopCallback(simPath: string): string {
  return [
    "import math",
    `SIM_PATH = ${q(simPath)}`,
    "SEGMENTS = 22",
    "",
    "def _chan(chop, name):",
    "    try:",
    "        return chop[name]",
    "    except Exception:",
    "        return None",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    sim = op(SIM_PATH)",
    "    if sim is None or sim.numSamples < 1:",
    "        return",
    "    x = _chan(sim, 'x'); y = _chan(sim, 'y')",
    "    radius = _chan(sim, 'radius'); alpha = _chan(sim, 'alpha'); alive = _chan(sim, 'alive')",
    "    if x is None or y is None or radius is None or alpha is None or alive is None:",
    "        return",
    "    for i in range(sim.numSamples):",
    "        try:",
    "            if float(alive[i]) < 0.5 or float(alpha[i]) <= 0.02:",
    "                continue",
    "            cx = float(x[i]); cy = float(y[i]); r = max(0.002, float(radius[i]))",
    "            pts = []",
    "            for j in range(SEGMENTS):",
    "                a = (float(j) / float(SEGMENTS)) * math.pi * 2.0",
    "                p = scriptOp.appendPoint()",
    "                p.x = cx + math.cos(a) * r",
    "                p.y = cy + math.sin(a) * r",
    "                p.z = 0.0",
    "                pts.append(p)",
    "            poly = scriptOp.appendPoly(SEGMENTS, closed=True, addPoints=False)",
    "            for j, p in enumerate(pts):",
    "                poly[j].point = p",
    "        except Exception:",
    "            pass",
    "    return",
    "",
  ].join("\n");
}

function controlsFor(
  args: CreateBodyBubblesArgs,
  bodyLineMat?: string,
  cameraLevel?: string,
): ControlSpec[] {
  if (!args.expose_controls) return [];
  const controls: ControlSpec[] = [
    {
      name: "EmitRate",
      type: "float",
      min: 0,
      max: 80,
      default: args.hand_emit_rate,
      bind_to: [],
    },
    {
      name: "PalmThreshold",
      type: "float",
      min: 0.001,
      max: 0.3,
      default: args.palm_open_threshold,
      bind_to: [],
    },
    {
      name: "Gravity",
      type: "float",
      min: -0.2,
      max: 0.5,
      default: args.gravity,
      bind_to: [],
    },
    {
      name: "BodyRadius",
      type: "float",
      min: 0,
      max: 0.25,
      default: args.body_radius,
      bind_to: [],
    },
    {
      name: "Drag",
      type: "float",
      min: 0,
      max: 5,
      default: args.drag,
      bind_to: [],
    },
    {
      name: "Buoyancy",
      type: "float",
      min: -1,
      max: 1,
      default: args.buoyancy,
      bind_to: [],
    },
    {
      name: "SkeletonImpulse",
      type: "float",
      min: 0,
      max: 3,
      default: args.skeleton_impulse,
      bind_to: [],
    },
    {
      name: "BubbleRepulsion",
      type: "float",
      min: 0,
      max: 2,
      default: args.bubble_repulsion,
      bind_to: [],
    },
    {
      name: "TrackingSmoothing",
      type: "float",
      min: 0,
      max: 0.95,
      default: args.tracking_smoothing,
      bind_to: [],
    },
    {
      name: "Lifetime",
      type: "float",
      min: 1,
      max: 120,
      default: args.lifetime_seconds,
      bind_to: [],
    },
    {
      name: "WallBounce",
      type: "float",
      min: 0,
      max: 1,
      default: args.wall_bounce,
      bind_to: [],
    },
    {
      name: "FloorBounce",
      type: "float",
      min: 0,
      max: 1,
      default: args.floor_bounce,
      bind_to: [],
    },
    {
      name: "BodyContour",
      type: "toggle",
      default: args.show_body_contour ? 1 : 0,
      bind_to: [],
    },
    {
      name: "ContourWidth",
      type: "float",
      min: 0,
      max: 20,
      default: args.body_contour_width,
      bind_to: bodyLineMat ? [`${bodyLineMat}.widthnear`] : [],
    },
  ];
  if (args.show_camera_background) {
    controls.push({
      name: "CameraOpacity",
      type: "float",
      min: 0,
      max: 1,
      default: args.camera_opacity,
      bind_to: cameraLevel ? [`${cameraLevel}.opacity`] : [],
    });
  }
  return controls;
}

export async function createBodyBubblesImpl(ctx: ToolContext, args: CreateBodyBubblesArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [width, height] = args.output_resolution;

    const sim = await builder.add("scriptCHOP", "bubble_sim");
    const simCb = await builder.add("textDAT", "bubble_sim_cb");

    const geo = await builder.add("geometryCOMP", "bubbles_geo");
    const sop = await builder.add("scriptSOP", "bubble_sop", undefined, geo);
    const sopCb = await builder.add("textDAT", "bubble_sop_cb", undefined, geo);

    const bodyGeo = await builder.add("geometryCOMP", "body_outline_geo");
    const bodySop = await builder.add("scriptSOP", "body_outline_sop", undefined, bodyGeo);
    const bodySopCb = await builder.add("textDAT", "body_outline_sop_cb", undefined, bodyGeo);

    await builder.python(
      [
        `_sim_cb = op(${q(simCb)})`,
        `_sim_cb.text = ${q(bubbleSimCallback(args))}`,
        `_sim = op(${q(sim)})`,
        "_sim.par.callbacks = _sim_cb.name",
        `_sop_cb = op(${q(sopCb)})`,
        `_sop_cb.text = ${q(bubbleSopCallback(sim))}`,
        `_sop = op(${q(sop)})`,
        "_sop.par.callbacks = _sop_cb.name",
        "_sop.render = True",
        "_sop.display = True",
        `_body_cb = op(${q(bodySopCb)})`,
        `_body_cb.text = ${q(bodyContourSopCallback(args, builder.containerPath))}`,
        `_body_sop = op(${q(bodySop)})`,
        "_body_sop.par.callbacks = _body_cb.name",
        "_body_sop.render = True",
        "_body_sop.display = True",
      ].join("\n"),
    );

    const mat = await builder.add("lineMAT", "bubble_line", {
      linenearcolorr: 0.84,
      linenearcolorg: 0.98,
      linenearcolorb: 1,
      widthnear: 2.4,
    });
    await builder.setParams(geo, { material: mat });

    const bodyMat = await builder.add("lineMAT", "body_outline_line", {
      linenearcolorr: 0.38,
      linenearcolorg: 1,
      linenearcolorb: 0.66,
      widthnear: args.body_contour_width,
    });
    await builder.setParams(bodyGeo, { material: bodyMat });

    const cam = await builder.add("cameraCOMP", "cam", { tz: 3.2 });
    const render = await builder.add("renderTOP", "render", {
      geometry: `${bodyGeo} ${geo}`,
      camera: cam,
      outputresolution: "custom",
      resolutionw: width,
      resolutionh: height,
      antialias: "3",
      bgcolorr: 0.005,
      bgcolorg: 0.012,
      bgcolorb: 0.02,
      bgcolora: args.show_camera_background ? 0 : 1,
    });

    let outputSource = render;
    let cameraSelect: string | undefined;
    let cameraFit: string | undefined;
    let cameraLevel: string | undefined;
    let cameraComposite: string | undefined;
    if (args.show_camera_background) {
      await builder.python(cameraOverlayScript(args));
      cameraSelect = await builder.add("selectTOP", "camera_select", { top: args.camera_top_path });
      cameraFit = await builder.add("fitTOP", "camera_fit", {
        resolutionw: width,
        resolutionh: height,
      });
      await builder.connect(cameraSelect, cameraFit);
      cameraLevel = await builder.add("levelTOP", "camera_level", {
        opacity: args.camera_opacity,
      });
      await builder.connect(cameraFit, cameraLevel);
      cameraComposite = await builder.add("compositeTOP", "camera_composite", { operand: "over" });
      await builder.connect(render, cameraComposite, 0, 0);
      await builder.connect(cameraLevel, cameraComposite, 0, 1);
      outputSource = cameraComposite;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(outputSource, out);
    await installFrameCooker(builder, out, "cooker");

    const controls = controlsFor(args, bodyMat, cameraLevel);
    const sourceSummary = [
      args.show_camera_background ? `camera ${args.camera_top_path}` : "no camera background",
      args.hand_chop_path ? `hand ${args.hand_chop_path}` : "no hand CHOP yet",
      args.body_chop_path ? `body ${args.body_chop_path}` : "no body CHOP yet",
    ].join(", ");
    const emissionSummary = args.fallback_to_pose_wrists
      ? "Open palms emit bubbles; pose wrists can emit only when the optional fallback is enabled"
      : "Only detected open palms emit bubbles; pose/body tracking never creates bubbles by itself";

    return finalize(ctx, {
      summary: `Built a body-interactive bubble physics installation (${sourceSummary}) -> ${out}. ${emissionSummary}; a visible body contour and camera background are rendered in the output; pose/hand landmarks push and lift bubbles; bubbles live ${args.lifetime_seconds}s, pop/fade, collide with the screen box, and settle on the floor.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        output_path: out,
        render_top: render,
        camera_select: cameraSelect,
        camera_fit: cameraFit,
        camera_level: cameraLevel,
        camera_composite: cameraComposite,
        sim_chop: sim,
        bubble_sop: sop,
        body_outline_sop: bodySop,
        camera_top_path: args.camera_top_path,
        show_camera_background: args.show_camera_background,
        hide_camera_tracking_overlays: args.hide_camera_tracking_overlays,
        camera_opacity: args.camera_opacity,
        hand_chop_path: args.hand_chop_path,
        body_chop_path: args.body_chop_path,
        bubble_count: args.bubble_count,
        lifetime_seconds: args.lifetime_seconds,
        emit_on_open_palm: args.emit_on_open_palm,
        palm_open_threshold: args.palm_open_threshold,
        fallback_to_pose_wrists: args.fallback_to_pose_wrists,
        show_body_contour: args.show_body_contour,
        body_contour_width: args.body_contour_width,
        physics: {
          gravity: args.gravity,
          body_radius: args.body_radius,
          wall_bounce: args.wall_bounce,
          floor_bounce: args.floor_bounce,
          drag: args.drag,
          buoyancy: args.buoyancy,
          skeleton_impulse: args.skeleton_impulse,
          bubble_repulsion: args.bubble_repulsion,
          tracking_smoothing: args.tracking_smoothing,
        },
        notes: [
          "Run setup_hand_tracking and pass its hand CHOP as hand_chop_path for open-palm emission.",
          "Run setup_body_tracking or create_pose_tracking and pass its pose CHOP as body_chop_path for body collisions.",
          "Pass camera_top_path, such as /project1/MediaPipe/video, to show the live camera behind the bubbles.",
          "The body contour reads the same pose CHOP as the collider field, so the visible outline matches the bubbles' interaction source.",
          "The Controls page is read by the Script CHOP each frame, so changing sliders updates the simulation live.",
        ],
      },
    });
  });
}

export const registerCreateBodyBubbles: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_body_bubbles",
    {
      title: "Create body bubbles",
      description:
        "Create a MediaPipe-ready interactive bubble installation over the live camera: a detected open palm emits soap-like bubbles, body and hand landmarks act as soft colliders that can bat or lift them, a visible body contour is rendered in the same output so the interaction reads clearly, bubbles stay inside the screen box, settle on the lower floor, and pop/fade after a configurable lifetime (default 30 seconds). By default it keeps the bubble count low and disables pose-wrist emission, so bubbles are created only by an open palm. Builds a self-contained Base COMP with a Script CHOP physics solver, Script SOP bubble outlines, Script SOP body contour, camera-background composite, Geometry/Render/Null TOP output, a frame cooker, and live controls for emission rate, gravity, drag, buoyancy, skeleton impulse, bubble repulsion, tracking smoothing, body radius, body contour, camera opacity, lifetime, and bounce. Provide hand_chop_path from setup_hand_tracking and body_chop_path from setup_body_tracking/create_pose_tracking for full interaction.",
      inputSchema: createBodyBubblesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBodyBubblesImpl(ctx, args),
  );
};
