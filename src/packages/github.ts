import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PackageDownloadPlan, PackageManifest } from "./types.js";

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
    strategy: "github-archive",
    url: `https://github.com/${pkg.source.repo}/archive/refs/${kind}/${safeRef}.zip`,
  };
}

export async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "tdmcp" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
}
