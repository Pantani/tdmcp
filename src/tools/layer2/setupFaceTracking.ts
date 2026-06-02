import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
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

export const setupFaceTrackingSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe ENGINE .tox (MediaPipe.tox). Defaults to the package staged by `tdmcp install mediapipe-touchdesigner`, falling back to ~/tdmcp-packages.",
    ),
  parent_path: z.string().default("/project1").describe("COMP to load the engine into."),
  num_landmarks: z
    .union([z.literal(468), z.literal(478)])
    .default(468)
    .describe(
      "468 = MediaPipe FaceMesh base; 478 adds iris landmarks (10 extra) when iris tracking is enabled in the engine.",
    ),
});
type SetupFaceTrackingArgs = z.infer<typeof setupFaceTrackingSchema>;

interface LoadReport {
  error?: "tox_missing" | "parent_missing";
  engine?: string;
  face_dat?: string | null;
  adapter_face?: string;
}

/**
 * The Python onCook for the face adapter Script CHOP. It reads the engine's face JSON DAT
 * and emits the canonical face CHOP: N samples × tx/ty/tz/confidence, centred on nose
 * landmark 1, y-flipped. The `FACE_DAT = …` and `NUM_LMS = …` assignments are prepended
 * at build time.
 *
 * UNVERIFIED-against-live: the torinmb/mediapipe-touchdesigner engine emits
 * `{"faceLandmarkResults":{"faceLandmarks":[[{x,y,z}, … 468/478]]}}`. We try that key
 * shape first and fall back to the legacy `{"faceResults":{"landmarks":[...]}}` so the
 * adapter keeps working across engine versions instead of silently emitting zeros.
 * Last cross-checked against the published engine on 2026-06-02.
 */
function adapterCallbackBody(): string {
  return [
    "import json",
    "def onCook(scriptOp):",
    "    scriptOp.clear(); scriptOp.numSamples = NUM_LMS",
    "    tx = scriptOp.appendChan('tx'); ty = scriptOp.appendChan('ty'); tz = scriptOp.appendChan('tz'); cf = scriptOp.appendChan('confidence')",
    "    lms = None",
    "    d = op(FACE_DAT)",
    "    if d is not None and d.text.strip():",
    "        try:",
    "            payload = json.loads(d.text)",
    "            # Current engine key shape: faceLandmarkResults.faceLandmarks",
    "            faces = payload.get('faceLandmarkResults', {}).get('faceLandmarks', [])",
    "            # Legacy fallback for older engine builds",
    "            if not faces:",
    "                faces = payload.get('faceResults', {}).get('landmarks', [])",
    "            if faces: lms = faces[0]",
    "        except Exception:",
    "            lms = None",
    "    cx = cy = 0.0",
    "    if lms and len(lms) > 1:",
    "        cx = float(lms[1].get('x', 0.5))",
    "        cy = float(lms[1].get('y', 0.5))",
    "    for i in range(NUM_LMS):",
    "        if lms and i < len(lms):",
    "            p = lms[i]",
    "            tx[i] = float(p.get('x', 0.5)) - cx",
    "            ty[i] = cy - float(p.get('y', 0.5))",
    "            tz[i] = -float(p.get('z', 0.0))",
    "            cf[i] = 1.0",
    "        else:",
    "            tx[i]=0.0; ty[i]=0.0; tz[i]=0.0; cf[i]=0.0",
    "    return",
  ].join("\n");
}

/**
 * Python (runs in TD): load the MediaPipe ENGINE tox into the parent, start the timeline,
 * locate the engine's `face` JSON DAT, then build an adapter (a baseCOMP `mp_face_adapter`
 * holding a Script CHOP `face` + its callback DAT) that converts the JSON to the canonical
 * N-sample face landmark CHOP.
 */
function loadAndBuildScript(toxPath: string, parentPath: string, numLandmarks: 468 | 478): string {
  return [
    "import json, os",
    `TOX = ${q(toxPath)}`,
    `PARENT = ${q(parentPath)}`,
    `NUM_LMS = ${numLandmarks}`,
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
    "    face_dat = eng.op('face')",
    "    if face_dat is None:",
    "        for d in eng.findChildren(type=DAT, maxDepth=3):",
    "            if d.name == 'face':",
    "                face_dat = d",
    "                break",
    "    face_dat_path = face_dat.path if face_dat is not None else ''",
    "    adapter = root.op('mp_face_adapter') or root.create(baseCOMP, 'mp_face_adapter')",
    "    try:",
    "        adapter.name = 'mp_face_adapter'",
    "    except Exception:",
    "        pass",
    "    sc = adapter.op('face') or adapter.create(scriptCHOP, 'face')",
    "    cb = adapter.op('face_cb') or adapter.create(textDAT, 'face_cb')",
    "    cb.text = 'NUM_LMS = ' + repr(NUM_LMS) + '\\nFACE_DAT = ' + repr(face_dat_path) + '\\n' + CB_BODY",
    "    sc.par.callbacks = cb.name",
    "    report['engine'] = eng.path",
    "    report['face_dat'] = face_dat_path or None",
    "    report['adapter_face'] = adapter.op('face').path",
    "print(json.dumps(report))",
  ].join("\n");
}

export async function setupFaceTrackingImpl(ctx: ToolContext, args: SetupFaceTrackingArgs) {
  const toxPath = args.tox_path ?? defaultEngineToxPath();

  let report: LoadReport;
  try {
    const exec = await ctx.client.executePythonScript(
      loadAndBuildScript(toxPath, args.parent_path, args.num_landmarks),
      true,
    );
    report = parsePythonReport<LoadReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe engine not found at ${toxPath}; run \`tdmcp install mediapipe-touchdesigner\`.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }
  if (!report.face_dat) {
    return errorResult(
      `Loaded engine (${report.engine ?? "?"}) but couldn't find its face JSON DAT. Open the MediaPipe component, pick your webcam and enable **Face**, then re-run.`,
    );
  }

  const adapterFace = report.adapter_face ?? `${args.parent_path}/mp_face_adapter/face`;

  const summary = {
    engine_loaded: report.engine,
    face_json_dat: report.face_dat,
    adapter_face_chop: adapterFace,
    num_landmarks: args.num_landmarks,
  };

  return jsonResult(
    `Face tracking is set up. Engine → ${report.engine}; adapter CHOP at ${adapterFace} emits ${args.num_landmarks} landmarks (tx/ty/tz/confidence). Keep the TD timeline PLAYING and grant camera permission if macOS asks.`,
    summary,
  );
}

export const registerSetupFaceTracking: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "setup_face_tracking",
    {
      title: "Set up face tracking",
      description:
        "One-shot face-landmark tracking from a webcam: loads the MediaPipe ENGINE (install first with `tdmcp install mediapipe-touchdesigner`), starts the timeline, and builds an adapter Script CHOP that emits a 468-sample (or 478 with iris) face-landmark CHOP (tx/ty/tz/confidence, centred on nose tip). Feeds directly into bind_to_channel and create_data_visualization.",
      inputSchema: setupFaceTrackingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupFaceTrackingImpl(ctx, args),
  );
};
