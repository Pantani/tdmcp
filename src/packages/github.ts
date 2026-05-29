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

function isZipAsset(asset: GithubReleaseAsset): boolean {
  return asset.name.toLowerCase().endsWith(".zip");
}

function isToxAsset(asset: GithubReleaseAsset): boolean {
  return asset.name.toLowerCase().endsWith(".tox");
}

function filterAssetsByName(
  assets: GithubReleaseAsset[],
  assetFilter?: string,
): GithubReleaseAsset[] {
  if (!assetFilter) return assets;
  const needle = assetFilter.toLowerCase();
  const filtered = assets.filter((asset) => asset.name.toLowerCase().includes(needle));
  if (filtered.length === 0) {
    const available = assets.map((asset) => asset.name).join(", ") || "(none)";
    throw new Error(`No release asset matching '${assetFilter}'. Available: ${available}`);
  }
  return filtered;
}

function findPreferredAsset(
  assets: GithubReleaseAsset[],
  predicate: (asset: GithubReleaseAsset) => boolean,
  pattern?: RegExp,
): GithubReleaseAsset | undefined {
  return (
    assets.find((asset) => pattern?.test(asset.name) && predicate(asset)) ?? assets.find(predicate)
  );
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
  assetFilter?: string,
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
  if (!response.ok) {
    if (assetFilter) {
      throw new Error(
        `GitHub API returned ${response.status} while resolving release asset '${assetFilter}'.`,
      );
    }
    return undefined;
  }
  const release = (await response.json()) as GithubRelease;
  const pattern = pkg.installStrategy.releaseAssetPattern
    ? new RegExp(pkg.installStrategy.releaseAssetPattern, "i")
    : undefined;
  const assets = filterAssetsByName(release.assets ?? [], assetFilter);
  const zipAsset = findPreferredAsset(assets, isZipAsset, pattern);
  if (zipAsset) {
    return {
      ref: release.tag_name,
      archiveName: zipAsset.name,
      kind: "zip",
      strategy: "github-release-asset",
      url: zipAsset.browser_download_url,
    };
  }
  const toxAsset = findPreferredAsset(assets, isToxAsset, pattern);
  if (toxAsset) {
    return {
      ref: release.tag_name,
      archiveName: toxAsset.name,
      kind: "file",
      strategy: "github-release-asset",
      url: toxAsset.browser_download_url,
    };
  }
  if (assetFilter) {
    const available = assets.map((asset) => asset.name).join(", ") || "(none)";
    throw new Error(
      `No downloadable .zip or .tox release asset matching '${assetFilter}'. Available: ${available}`,
    );
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
