import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface InstallArgs {
  repo: string;
  version: string;
  asset?: string;
  dir?: string;
}

/** Parses `<owner/repo> [--version <tag>] [--asset <substring>] [--dir <path>]`. */
export function parseInstallArgs(args: string[]): InstallArgs {
  const VALUE_FLAGS = new Set(["--version", "--asset", "--dir"]);
  const flags: Record<string, string> = {};
  let repo = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (VALUE_FLAGS.has(a)) {
      flags[a] = args[i + 1] ?? "";
      i++;
    } else if (!a.startsWith("--") && !repo) {
      repo = a;
    }
  }
  return {
    repo: repo
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, ""),
    version: flags["--version"] ?? "latest",
    asset: flags["--asset"],
    dir: flags["--dir"],
  };
}

/** True for a valid GitHub `owner/repo` slug. */
export function isRepoSlug(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

interface GithubRelease {
  tag_name: string;
  zipball_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export interface ResolvedAsset {
  tag: string;
  name: string;
  url: string;
  kind: "zip" | "tox" | "other";
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "tdmcp",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function kindOf(name: string): ResolvedAsset["kind"] {
  const n = name.toLowerCase();
  if (n.endsWith(".tox")) return "tox";
  if (n.endsWith(".zip")) return "zip";
  return "other";
}

/**
 * Resolves which file to download for `<repo>` at `version` ("latest" or a tag). Picks the asset
 * matching `--asset`, else the sole asset, else a `.zip`/`.tox` asset; if a release has no assets it
 * falls back to GitHub's source zipball (so any tagged repo can be fetched, go-get style).
 */
export async function resolveAsset(
  repo: string,
  version: string,
  assetFilter?: string,
): Promise<ResolvedAsset> {
  const api =
    version === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  const res = await fetch(api, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} for ${api}. Check the repo/version, or that it has a release: https://github.com/${repo}/releases`,
    );
  }
  const data = (await res.json()) as GithubRelease;
  let assets = data.assets ?? [];
  if (assetFilter) {
    const f = assetFilter.toLowerCase();
    assets = assets.filter((a) => a.name.toLowerCase().includes(f));
    if (assets.length === 0) {
      const names = (data.assets ?? []).map((a) => a.name).join(", ") || "(none)";
      throw new Error(`No release asset matching '${assetFilter}'. Available: ${names}`);
    }
  }
  if (assets.length === 0) {
    // No release assets at all → fetch the source at this tag.
    const repoName = repo.split("/")[1] ?? repo;
    return {
      tag: data.tag_name,
      name: `${repoName}-${data.tag_name}.zip`,
      url: data.zipball_url,
      kind: "zip",
    };
  }
  let chosen = assets[0];
  if (assets.length > 1) {
    const picked =
      assets.find((a) => kindOf(a.name) === "zip") ?? assets.find((a) => kindOf(a.name) === "tox");
    if (!picked) {
      throw new Error(
        `Release ${data.tag_name} has multiple assets — pass --asset <substring>. Available: ${assets.map((a) => a.name).join(", ")}`,
      );
    }
    chosen = picked;
  }
  if (!chosen) throw new Error(`No downloadable asset found in release ${data.tag_name}.`);
  return {
    tag: data.tag_name,
    name: chosen.name,
    url: chosen.browser_download_url,
    kind: kindOf(chosen.name),
  };
}

/** Streams a URL to a file (assets can be hundreds of MB, so don't buffer in memory). */
export async function downloadTo(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "tdmcp" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
}

/** Extracts a .zip with the OS's built-in tool — `unzip` on macOS/Linux, Expand-Archive on Windows. */
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
 * `tdmcp install <owner/repo> [--version <tag>] [--asset <substring>] [--dir <path>]`
 *
 * Fetches a release from any GitHub repo (go-get style) and lands it under
 * `~/tdmcp-packages/<repo>` — for installing TouchDesigner plugins/components like the free
 * MediaPipe tracker: `tdmcp install torinmb/mediapipe-touchdesigner`.
 */
export async function runInstall(args: string[]): Promise<void> {
  const { repo, version, asset, dir } = parseInstallArgs(args);
  if (!isRepoSlug(repo)) {
    console.error(
      "Usage: tdmcp install <owner/repo> [--version <tag>] [--asset <substring>] [--dir <path>]\n" +
        "  e.g. tdmcp install torinmb/mediapipe-touchdesigner",
    );
    process.exitCode = 1;
    return;
  }
  const repoName = repo.split("/")[1] as string;
  const targetDir = dir ?? join(homedir(), "tdmcp-packages", repoName);
  mkdirSync(targetDir, { recursive: true });

  try {
    console.log(`[tdmcp] Resolving ${repo} (${version})…`);
    const { tag, name, url, kind } = await resolveAsset(repo, version, asset);
    const filePath = join(targetDir, name);
    console.log(`[tdmcp] Downloading ${tag} — ${name} → ${filePath}`);
    await downloadTo(url, filePath);
    if (kind === "zip") {
      console.log("[tdmcp] Extracting…");
      extractZip(filePath, targetDir);
      rmSync(filePath, { force: true });
    }

    const lines = ["", `  Installed ${repo} (${tag}).`, `  Folder:  ${targetDir}`, ""];
    if (repo.toLowerCase().includes("mediapipe-touchdesigner")) {
      lines.push(
        "  This is the MediaPipe tracker. With TouchDesigner open, ask the assistant",
        '  "set up body tracking" to load it and wire up pose tracking automatically.',
        "",
        "  ⚠ macOS: it will ask for camera permission the first time — click Allow.",
        "",
      );
    } else {
      lines.push(
        "  Open the .toe, or drag a .tox from the folder into your TouchDesigner project.",
        "",
      );
    }
    console.log(lines.join("\n"));
  } catch (err) {
    console.error(`[tdmcp] install failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
