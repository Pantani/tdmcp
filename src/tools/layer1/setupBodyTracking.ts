import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createPoseSkeletonImpl } from "./createPoseSkeleton.js";

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

/** Finds the engine .tox staged by `tdmcp install mediapipe-touchdesigner`. */
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

export const setupBodyTrackingSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe ENGINE .tox (MediaPipe.tox — the full tracker that captures the webcam, not the bare pose_tracking.tox processor). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`, falling back to the legacy ~/tdmcp-packages path.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to load the engine into."),
  build_skeleton: z
    .boolean()
    .default(true)
    .describe("Also build a pose-skeleton visual wired to the tracked body so you see it working."),
});
type SetupBodyTrackingArgs = z.infer<typeof setupBodyTrackingSchema>;

interface LoadReport {
  error?: "tox_missing" | "parent_missing";
  engine?: string;
  pose_dat?: string | null;
  adapter_pose?: string;
}

/**
 * The Python onCook for the adapter Script CHOP. It reads the engine's pose JSON DAT
 * (`{"poseResults":{"landmarks":[[{x,y,z,visibility}, … 33]]}}`) and emits the canonical pose
 * CHOP every cook: 33 samples × tx/ty/tz/confidence in TD world coordinates. MediaPipe x/y are
 * normalised 0..1 with y pointing DOWN, so we centre on the hip midpoint and flip y to point UP;
 * z is negated to match TD's forward axis. The `POSE_DAT = …` assignment is prepended at build
 * time (in the bridge script) once the live pose DAT path is known.
 */
function adapterCallbackBody(): string {
  return [
    "import json",
    "TRACKING_SMOOTHING = 0.45",
    "SCREEN_HOLD_SECONDS = 0.35",
    "STATE = globals().setdefault('POSE_SCREEN_ADAPTER_STATE', {'points': {}})",
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
    "    scriptOp.clear(); scriptOp.numSamples = 33",
    "    tx = scriptOp.appendChan('tx'); ty = scriptOp.appendChan('ty'); tz = scriptOp.appendChan('tz'); cf = scriptOp.appendChan('confidence')",
    "    sx = scriptOp.appendChan('screen_x'); sy = scriptOp.appendChan('screen_y')",
    "    lms = None",
    "    d = op(POSE_DAT)",
    "    if d is not None and d.text.strip():",
    "        try:",
    "            poses = json.loads(d.text).get('poseResults', {}).get('landmarks', [])",
    "            if poses: lms = poses[0]",
    "        except Exception:",
    "            lms = None",
    "    cx = cy = 0.0",
    "    if lms and len(lms) > 24:",
    "        cx = (float(lms[23].get('x',0.5)) + float(lms[24].get('x',0.5))) * 0.5",
    "        cy = (float(lms[23].get('y',0.5)) + float(lms[24].get('y',0.5))) * 0.5",
    "    now = absTime.seconds",
    "    live = set()",
    "    smoothing = max(0.0, min(0.95, TRACKING_SMOOTHING))",
    "    for i in range(33):",
    "        key = str(i)",
    "        prev = STATE['points'].get(key)",
    "        if lms and i < len(lms):",
    "            p = lms[i]",
    "            raw_tx = float(p.get('x',0.5)) - cx",
    "            raw_ty = cy - float(p.get('y',0.5))",
    "            raw_tz = -float(p.get('z',0.0))",
    "            raw_sx = _screen_x(p.get('x',0.5))",
    "            raw_sy = _screen_y(p.get('y',0.5))",
    "            conf = float(p.get('visibility',1.0))",
    "            vals = {",
    "                'tx': _blend(prev.get('tx') if prev else None, raw_tx, smoothing),",
    "                'ty': _blend(prev.get('ty') if prev else None, raw_ty, smoothing),",
    "                'tz': _blend(prev.get('tz') if prev else None, raw_tz, smoothing),",
    "                'sx': _blend(prev.get('sx') if prev else None, raw_sx, smoothing),",
    "                'sy': _blend(prev.get('sy') if prev else None, raw_sy, smoothing),",
    "                'cf': conf,",
    "                't': now,",
    "            }",
    "            STATE['points'][key] = vals",
    "            live.add(key)",
    "            tx[i] = vals['tx']; ty[i] = vals['ty']; tz[i] = vals['tz']; cf[i] = vals['cf']",
    "            sx[i] = vals['sx']; sy[i] = vals['sy']",
    "        elif prev is not None and now - float(prev.get('t', -9999.0)) <= SCREEN_HOLD_SECONDS:",
    "            tx[i] = prev.get('tx', 0.0); ty[i] = prev.get('ty', 0.0); tz[i] = prev.get('tz', 0.0)",
    "            sx[i] = prev.get('sx', 0.0); sy[i] = prev.get('sy', 0.0); cf[i] = float(prev.get('cf', 0.0)) * 0.65",
    "        else:",
    "            tx[i]=0.0; ty[i]=0.0; tz[i]=0.0; cf[i]=0.0; sx[i]=0.0; sy[i]=0.0",
    "    for key, val in list(STATE['points'].items()):",
    "        if key not in live and now - float(val.get('t', -9999.0)) > SCREEN_HOLD_SECONDS:",
    "            del STATE['points'][key]",
    "    return",
  ].join("\n");
}

/**
 * Python (runs in TD): load the MediaPipe ENGINE tox into the parent, start the timeline (the
 * engine captures the webcam through an embedded Web Render TOP that only runs while playing),
 * locate the engine's `pose` JSON DAT, then build an adapter (a baseCOMP `mp_adapter` holding a
 * Script CHOP `pose` + its callback DAT) that converts the JSON to the canonical 33-sample pose
 * CHOP. The adapter callback is generated here so it can embed the live pose DAT's path.
 */
function loadAndBuildScript(toxPath: string, parentPath: string): string {
  return [
    "import json, os",
    `TOX = ${q(toxPath)}`,
    `PARENT = ${q(parentPath)}`,
    // The adapter callback body (sans the POSE_DAT assignment, which is prepended once the live
    // pose-DAT path is known). q() keeps the callback's own braces/quotes intact.
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
    // The engine grabs the webcam via an embedded browser that only runs while the timeline plays.
    "    root.time.play = True",
    // Find the pose JSON DAT: directly on the engine, else search a few levels down.
    "    pose_dat = eng.op('pose')",
    "    if pose_dat is None:",
    "        for d in eng.findChildren(type=DAT, maxDepth=3):",
    "            if d.name == 'pose':",
    "                pose_dat = d",
    "                break",
    "    pose_dat_path = pose_dat.path if pose_dat is not None else ''",
    // Build the adapter: a baseCOMP holding a Script CHOP + its callback DAT.
    "    adapter = root.op('mp_adapter') or root.create(baseCOMP, 'mp_adapter')",
    "    try:",
    "        adapter.name = 'mp_adapter'",
    "    except Exception:",
    "        pass",
    "    sc = adapter.op('pose') or adapter.create(scriptCHOP, 'pose')",
    "    cb = adapter.op('pose_cb') or adapter.create(textDAT, 'pose_cb')",
    "    cb.text = 'POSE_DAT = ' + repr(pose_dat_path) + '\\n' + CB_BODY",
    "    sc.par.callbacks = cb.name",
    "    report['engine'] = eng.path",
    "    report['pose_dat'] = pose_dat_path or None",
    "    report['adapter_pose'] = adapter.op('pose').path",
    "print(json.dumps(report))",
  ].join("\n");
}

/** Pulls the JSON code-fence object out of another tool's text result. */
function extractJson(result: CallToolResult): Record<string, unknown> {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const start = text.indexOf("{", text.indexOf("```json"));
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function setupBodyTrackingImpl(ctx: ToolContext, args: SetupBodyTrackingArgs) {
  const toxPath = args.tox_path ?? defaultEngineToxPath();

  // 1. Load the engine, start the timeline, find its pose JSON DAT, and build the adapter CHOP.
  let report: LoadReport;
  try {
    const exec = await ctx.client.executePythonScript(
      loadAndBuildScript(toxPath, args.parent_path),
      true,
    );
    report = parsePythonReport<LoadReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe engine not found at ${toxPath}. Install it first by running 'tdmcp install mediapipe-touchdesigner' in a terminal (the free, MIT-licensed GPU MediaPipe tracker), or pass tox_path to an existing MediaPipe.tox. Legacy installs are also checked at ${legacyEngineToxPath()}.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }
  if (!report.pose_dat) {
    return errorResult(
      `Loaded the engine (${report.engine ?? "?"}) but couldn't find its pose JSON DAT. Open the MediaPipe component, pick your webcam and enable Pose, then re-run.`,
    );
  }

  const adapterPose = report.adapter_pose ?? `${args.parent_path}/mp_adapter/pose`;

  // 2. Optionally build a skeleton visual on top of the adapter's pose CHOP.
  let skeleton: CallToolResult | undefined;
  if (args.build_skeleton) {
    skeleton = await createPoseSkeletonImpl(ctx, {
      source: "existing_chop",
      existing_chop_path: adapterPose,
      osc_port: 7000,
      line_color: "#33ffe6",
      line_width: 3,
      camera_distance: 5.5,
      expose_controls: true,
      parent_path: args.parent_path,
    });
  }
  const skeletonData = skeleton ? extractJson(skeleton) : {};

  const summary = {
    engine_loaded: report.engine,
    pose_json_dat: report.pose_dat,
    adapter_pose_chop: adapterPose,
    skeleton: args.build_skeleton
      ? (skeletonData.output ?? "(skeleton build failed)")
      : "(skipped)",
  };

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text:
        `Body tracking is set up. Loaded the MediaPipe engine → ${report.engine}, built an adapter (${adapterPose}) that converts its pose JSON DAT (${report.pose_dat}) into a 33-landmark pose CHOP (tx/ty/tz/confidence), ` +
        `${args.build_skeleton ? "and built a live skeleton" : "ready for visuals"}.\n\n` +
        "⚠ Keep the TD timeline PLAYING (the plugin captures via an embedded browser that only runs while playing); grant camera permission if macOS asks.\n\n" +
        `\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
    },
  ];
  // Surface the skeleton preview if one was captured.
  const img = skeleton?.content.find((c) => c.type === "image");
  if (img) content.push(img);
  return { content };
}

export const registerSetupBodyTracking: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_body_tracking",
    {
      title: "Set up body tracking",
      description:
        "One-shot body tracking from a webcam: loads the free mediapipe-touchdesigner ENGINE (install it first with `tdmcp install mediapipe-touchdesigner`) into your project, starts the timeline (the engine captures the webcam through an embedded browser that only runs while playing), reads its pose JSON DAT through an adapter that emits a 33-landmark pose CHOP, and builds a live skeleton so you only need to pick your webcam and enable Pose. If the engine isn't installed yet, it tells you how. Loading the engine will prompt for camera permission on macOS (click Allow).",
      inputSchema: setupBodyTrackingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupBodyTrackingImpl(ctx, args),
  );
};
