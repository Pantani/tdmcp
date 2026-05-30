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

// Package downloads only ever come from GitHub. Archive URLs 302 to
// codeload.github.com and release assets to *.githubusercontent.com, so we pin
// every hop — including redirect targets — to this allowlist. A compromised or
// misconfigured endpoint that tries to bounce the download to an arbitrary host
// (SSRF / internal-network probe) is refused before a single byte is read.
const ALLOWED_DOWNLOAD_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  // GitHub serves release assets and zipballs from rotating subdomains of
  // githubusercontent.com (objects., release-assets., …). The suffix match below
  // accepts any of them while still rejecting every non-GitHub host.
  "githubusercontent.com",
];

// Hard ceiling on a single package download. The largest real packages are a few
// hundred MB; 1 GB is comfortably above that and still bounds a malicious or
// runaway response that would otherwise fill the disk.
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

// Abort a stalled download instead of hanging the install forever.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

function isAllowedDownloadHost(host: string): boolean {
  const lower = host.toLowerCase();
  return ALLOWED_DOWNLOAD_HOSTS.some(
    (allowed) => lower === allowed || lower.endsWith(`.${allowed}`),
  );
}

function assertAllowedDownloadUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing download from malformed URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS download URL: ${rawUrl}`);
  }
  if (!isAllowedDownloadHost(parsed.hostname)) {
    throw new Error(
      `Refusing download from non-GitHub host '${parsed.hostname}'. Allowed: ${ALLOWED_DOWNLOAD_HOSTS.join(", ")}.`,
    );
  }
  return parsed;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function downloadToFile(
  url: string,
  filePath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  // Validate the initial URL, then follow redirects by hand so every hop is
  // re-checked against the host allowlist (fetch's automatic redirect would
  // silently follow a Location to anywhere).
  let current = assertAllowedDownloadUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response | undefined;
    for (let hop = 0; hop < 10; hop++) {
      res = await fetchImpl(current.toString(), {
        headers: { "User-Agent": "tdmcp" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect with no Location for ${current.toString()}`);
        current = assertAllowedDownloadUrl(new URL(location, current).toString());
        continue;
      }
      break;
    }
    if (!res) throw new Error(`Download failed (no response) for ${url}`);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);

    // Reject oversize responses up front when the server declares a length…
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Download exceeds size limit (${declared} > ${maxBytes} bytes) for ${url}`);
    }

    // …and enforce the cap while streaming, in case content-length is absent or lies.
    let received = 0;
    const limit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controllerTs) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          controllerTs.error(
            new Error(`Download exceeds size limit (> ${maxBytes} bytes) for ${url}`),
          );
          return;
        }
        controllerTs.enqueue(chunk);
      },
    });
    const limited = res.body.pipeThrough(limit);
    await pipeline(
      Readable.fromWeb(limited as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(filePath),
    );
  } finally {
    clearTimeout(timer);
  }
}
