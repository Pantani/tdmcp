import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createPoseSkeletonImpl } from "./createPoseSkeleton.js";
import { createPoseTrackingImpl } from "./createPoseTracking.js";

const q = (value: string): string => JSON.stringify(value);

/** Default location the `tdmcp install-mediapipe` CLI extracts the plugin to. */
function defaultPoseToxPath(): string {
  return join(homedir(), "tdmcp-mediapipe", "release", "toxes", "pose_tracking.tox");
}

export const setupBodyTrackingSchema = z.object({
  tox_path: z
    .string()
    .optional()
    .describe(
      "Path to the MediaPipe plugin's pose_tracking.tox. Defaults to where `tdmcp install-mediapipe` puts it (~/tdmcp-mediapipe/release/toxes/pose_tracking.tox).",
    ),
  parent_path: z.string().default("/project1").describe("COMP to load the plugin into."),
  build_skeleton: z
    .boolean()
    .default(true)
    .describe("Also build a pose-skeleton visual wired to the tracked body so you see it working."),
});
type SetupBodyTrackingArgs = z.infer<typeof setupBodyTrackingSchema>;

interface LoadReport {
  error?: "tox_missing" | "parent_missing" | "pose_chop_not_found";
  loaded?: string;
  pose_chop?: string;
  chans?: string[];
  samples?: number;
}

/**
 * Python (runs in TD): load pose_tracking.tox into the parent, then locate the landmarks CHOP by a
 * version-robust heuristic (≥33 samples + ≥2 channels, preferring position-like channel names and
 * pose/landmark/select op names). Validated live against a synthetic tox.
 */
function loadAndFindScript(toxPath: string, parentPath: string): string {
  return [
    "import json, os",
    `TOX = ${q(toxPath)}`,
    `PARENT = ${q(parentPath)}`,
    "report = {}",
    "root = op(PARENT)",
    "if not os.path.exists(TOX):",
    "    report['error'] = 'tox_missing'",
    "elif root is None:",
    "    report['error'] = 'parent_missing'",
    "else:",
    "    loaded = root.op('mediapipe_pose') or root.loadTox(TOX)",
    "    try:",
    "        loaded.name = 'mediapipe_pose'",
    "    except Exception:",
    "        pass",
    "    best = None",
    "    for c in loaded.findChildren(type=CHOP):",
    "        if c.numSamples >= 33 and c.numChans >= 2:",
    "            chans = [ch.name for ch in c.chans()]",
    "            score = 2 if any(n in ('tx', 'x', 'tx0') for n in chans) else 0",
    "            nm = c.name.lower()",
    "            if any(k in nm for k in ('pose', 'landmark', 'select', 'null', 'world', 'out')):",
    "                score += 1",
    "            if best is None or score > best[0]:",
    "                best = (score, c, chans)",
    "    if best is None:",
    "        report['error'] = 'pose_chop_not_found'",
    "        report['loaded'] = loaded.path",
    "    else:",
    "        report['loaded'] = loaded.path",
    "        report['pose_chop'] = best[1].path",
    "        report['chans'] = best[2]",
    "        report['samples'] = best[1].numSamples",
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
  const toxPath = args.tox_path ?? defaultPoseToxPath();

  // 1. Load the plugin and find its pose-landmarks CHOP.
  let report: LoadReport;
  try {
    const exec = await ctx.client.executePythonScript(
      loadAndFindScript(toxPath, args.parent_path),
      true,
    );
    report = parsePythonReport<LoadReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.error === "tox_missing") {
    return errorResult(
      `MediaPipe plugin not found at ${toxPath}. Install it first by running 'tdmcp install-mediapipe' in a terminal (it downloads the free, MIT-licensed torinmb/mediapipe-touchdesigner plugin), or pass tox_path to an existing pose_tracking.tox.`,
    );
  }
  if (report.error === "parent_missing") {
    return errorResult(`Parent COMP not found: ${args.parent_path}.`);
  }
  if (report.error === "pose_chop_not_found" || !report.pose_chop) {
    return errorResult(
      `Loaded the plugin (${report.loaded ?? "?"}) but couldn't find a pose-landmarks CHOP (≥33 samples) inside it. Open the 'mediapipe_pose' component, select your webcam and enable Pose, then re-run — or pass an existing pose CHOP to create_pose_tracking with source='mediapipe'.`,
    );
  }

  // 2. Build pose tracking wired to the plugin's landmarks CHOP.
  const tracking = await createPoseTrackingImpl(ctx, {
    source: "mediapipe",
    mediapipe_chop_path: report.pose_chop,
    osc_port: 7000,
    smoothing: 0.08,
    mirror: false,
    expose_controls: true,
    parent_path: args.parent_path,
  });
  if (tracking.isError) return tracking;
  const trackingData = extractJson(tracking);
  const posePath =
    (trackingData.pose_path as string | undefined) ?? (trackingData.output as string | undefined);

  // 3. Optionally build a skeleton visual on top of the tracked pose.
  let skeleton: CallToolResult | undefined;
  if (args.build_skeleton && posePath) {
    skeleton = await createPoseSkeletonImpl(ctx, {
      source: "existing_chop",
      existing_chop_path: posePath,
      osc_port: 7000,
      line_color: "#33ffe6",
      line_width: 3,
      camera_distance: 4.6,
      expose_controls: true,
      parent_path: args.parent_path,
    });
  }
  const skeletonData = skeleton ? extractJson(skeleton) : {};

  const summary = {
    plugin_loaded: report.loaded,
    pose_landmarks_chop: report.pose_chop,
    landmark_channels: report.chans,
    pose_tracking: trackingData.container ?? trackingData.pose_path,
    pose_chop: posePath,
    skeleton: args.build_skeleton
      ? (skeletonData.output ?? "(skeleton build failed)")
      : "(skipped)",
  };

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text:
        `Body tracking is set up. Loaded the MediaPipe plugin → ${report.loaded}, wired pose tracking to its landmarks CHOP (${report.pose_chop}), ` +
        `${args.build_skeleton ? "and built a live skeleton" : "ready for visuals"}.\n\n` +
        "Next, in TouchDesigner: open the 'mediapipe_pose' component, pick your webcam from the dropdown, and enable Pose.\n" +
        "⚠ macOS will ask for camera permission the first time — click Allow (until you do, TouchDesigner can look frozen).\n\n" +
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
        "One-shot body tracking from a webcam: loads the free torinmb/mediapipe-touchdesigner plugin (install it first with the `tdmcp install-mediapipe` CLI) into your project, finds its pose-landmarks CHOP, and wires up create_pose_tracking (+ a live skeleton) so you only need to pick your webcam and enable Pose. If the plugin isn't installed yet, it tells you how. Loading the plugin will prompt for camera permission on macOS (click Allow).",
      inputSchema: setupBodyTrackingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupBodyTrackingImpl(ctx, args),
  );
};
