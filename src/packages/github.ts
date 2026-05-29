import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PackageDownloadPlan, PackageManifest } from "./types.js";

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  zipball_url: string;
  assets?: GithubReleaseAsset[];
}

function refKind(ref: string): "heads" | "tags" {
  if (/^(v?\d+\.\d+|release[-/]|tags\/)/i.test(ref)) return "tags";
  return "heads";
}

function trimRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "").replace(/^tags\//, "");
}

export function createGithubDownloadPlan(pkg: PackageManifest, pin?: string): PackageDownloadPlan {
  if (pkg.source.type !== "github" || !pkg.source.repo) {
    throw new Error(`${pkg.id} does not have a GitHub source archive.`);
  }
  const ref = trimRef(pin ?? pkg.source.defaultRef);
  const kind = refKind(ref);
  const safeRef = encodeURIComponent(ref).replace(/%2F/g, "/");
  return {
    ref,
    archiveName: `${pkg.id}-${ref.replace(/[^a-zA-Z0-9._-]+/g, "-")}.zip`,
    kind: "zip",
    strategy: "github-archive",
    url: `https://github.com/${pkg.source.repo}/archive/refs/${kind}/${safeRef}.zip`,
  };
}

export async function resolveGithubReleaseDownloadPlan(
  pkg: PackageManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<PackageDownloadPlan | undefined> {
  if (pkg.source.type !== "github" || !pkg.source.repo) return undefined;
  const response = await fetchImpl(
    `https://api.github.com/repos/${pkg.source.repo}/releases/latest`,
    {
      headers: {
        "User-Agent": "tdmcp",
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) return undefined;
  const release = (await response.json()) as GithubRelease;
  const pattern = pkg.installStrategy.releaseAssetPattern
    ? new RegExp(pkg.installStrategy.releaseAssetPattern, "i")
    : undefined;
  const assets = release.assets ?? [];
  const zipAsset =
    assets.find(
      (asset) => pattern?.test(asset.name) && asset.name.toLowerCase().endsWith(".zip"),
    ) ?? assets.find((asset) => asset.name.toLowerCase().endsWith(".zip"));
  if (zipAsset) {
    return {
      ref: release.tag_name,
      archiveName: zipAsset.name,
      kind: "zip",
      strategy: "github-release-asset",
      url: zipAsset.browser_download_url,
    };
  }
  const toxAsset =
    assets.find(
      (asset) => pattern?.test(asset.name) && asset.name.toLowerCase().endsWith(".tox"),
    ) ?? assets.find((asset) => asset.name.toLowerCase().endsWith(".tox"));
  if (toxAsset) {
    return {
      ref: release.tag_name,
      archiveName: toxAsset.name,
      kind: "file",
      strategy: "github-release-asset",
      url: toxAsset.browser_download_url,
    };
  }
  if (release.zipball_url) {
    return {
      ref: release.tag_name,
      archiveName: `${pkg.id}-${release.tag_name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.zip`,
      kind: "zip",
      strategy: "github-release-asset",
      url: release.zipball_url,
    };
  }
  return undefined;
}

export async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "tdmcp" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
}
