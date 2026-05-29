import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { PackageArtifact } from "./types.js";

const assetExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".mp4",
  ".mov",
  ".wav",
  ".aif",
  ".aiff",
  ".json",
]);

function kindFor(path: string): PackageArtifact["kind"] {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if (ext === ".tox") return "tox";
  if (ext === ".toe") return "toe";
  if (ext === ".td") return "td";
  if (ext === ".py") return "python";
  if (lower.endsWith("readme.md") || ext === ".md" || ext === ".txt") return "doc";
  if (assetExtensions.has(ext)) return "asset";
  return "other";
}

function walk(root: string, dir: string, out: PackageArtifact[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") {
      continue;
    }
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = statSync(absolutePath);
    const kind = kindFor(entry.name);
    out.push({
      kind,
      absolutePath,
      relativePath: relative(root, absolutePath),
      sizeBytes: stat.size,
      importable: kind === "tox",
    });
  }
}

export function scanPackageArtifacts(root: string): PackageArtifact[] {
  const out: PackageArtifact[] = [];
  walk(root, root, out);
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.relativePath.localeCompare(b.relativePath);
  });
}

export function chooseImportableArtifact(
  artifacts: PackageArtifact[],
): PackageArtifact | undefined {
  return artifacts.find((artifact) => artifact.kind === "tox" && artifact.importable);
}
