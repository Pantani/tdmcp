import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createPackagePaths } from "../../packages/paths.js";
import { readPackageState } from "../../packages/state.js";

/**
 * Shared path resolver for the torinmb mediapipe-touchdesigner ENGINE .tox.
 * Used by setupBodyTracking, setupHandTracking, setupFaceTracking, setupSegmentation,
 * and setupMediapipePlugin so all modalities look for the engine in the same order.
 *
 * Resolution order:
 *  1. Package state staged by `tdmcp install mediapipe-touchdesigner`
 *  2. Legacy ~/tdmcp-packages path (pre-package-manager installs)
 *  3. ~/Documents/Derivative/COMP/mediapipe.tox (manual drag-drop)
 *  4. ~/Documents/touchdesigner/mediapipe-touchdesigner/release/toxes/MediaPipe.tox
 */
export function legacyEngineToxPath(): string {
  return join(
    homedir(),
    "tdmcp-packages",
    "mediapipe-touchdesigner",
    "release",
    "toxes",
    "MediaPipe.tox",
  );
}

export function engineToxCandidatePaths(): string[] {
  return [
    legacyEngineToxPath(),
    join(homedir(), "Documents", "Derivative", "COMP", "mediapipe.tox"),
    join(
      homedir(),
      "Documents",
      "touchdesigner",
      "mediapipe-touchdesigner",
      "release",
      "toxes",
      "MediaPipe.tox",
    ),
  ];
}

/** Finds the engine .tox staged by `tdmcp install mediapipe-touchdesigner`. */
export function defaultEngineToxPath(): string {
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
