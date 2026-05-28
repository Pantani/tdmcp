import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = "torinmb/mediapipe-touchdesigner";

export interface InstallMediapipeOptions {
  dir: string;
  version: string;
}

/** Parses `[--dir <path>] [--version <tag>|latest]`. Defaults: ~/tdmcp-mediapipe, latest. */
export function parseInstallArgs(args: string[]): InstallMediapipeOptions {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    dir: flag("--dir") ?? join(homedir(), "tdmcp-mediapipe"),
    version: flag("--version") ?? "latest",
  };
}

interface GithubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Resolves the `release.zip` download URL for a version of the MediaPipe plugin via the GitHub
 * releases API. `version` is "latest" or a tag like "v0.5.2". The plugin is MIT-licensed, so we
 * fetch the artist's own copy from the official source rather than bundling/redistributing it.
 */
export async function resolveReleaseZip(version: string): Promise<{ tag: string; url: string }> {
  const api =
    version === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
  const res = await fetch(api, {
    headers: { "User-Agent": "tdmcp", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} for ${api}. Check the version, or download manually from https://github.com/${REPO}/releases`,
    );
  }
  const data = (await res.json()) as GithubRelease;
  const asset = data.assets.find((a) => a.name.toLowerCase().endsWith(".zip")) ?? data.assets[0];
  if (!asset) {
    throw new Error(
      `No downloadable .zip asset found in release ${data.tag_name}. Download manually from https://github.com/${REPO}/releases`,
    );
  }
  return { tag: data.tag_name, url: asset.browser_download_url };
}

/** Streams a URL to a file (no full-buffering — the release is ~170 MB). */
export async function downloadTo(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "tdmcp" } });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
}

/** Extracts a .zip with the OS's built-in tool — `unzip` on macOS/Linux, Expand-Archive on Windows — so no Node unzip dependency is needed. */
export function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

/**
 * `tdmcp install-mediapipe [--dir <path>] [--version <tag>]`
 *
 * Downloads the free, MIT-licensed torinmb/mediapipe-touchdesigner plugin (the GPU MediaPipe
 * face/hand/pose tracker, Mac + PC) from its official GitHub release and extracts it to a stable
 * folder, then prints how to use it. The companion `setup_body_tracking` tool can load it straight
 * into an open project and wire up pose tracking.
 */
export async function runInstallMediapipe(args: string[]): Promise<void> {
  const { dir, version } = parseInstallArgs(args);
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "release.zip");

  try {
    console.log(`[tdmcp] Resolving MediaPipe plugin release (${version})…`);
    const { tag, url } = await resolveReleaseZip(version);
    console.log(`[tdmcp] Downloading ${tag} (~170 MB) → ${zipPath}`);
    await downloadTo(url, zipPath);
    console.log("[tdmcp] Extracting…");
    extractZip(zipPath, dir);
    rmSync(zipPath, { force: true });

    console.log(
      [
        "",
        "  MediaPipe TouchDesigner plugin installed.",
        `  Folder:  ${dir}`,
        "",
        "  Use it one of two ways:",
        "",
        "  • Let the assistant wire it up: with TouchDesigner open, ask",
        '    "set up body tracking" (the setup_body_tracking tool loads the .tox',
        "    into your project and connects create_pose_tracking to it).",
        "",
        "  • By hand: open `MediaPipe TouchDesigner.toe`, or drag a .tox from the",
        "    `toxes/` folder into your project, and enable Pose tracking.",
        "",
        "  ⚠ macOS: the first time it reads the webcam, click Allow on the camera",
        "    permission dialog — until you do, TouchDesigner can look frozen.",
        "",
      ].join("\n"),
    );
  } catch (err) {
    if (existsSync(zipPath)) rmSync(zipPath, { force: true });
    console.error(
      `[tdmcp] install-mediapipe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
