import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

function legacyEngineToxPath(): string {
  return join(
    homedir(),
    "tdmcp-packages",
    "mediapipe-touchdesigner",
    "release",
    "toxes",
    "MediaPipe.tox",
  );
}

function defaultEngineToxPath(): string {
  const paths = createPackagePaths();
  const record = readPackageState(paths).packages.find(
    (pkg) => pkg.id === "mediapipe-touchdesigner",
  );
  const artifact =
    record?.artifacts.find(
      (item) => basename(item.absolutePath).toLowerCase() === "mediapipe.tox",
    ) ?? record?.artifacts.find((item) => item.kind === "tox");
  if (artifact) return artifact.absolutePath;
  return legacyEngineToxPath();
}

export const setupHandTrackingSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe ENGINE .tox (MediaPipe.tox). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`, falling back to ~/tdmcp-packages. The same engine is shared with setup_body_tracking.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to load the engine into."),
  max_hands: z
    .number()
    .int()
    .min(1)
    .max(2)
    .default(2)
    .describe(
      "Maximum number of hands tracked (1 or 2). Output CHOP allocates max_hands*21 samples.",
    ),
  coordinate_space: z
    .enum(["world", "image"])
    .default("world")
    .describe(
      "'world' reads worldLandmarks (3D, meters, gesture-safe — curled fingers separate in z). 'image' reads normalised 2D landmarks, centred on the wrist. Use 'world' for gesture detection.",
    ),
  adapter_name: z
    .string()
    .default("mp_hand_adapter")
    .describe("baseCOMP name created under parent_path to house the hand Script CHOP."),
});
type SetupHandTrackingArgs = z.infer<typeof setupHandTrackingSchema>;

interface HandLoadReport {
  error?: "tox_missing" | "parent_missing" | "hand_dat_missing";
  engine?: string;
  hand_dat?: string | null;
  adapter_hand?: string;
  max_hands?: number;
  coordinate_space?: string;
  warning?: string;
  warnings?: string[];
}

/**
 * The Python onCook body for the adapter Script CHOP. Reads the engine's hand JSON DAT
 * (`{"handResults": ...}` in older builds, `{"gestureResults": ...}` in current torinmb builds),
 * emits max_hands*21 samples × tx/ty/tz/confidence/handedness.
 *
 * For "world" space: pass worldLandmarks x/-y/-z through as metres (y flipped to TD up-axis).
 * For "image" space: normalised 2D, centred on wrist (landmark 0) for a stable origin.
 * Slot layout: samples 0..20 = slot 0, 21..41 = slot 1. Empty slots → all zeros.
 *
 * HAND_DAT, HAND_COUNT, SPACE are prepended at build time.
 *
 * Live-probed against torinmb mediapipe-touchdesigner builds that emit either
 * `handResults` or `gestureResults`; both shapes keep `worldLandmarks`/`landmarks`.
 */
function adapterCallbackBody(): string {
  return [
    "import json",
    "SCREEN_HOLD_SECONDS = 0.25",
    "SCREEN_SMOOTHING = 0.35",
    "STATE = globals().setdefault('HAND_SCREEN_ADAPTER_STATE', {'points': {}})",
    "",
    "def _screen_x(v):",
    "    return max(-1.15, min(1.15, float(v) * 2.0 - 1.0))",
    "",
    "def _screen_y(v):",
    "    return max(-1.15, min(1.15, 1.0 - float(v) * 2.0))",
    "",
    "def _blend(prev, raw, alpha):",
    "    if prev is None:",
    "        return raw",
    "    return prev * alpha + raw * (1.0 - alpha)",
    "",
    "def onCook(scriptOp):",
    "    scriptOp.clear()",
    "    n = HAND_COUNT * 21",
    "    scriptOp.numSamples = n",
    "    tx = scriptOp.appendChan('tx'); ty = scriptOp.appendChan('ty')",
    "    tz = scriptOp.appendChan('tz'); cf = scriptOp.appendChan('confidence')",
    "    hd = scriptOp.appendChan('handedness')",
    "    sx = scriptOp.appendChan('screen_x'); sy = scriptOp.appendChan('screen_y')",
    "    d = op(HAND_DAT)",
    "    hands = []",
    "    if d is not None and d.text.strip():",
    "        try:",
    "            root = json.loads(d.text)",
    "            res = root.get('handResults') or root.get('gestureResults') or {}",
    "            world_lists = res.get('worldLandmarks', []) or []",
    "            image_lists = res.get('landmarks', []) or []",
    "            lists = world_lists if SPACE == 'world' and world_lists else image_lists",
    "            scores = res.get('score', []) or res.get('scores', []) or []",
    "            if not scores and res.get('gestures'):",
    "                for gs in res.get('gestures') or []:",
    "                    if isinstance(gs, list) and gs and isinstance(gs[0], dict):",
    "                        scores.append(float(gs[0].get('score', 1.0)))",
    "                    else:",
    "                        scores.append(1.0)",
    "            labels = res.get('handedness', []) or res.get('handednesses', []) or []",
    "            for i, lms in enumerate(lists[:HAND_COUNT]):",
    "                s = float(scores[i]) if i < len(scores) else 1.0",
    "                raw_lbl = labels[i] if i < len(labels) else ''",
    "                if isinstance(raw_lbl, list) and raw_lbl:",
    "                    raw_lbl = raw_lbl[0]",
    "                if isinstance(raw_lbl, dict):",
    "                    raw_lbl = raw_lbl.get('categoryName') or raw_lbl.get('displayName') or ''",
    "                lbl = str(raw_lbl).lower()",
    "                sign = 1.0 if lbl.startswith('r') else (-1.0 if lbl.startswith('l') else 0.0)",
    "                image_lms = image_lists[i] if i < len(image_lists) else lms",
    "                hands.append((lms, image_lms, s, sign))",
    "        except Exception:",
    "            hands = []",
    "    now = absTime.seconds",
    "    live = set()",
    "    smoothing = max(0.0, min(0.95, SCREEN_SMOOTHING))",
    "    for slot in range(HAND_COUNT):",
    "        base = slot * 21",
    "        if slot < len(hands):",
    "            lms, image_lms, s, sign = hands[slot]",
    "            cx = float(lms[0].get('x', 0.5)) if SPACE == 'image' and lms else 0.0",
    "            cy = float(lms[0].get('y', 0.5)) if SPACE == 'image' and lms else 0.0",
    "            for i in range(21):",
    "                key = str(base + i)",
    "                prev = STATE['points'].get(key)",
    "                if i < len(lms):",
    "                    p = lms[i]",
    "                    if SPACE == 'world':",
    "                        raw_tx = float(p.get('x', 0.0))",
    "                        raw_ty = -float(p.get('y', 0.0))",
    "                        raw_tz = -float(p.get('z', 0.0))",
    "                    else:",
    "                        raw_tx = float(p.get('x', 0.5)) - cx",
    "                        raw_ty = cy - float(p.get('y', 0.5))",
    "                        raw_tz = -float(p.get('z', 0.0))",
    "                    ip = image_lms[i] if i < len(image_lms) else p",
    "                    raw_sx = _screen_x(ip.get('x', 0.5))",
    "                    raw_sy = _screen_y(ip.get('y', 0.5))",
    "                    vals = {",
    "                        'tx': _blend(prev.get('tx') if prev else None, raw_tx, smoothing),",
    "                        'ty': _blend(prev.get('ty') if prev else None, raw_ty, smoothing),",
    "                        'tz': _blend(prev.get('tz') if prev else None, raw_tz, smoothing),",
    "                        'sx': _blend(prev.get('sx') if prev else None, raw_sx, smoothing),",
    "                        'sy': _blend(prev.get('sy') if prev else None, raw_sy, smoothing),",
    "                        'cf': s,",
    "                        'hd': sign,",
    "                        't': now,",
    "                    }",
    "                    STATE['points'][key] = vals",
    "                    live.add(key)",
    "                    tx[base+i] = vals['tx']; ty[base+i] = vals['ty']; tz[base+i] = vals['tz']",
    "                    cf[base+i] = vals['cf']; hd[base+i] = vals['hd']; sx[base+i] = vals['sx']; sy[base+i] = vals['sy']",
    "                elif prev is not None and now - float(prev.get('t', -9999.0)) <= SCREEN_HOLD_SECONDS:",
    "                    tx[base+i] = prev.get('tx', 0.0); ty[base+i] = prev.get('ty', 0.0); tz[base+i] = prev.get('tz', 0.0)",
    "                    cf[base+i] = float(prev.get('cf', 0.0)) * 0.65; hd[base+i] = prev.get('hd', 0.0)",
    "                    sx[base+i] = prev.get('sx', 0.0); sy[base+i] = prev.get('sy', 0.0)",
    "                else:",
    "                    tx[base+i]=0.0; ty[base+i]=0.0; tz[base+i]=0.0; cf[base+i]=0.0; hd[base+i]=0.0; sx[base+i]=0.0; sy[base+i]=0.0",
    "        else:",
    "            for i in range(21):",
    "                tx[base+i]=0.0; ty[base+i]=0.0; tz[base+i]=0.0; cf[base+i]=0.0; hd[base+i]=0.0; sx[base+i]=0.0; sy[base+i]=0.0",
    "    for key, val in list(STATE['points'].items()):",
    "        if key not in live and now - float(val.get('t', -9999.0)) > SCREEN_HOLD_SECONDS:",
    "            del STATE['points'][key]",
    "    return",
  ].join("\n");
}

/**
 * Python (runs in TD): load the MediaPipe ENGINE tox (reused if setup_body_tracking already
 * loaded it), start the timeline, locate the engine's `hand` JSON DAT (tries name == 'hand',
 * then prefix match via findChildren depth 3), build an adapter baseCOMP with a Script CHOP +
 * callback DAT that converts the hand JSON into a canonical max_hands*21-sample CHOP.
 */
function loadAndBuildScript(
  toxPath: string,
  parentPath: string,
  maxHands: number,
  coordinateSpace: string,
  adapterName: string,
): string {
  return [
    "import json, os",
    `TOX = ${q(toxPath)}`,
    `PARENT = ${q(parentPath)}`,
    `ADAPTER_NAME = ${q(adapterName)}`,
    `HAND_COUNT = ${maxHands}`,
    `SPACE = ${q(coordinateSpace)}`,
    `CB_BODY = ${q(adapterCallbackBody())}`,
    "report = {}",
    "root = op(PARENT)",
    "if not os.path.exists(TOX):",
    "    report['error'] = 'tox_missing'",
    "elif root is None:",
    "    report['error'] = 'parent_missing'",
    "else:",
    "    eng = root.op('MediaPipe') or root.loadTox(TOX)",
    "    try:",
    "        eng.name = 'MediaPipe'",
    "    except Exception:",
    "        pass",
    "    root.time.play = True",
    // Locate hand JSON DAT — try direct child, then prefix match via findChildren
    // Engine renamed across versions (hand → hand_landmarks → hand_landmark_results).
    // Probe a priority list of candidate names, then fall back to a regex scan
    // so a future rename doesn't silently break the adapter.
    "    import re as _re",
    "    _CANDIDATES = ['hand_landmark_results','hand_landmarks','hand_json','mp_hand_landmarks','hand']",
    "    hand_dat = None",
    // eng.op(name) returns ANY operator type, so reject non-DAT hits to
    // match the type=DAT filter on the regex fallback.
    "    for _n in _CANDIDATES:",
    "        _d = eng.op(_n)",
    "        if _d is not None and _d.family == 'DAT':",
    "            hand_dat = _d",
    "            break",
    "    if hand_dat is None:",
    "        _rx = _re.compile(r'hand.*(landmark|result|json)', _re.IGNORECASE)",
    "        for d in eng.findChildren(type=DAT, maxDepth=3):",
    "            if _rx.search(d.name):",
    "                hand_dat = d",
    "                break",
    "    if hand_dat is None:",
    "        report['error'] = 'hand_dat_missing'",
    "        report['engine'] = eng.path",
    "    else:",
    "        hand_dat_path = hand_dat.path",
    "        adapter = root.op(ADAPTER_NAME) or root.create(baseCOMP, ADAPTER_NAME)",
    "        try:",
    "            adapter.name = ADAPTER_NAME",
    "        except Exception:",
    "            pass",
    "        sc = adapter.op('hand') or adapter.create(scriptCHOP, 'hand')",
    "        cb = adapter.op('hand_cb') or adapter.create(textDAT, 'hand_cb')",
    `        cb.text = f"HAND_DAT = {repr(hand_dat_path)}\\nHAND_COUNT = {HAND_COUNT}\\nSPACE = {repr(SPACE)}\\n" + CB_BODY`,
    "        sc.par.callbacks = cb.name",
    "        report['engine'] = eng.path",
    "        report['hand_dat'] = hand_dat_path",
    "        report['adapter_hand'] = adapter.op('hand').path",
    "        report['max_hands'] = HAND_COUNT",
    "        report['coordinate_space'] = SPACE",
    "print(json.dumps(report))",
  ].join("\n");
}

export async function setupHandTrackingImpl(
  ctx: ToolContext,
  args: SetupHandTrackingArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  const toxPath = args.tox_path ?? defaultEngineToxPath();

  let report: HandLoadReport;
  try {
    const exec = await ctx.client.executePythonScript(
      loadAndBuildScript(
        toxPath,
        args.parent_path,
        args.max_hands,
        args.coordinate_space,
        args.adapter_name,
      ),
      true,
    );
    report = parsePythonReport<HandLoadReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe engine not found at ${toxPath}. Install it first by running 'tdmcp install mediapipe-touchdesigner' in a terminal, or pass tox_path to an existing MediaPipe.tox. Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }
  if (report.error === "hand_dat_missing") {
    return errorResult(
      `Loaded the engine (${report.engine ?? "?"}) but couldn't find its hand JSON DAT. Open the MediaPipe component, enable Hands, then re-run.`,
    );
  }

  const adapterHand = report.adapter_hand ?? `${args.parent_path}/${args.adapter_name}/hand`;
  const totalSamples = args.max_hands * 21;
  const structured = {
    engine_loaded: report.engine,
    hand_dat: report.hand_dat,
    adapter_hand_chop: adapterHand,
    max_hands: args.max_hands,
    coordinate_space: args.coordinate_space,
    samples: totalSamples,
  };

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Hand tracking is set up. Loaded the MediaPipe engine → ${report.engine}, built adapter ${adapterHand} emitting ${totalSamples} samples (${args.max_hands} hand(s) × 21 landmarks) in ${args.coordinate_space} space with channels tx/ty/tz/confidence/handedness.\n\n` +
          "Keep the TD timeline PLAYING (the plugin captures via an embedded browser that only runs while playing); grant camera permission if macOS asks.\n\n" +
          `Chain bind_to_channel or create_pose_skeleton against ${adapterHand} to make it reactive.`,
      },
    ],
    // Surface the machine-readable payload so downstream tools can consume it
    // without re-parsing a fenced JSON block out of the text body.
    structuredContent: structured,
  };
}

export const registerSetupHandTracking: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_hand_tracking",
    {
      title: "Set up hand tracking",
      description:
        "One-shot MediaPipe hand tracking from a webcam: loads the mediapipe-touchdesigner ENGINE (install with `tdmcp install mediapipe-touchdesigner`), starts the timeline, locates the engine's hand JSON DAT, and builds an adapter Script CHOP that converts the hand JSON into a canonical max_hands×21-landmark CHOP (channels: tx/ty/tz/confidence/handedness). Use coordinate_space='world' for gesture detection (3D, curled fingers separate in z). The output CHOP at <parent_path>/<adapter_name>/hand is ready for bind_to_channel or create_pose_skeleton. Shares the same engine as setup_body_tracking — both can run in the same project.",
      inputSchema: setupHandTrackingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupHandTrackingImpl(ctx, args),
  );
};
